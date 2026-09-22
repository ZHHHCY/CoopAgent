import { APP_ROOT, applicationRoot, workspaceRoot, projectIdentity } from './project-context.mjs';
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import { DOMParser } from "@xmldom/xmldom";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { catalogClassBase, requireCanonicalEditPath, ordinalEditSupport } from "./catalog-edit-contract.mjs";
import { inspectMasteryPoint, masteryPointSelector, writeMasteryPoint } from './mastery-point-editor.mjs';
import { validatePrestigeContract } from './prestige-contract.mjs';
import {
  assertGameAReadable, commitGameATransaction, recoverGameATransactionLocked, withGameALock,
} from "./game-a-transaction.mjs";

const MISSING = Symbol("missing");
const XML_HEADER = '<?xml version="1.0" encoding="utf-8"?>';

export class PatchPlanError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "PatchPlanError";
    this.details = details;
  }
}

function sha256(textOrBuffer) {
  return createHash("sha256").update(textOrBuffer).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function exists(target) {
  try {
    await access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function parseXml(text, label) {
  const errors = [];
  let document;
  try {
    document = new DOMParser({
      onError(level, message) {
        if (level !== "warning") errors.push(`${level}: ${message}`);
      },
    }).parseFromString(text, "application/xml");
  } catch (error) {
    throw new PatchPlanError(`Invalid XML in ${label}: ${error.message}`);
  }
  if (errors.length > 0 || !document?.documentElement) {
    throw new PatchPlanError(`Invalid XML in ${label}`, errors);
  }
  return document;
}

function elementChildren(node) {
  const children = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) children.push(child);
  }
  return children;
}

function findDirectChild(parent, name, index = undefined) {
  const children = elementChildren(parent).filter(child => child.tagName === name);
  if (index === undefined) return children[0];
  const explicit = children.find(child => child.getAttribute("index") === String(index));
  if (explicit) return explicit;
  // Unindexed siblings are ordinal entries, not entries whose index is an ID.
  if (/^(0|[1-9][0-9]*)$/.test(String(index))) {
    return children.filter(child => !child.hasAttribute("index"))[Number(index)];
  }
  return undefined;
}

function directChildCandidates(parent, name, index = undefined) {
  const children = elementChildren(parent).filter(child => child.tagName === name);
  if (index === undefined) return children.slice(0, 1);
  const explicit = children.find(child => child.getAttribute("index") === String(index));
  if (!/^(0|[1-9][0-9]*)$/.test(String(index))) return explicit ? [explicit] : [];
  const implicit = children.filter(child => !child.hasAttribute("index"))[Number(index)];
  return [...new Set([explicit, implicit].filter(Boolean))];
}

function findCatalogObject(document, objectId) {
  return elementChildren(document.documentElement).find(
    (element) => element.hasAttribute("id") && element.getAttribute("id") === objectId,
  );
}

function findCatalogDefault(document, className) {
  if (!document || !className) return null;
  return elementChildren(document.documentElement).find(
    (element) => element.tagName === className && element.getAttribute("default") === "1",
  ) ?? null;
}

function findPathElement(object, segments) {
  if (!object) return { found: false, removed: false, element: null };
  let current = object;
  for (const segment of segments) {
    if (segment.attribute) {
      return { found: current.hasAttribute(segment.attribute), removed: false, element: current };
    }
    current = findDirectChild(current, segment.name, segment.index);
    if (!current) return { found: false, removed: false, element: null };
    if (current.getAttribute("removed") === "1") {
      return { found: true, removed: true, element: current };
    }
  }
  return { found: true, removed: false, element: current };
}

function resolvePathElement(document, object, segments, visited = new Set()) {
  if (!object) return { found: false, removed: false, element: null };
  const direct = findPathElement(object, segments);
  if (direct.found) return direct;
  const parentId = object.getAttribute("parent");
  if (parentId && !visited.has(`id:${parentId}`)) {
    visited.add(`id:${parentId}`);
    const inherited = resolvePathElement(document, findCatalogObject(document, parentId), segments, visited);
    if (inherited.found) return inherited;
  }
  const defaultKey = `default:${object.tagName}`;
  if (object.getAttribute("default") !== "1" && !visited.has(defaultKey)) {
    visited.add(defaultKey);
    const defaults = resolvePathElement(document, findCatalogDefault(document, object.tagName), segments, visited);
    if (defaults.found) return defaults;
  }
  const baseClass = catalogClassBase(object.tagName);
  if (baseClass && !visited.has(`class:${baseClass}`)) {
    visited.add(`class:${baseClass}`);
    return resolvePathElement(document, findCatalogDefault(document, baseClass), segments, visited);
  }
  return direct;
}

function valueFromElementState(state, attribute = null) {
  if (!state.found || state.removed || !state.element) return MISSING;
  if (attribute) {
    return state.element.hasAttribute(attribute) ? state.element.getAttribute(attribute) : MISSING;
  }
  if (state.element.hasAttribute("value")) return state.element.getAttribute("value");
  return true;
}

function parseCatalogPath(value) {
  const segments = value.split(".");
  if (segments.length === 0) throw new PatchPlanError(`Invalid Catalog path: ${value}`);

  return segments.map((segment, index) => {
    if (segment.startsWith("@")) {
      if (index !== segments.length - 1 || !/^@[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
        throw new PatchPlanError(`Catalog attributes must be the final path segment: ${value}`);
      }
      return { attribute: segment.slice(1) };
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[([^\]\r\n]+)\])?$/.exec(segment);
    if (!match) throw new PatchPlanError(`Invalid Catalog path segment '${segment}' in ${value}`);
    return { name: match[1], index: match[2] };
  });
}

function readPathFromObject(object, segments) {
  if (!object) return MISSING;
  const read = (current, position) => {
    if (position >= segments.length) {
      return current.hasAttribute("value") ? current.getAttribute("value") : true;
    }
    const segment = segments[position];
    if (segment.attribute) {
      return current.hasAttribute(segment.attribute)
        ? current.getAttribute(segment.attribute)
        : MISSING;
    }
    if (position === segments.length - 1 && segment.index === undefined && current.hasAttribute(segment.name)) {
      return current.getAttribute(segment.name);
    }
    // An explicit indexed struct is a partial override of the corresponding
    // unindexed positional record. Prefer its member, then inherit a member it
    // did not author from that record.
    for (const child of directChildCandidates(current, segment.name, segment.index)) {
      if (child.getAttribute("removed") === "1") return MISSING;
      const value = read(child, position + 1);
      if (value !== MISSING) return value;
    }
    return MISSING;
  };
  return read(object, 0);
}

function inspectSelectorLayout(document, object, segments, fieldPath, engineVerified, visited = new Set()) {
  if (!object || visited.has(object)) return { supported: true, reason: null };
  visited.add(object);
  let current = object;
  for (const segment of segments) {
    if (segment.attribute) break;
    const children = elementChildren(current).filter(child => child.tagName === segment.name);
    const next = findDirectChild(current, segment.name, segment.index);
    if (segment.index !== undefined && !children.some(child => child.getAttribute('index') === segment.index)) {
      const identityKey = ['Id', 'id'].find(key => children.some(child => !child.hasAttribute('index') && child.hasAttribute(key)));
      if (next || identityKey) {
        const layout = ordinalEditSupport(object.tagName, fieldPath, { identityKey, engineVerified });
        if (!layout.supported) return layout;
      }
    }
    if (!next) break;
    current = next;
  }
  const parent = object.getAttribute('parent');
  for (const inherited of [parent && document ? findCatalogObject(document, parent) : null,
    findCatalogDefault(document, object.tagName), findCatalogDefault(document, catalogClassBase(object.tagName))]) {
    const result = inspectSelectorLayout(document, inherited, segments, fieldPath, engineVerified, visited);
    if (!result.supported) return result;
  }
  return { supported: true, reason: null };
}

function assertCatalogWriteSupported(inspected, operation) {
  if (inspected.writeSupport?.supported === false) {
    const error = new PatchPlanError(`${operation.opId ?? 'field'}: ${inspected.writeSupport.message}`);
    error.code = inspected.writeSupport.reason;
    throw error;
  }
}

function readInheritedPath(document, object, segments, visited = new Set()) {
  if (!object) return MISSING;
  const value = readPathFromObject(object, segments);
  if (value !== MISSING) return value;

  const parentId = object.getAttribute("parent");
  if (parentId && !visited.has(`id:${parentId}`)) {
    visited.add(`id:${parentId}`);
    const inherited = readInheritedPath(document, findCatalogObject(document, parentId), segments, visited);
    if (inherited !== MISSING) return inherited;
  }
  const defaultKey = `default:${object.tagName}`;
  if (object.getAttribute("default") !== "1" && !visited.has(defaultKey)) {
    visited.add(defaultKey);
    const defaults = readInheritedPath(document, findCatalogDefault(document, object.tagName), segments, visited);
    if (defaults !== MISSING) return defaults;
  }
  const baseClass = catalogClassBase(object.tagName);
  if (baseClass && !visited.has(`class:${baseClass}`)) {
    visited.add(`class:${baseClass}`);
    return readInheritedPath(document, findCatalogDefault(document, baseClass), segments, visited);
  }
  return MISSING;
}

function collectIndexedChildren(document, object, containerSegments, fieldName, result = new Map(), visited = new Set()) {
  if (!object) return result;
  const defaultKey = `default:${object.tagName}`;
  if (object.getAttribute("default") !== "1" && !visited.has(defaultKey)) {
    visited.add(defaultKey);
    collectIndexedChildren(
      document,
      findCatalogDefault(document, object.tagName),
      containerSegments,
      fieldName,
      result,
      visited,
    );
  }
  const parentId = object.getAttribute("parent");
  if (parentId && !visited.has(`id:${parentId}`)) {
    visited.add(`id:${parentId}`);
    collectIndexedChildren(
      document,
      findCatalogObject(document, parentId),
      containerSegments,
      fieldName,
      result,
      visited,
    );
  }
  const container = containerSegments.length === 0
    ? object
    : findPathElement(object, containerSegments).element;
  if (!container) return result;
  for (const child of elementChildren(container)) {
    if (child.tagName !== fieldName || !child.hasAttribute("index")) continue;
    const index = child.getAttribute("index");
    if (child.getAttribute("removed") === "1") result.delete(index);
    else result.set(index, child);
  }
  return result;
}

function ensurePathOnObject(document, object, segments) {
  let current = object;
  for (const [position, segment] of segments.entries()) {
    if (segment.attribute) return { element: current, attribute: segment.attribute };
    if (position === segments.length - 1 && segment.index === undefined && current.hasAttribute(segment.name)) {
      return { element: current, attribute: segment.name };
    }
    let next = findDirectChild(current, segment.name, segment.index);
    if (!next) {
      next = document.createElement(segment.name);
      if (segment.index !== undefined) next.setAttribute("index", String(segment.index));
      current.appendChild(next);
    }
    current = next;
  }
  return { element: current, attribute: null };
}

function serializeScalar(value) {
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
}

function scalarEquals(actual, expected) {
  if (actual === MISSING) return expected === null;
  if (expected === null) return false;
  if (typeof expected === "number") {
    return actual !== "" && Number.isFinite(Number(actual)) && Number(actual) === expected;
  }
  if (typeof expected === "boolean") {
    return expected ? actual === true || actual === "1" || actual === "true" : actual === false || actual === "0" || actual === "false";
  }
  return String(actual) === String(expected);
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function serializeElement(element, depth = 0) {
  const indent = "    ".repeat(depth);
  const attributes = [];
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    attributes.push(`${attribute.name}="${xmlEscape(attribute.value)}"`);
  }
  const opening = attributes.length > 0 ? `<${element.tagName} ${attributes.join(" ")}` : `<${element.tagName}`;
  const meaningful = [];
  for (let child = element.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 || child.nodeType === 8 || (child.nodeType === 3 && child.data.trim() !== "")) {
      meaningful.push(child);
    }
  }
  if (meaningful.length === 0) return `${indent}${opening}/>`;

  if (meaningful.every((child) => child.nodeType === 3)) {
    const text = meaningful.map((child) => xmlEscape(child.data)).join("");
    return `${indent}${opening}>${text}</${element.tagName}>`;
  }

  const lines = [`${indent}${opening}>`];
  for (const child of meaningful) {
    if (child.nodeType === 1) lines.push(serializeElement(child, depth + 1));
    else if (child.nodeType === 8) lines.push(`${"    ".repeat(depth + 1)}<!--${child.data}-->`);
    else lines.push(`${"    ".repeat(depth + 1)}${xmlEscape(child.data)}`);
  }
  lines.push(`${indent}</${element.tagName}>`);
  return lines.join("\n");
}

function serializeXmlDocument(document) {
  return `${XML_HEADER}\n${serializeElement(document.documentElement)}\n`;
}

function catalogFileName(catalog) {
  return `${catalog}Data.xml`;
}

async function findCaseInsensitiveFile(directory, fileName) {
  if (!(await exists(directory))) return null;
  const entries = await readdir(directory, { withFileTypes: true });
  const match = entries.find(
    (entry) => entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase(),
  );
  return match ? path.join(directory, match.name) : null;
}

class CatalogSource {
  constructor(root = null, databaseFile = null) {
    this.root = root ? path.resolve(root) : null;
    this.documents = new Map();
    this.engineFields = new Map();
    if (databaseFile && existsSync(databaseFile)) {
      const db = new DatabaseSync(databaseFile, { readOnly: true });
      try {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='engine_resolved_fields'").get()) {
          for (const row of db.prepare("SELECT catalog,object_id,path,value FROM engine_resolved_fields WHERE source_file LIKE 'engine:%'").all()) {
            this.engineFields.set(`${row.catalog}/${row.object_id}/${row.path.replaceAll('.@', '.')}`.toLowerCase(), { value: row.value });
          }
        }
      } finally { db.close(); }
    }
  }

  engineField(catalog, object, field) {
    return this.engineFields.get(`${catalog}/${object}/${field.replaceAll('.@', '.')}`.toLowerCase());
  }

  async getDocument(catalog) {
    if (!this.root) return null;
    if (this.documents.has(catalog)) return this.documents.get(catalog);
    const file = await findCaseInsensitiveFile(this.root, catalogFileName(catalog));
    if (!file) {
      this.documents.set(catalog, null);
      return null;
    }
    const document = parseXml(await readFile(file, "utf8"), file);
    if (document.documentElement.tagName !== "Catalog") {
      throw new PatchPlanError(`Catalog database file does not have a Catalog root: ${file}`);
    }
    const value = { file, document };
    this.documents.set(catalog, value);
    return value;
  }

  async findObject(catalog, objectId) {
    const entry = await this.getDocument(catalog);
    if (!entry) return null;
    const object = findCatalogObject(entry.document, objectId);
    return object ? { ...entry, object } : null;
  }
}

async function findExternalParent(context, catalog, coreDocument, coreObject) {
  let current = coreObject;
  const visited = new Set();
  while (current?.getAttribute("parent")) {
    const parentId = current.getAttribute("parent");
    if (visited.has(parentId)) return null;
    visited.add(parentId);
    const localParent = coreDocument ? findCatalogObject(coreDocument, parentId) : null;
    if (localParent) current = localParent;
    else return context.catalogSource.findObject(catalog, parentId);
  }
  return null;
}

async function loadCoreCatalog(coreRoot, catalog, create = false) {
  const directory = path.join(coreRoot, "Base.SC2Data", "GameData");
  const expectedName = catalogFileName(catalog);
  const existing = await findCaseInsensitiveFile(directory, expectedName);
  if (!existing && !create) return null;

  const file = existing ?? path.join(directory, expectedName);
  const document = existing
    ? parseXml(await readFile(existing, "utf8"), existing)
    : parseXml(`${XML_HEADER}\n<Catalog/>\n`, file);
  if (document.documentElement.tagName !== "Catalog") {
    throw new PatchPlanError(`Core Catalog file does not have a Catalog root: ${file}`);
  }
  return { file, document, created: !existing };
}

async function ensureCatalogInclude(coreRoot, catalog, changedFiles) {
  const file = path.join(coreRoot, "Base.SC2Data", "GameData.xml");
  let document;
  if (await exists(file)) {
    document = parseXml(await readFile(file, "utf8"), file);
  } else {
    await mkdir(path.dirname(file), { recursive: true });
    document = parseXml(`${XML_HEADER}\n<Includes/>\n`, file);
  }
  if (document.documentElement.tagName !== "Includes") {
    throw new PatchPlanError(`GameData include file does not have an Includes root: ${file}`);
  }

  const includePath = `GameData/${catalogFileName(catalog)}`;
  const present = elementChildren(document.documentElement).some(
    (element) =>
      element.tagName === "Catalog" &&
      element.getAttribute("path").toLowerCase() === includePath.toLowerCase(),
  );
  if (present) return;

  const include = document.createElement("Catalog");
  include.setAttribute("path", includePath);
  document.documentElement.appendChild(include);
  await writeFile(file, serializeXmlDocument(document), "utf8");
  changedFiles.add(path.relative(coreRoot, file).replaceAll("\\", "/"));
}

async function persistCoreCatalog(context, core, catalog) {
  await mkdir(path.dirname(core.file), { recursive: true });
  await writeFile(core.file, serializeXmlDocument(core.document), "utf8");
  context.changedFiles.add(path.relative(context.coreRoot, core.file).replaceAll("\\", "/"));
  await ensureCatalogInclude(context.coreRoot, catalog, context.changedFiles);
}

function assertExpectation(operation, actual, desired, hasExpectation) {
  if (scalarEquals(actual, desired)) return "already";
  if (hasExpectation && !scalarEquals(actual, operation.expect)) {
    const shown = actual === MISSING ? "<absent>" : JSON.stringify(actual);
    throw new PatchPlanError(
      `${operation.opId}: expected ${JSON.stringify(operation.expect)}, found ${shown}`,
    );
  }
  return "change";
}

async function applyCatalogSet(context, operation) {
  const segments = parseCatalogPath(operation.path);
  let baseMatch = await context.catalogSource.findObject(operation.catalog, operation.object);
  let core = await loadCoreCatalog(context.coreRoot, operation.catalog, false);
  let coreObject = core ? findCatalogObject(core.document, operation.object) : null;
  if (!baseMatch && coreObject) {
    baseMatch = await findExternalParent(context, operation.catalog, core.document, coreObject);
  }

  const inspected = inspectCatalogEditValue({ coreDocument: core?.document, coreObject,
    baseDocument: baseMatch?.document, baseObject: baseMatch?.object, catalogPath: operation.path,
    engineField: context.catalogSource.engineField(operation.catalog, baseMatch?.object.getAttribute('id'), operation.path) });
  const current = inspected.exists ? inspected.value : MISSING;
  if(current===MISSING && operation.catalog==='User'){
    const instance=segments.find(segment=>segment.name==='Instances');
    if(instance?.index && !/^\d+$/.test(instance.index) && !masteryPointSelector(operation.path)){
      throw new PatchPlanError(`${operation.opId}: ${operation.path} is not a readable User field. Instances[${instance.index}] selects an index, not the instance Id. Reuse the exact field path and edit availability returned by entity.get; ordinal UserData fields may be unavailable for safe sparse edits. Do not probe with expect=null or replace an Id with a guessed number.`);
    }
  }
  assertCatalogWriteSupported(inspected, operation);
  if (inspected.selector && (typeof operation.value !== 'number' || !Number.isFinite(operation.value))) {
    throw new PatchPlanError(`${operation.opId}: mastery PointIncrement requires a finite numeric value.`);
  }
  if (typeof operation.value === 'number' && typeof current === 'boolean') {
    throw new PatchPlanError(`${operation.opId}: ${operation.path} is an element-presence flag, not a numeric field. Select the actual numeric attribute; changing expect cannot make this a scalar.`);
  }
  const decision = assertExpectation(
    operation,
    current,
    operation.value,
    Object.hasOwn(operation, "expect"),
  );
  if (decision === "already") return "already";

  if (!core) core = await loadCoreCatalog(context.coreRoot, operation.catalog, true);
  coreObject = findCatalogObject(core.document, operation.object);
  if (!coreObject) {
    if (!baseMatch) {
      throw new PatchPlanError(
        `${operation.opId}: cannot determine the XML class for ${operation.catalog}/${operation.object}; provide --catalog-root from the parsed co-op database`,
      );
    }
    coreObject = core.document.createElement(baseMatch.object.tagName);
    coreObject.setAttribute("id", operation.object);
    core.document.documentElement.appendChild(coreObject);
  }

  if (inspected.selector) {
    writeMasteryPoint(core.document, coreObject, inspected.selector, serializeScalar(operation.value));
    await persistCoreCatalog(context, core, operation.catalog);
    return 'changed';
  }
  const target = ensurePathOnObject(core.document, coreObject, segments);
  if (target.attribute) target.element.setAttribute(target.attribute, serializeScalar(operation.value));
  else {
    target.element.removeAttribute("removed");
    target.element.setAttribute("value", serializeScalar(operation.value));
  }

  await persistCoreCatalog(context, core, operation.catalog);
  return "changed";
}

async function applyCatalogRemove(context, operation) {
  const segments = parseCatalogPath(operation.path);
  const last = segments.at(-1);
  if (!last?.name || last.index === undefined) {
    throw new PatchPlanError(`${operation.opId}: catalog.remove must target an indexed array item`);
  }

  let baseMatch = await context.catalogSource.findObject(operation.catalog, operation.object);
  let core = await loadCoreCatalog(context.coreRoot, operation.catalog, false);
  let coreObject = core ? findCatalogObject(core.document, operation.object) : null;
  if (!baseMatch && coreObject) {
    baseMatch = await findExternalParent(context, operation.catalog, core.document, coreObject);
  }
  const localTarget = coreObject ? readPathFromObject(coreObject, segments) : MISSING;
  const localSegmentsTarget = (() => {
    if (!coreObject) return null;
    let current = coreObject;
    for (const segment of segments) {
      current = findDirectChild(current, segment.name, segment.index);
      if (!current) return null;
    }
    return current;
  })();
  if (localSegmentsTarget?.getAttribute("removed") === "1") return "already";

  const baseValue = readInheritedPath(baseMatch?.document, baseMatch?.object, segments);
  const current = localTarget !== MISSING ? localTarget : baseValue;
  if (Object.hasOwn(operation, "expect") && !scalarEquals(current, operation.expect)) {
    const shown = current === MISSING ? "<absent>" : JSON.stringify(current);
    throw new PatchPlanError(
      `${operation.opId}: expected ${JSON.stringify(operation.expect)}, found ${shown}`,
    );
  }

  if (!core) core = await loadCoreCatalog(context.coreRoot, operation.catalog, true);
  coreObject = findCatalogObject(core.document, operation.object);
  if (!coreObject) {
    if (!baseMatch) {
      throw new PatchPlanError(
        `${operation.opId}: cannot determine the XML class for ${operation.catalog}/${operation.object}; provide --catalog-root from the parsed co-op database`,
      );
    }
    coreObject = core.document.createElement(baseMatch.object.tagName);
    coreObject.setAttribute("id", operation.object);
    core.document.documentElement.appendChild(coreObject);
  }

  const target = ensurePathOnObject(core.document, coreObject, segments);
  target.element.removeAttribute("value");
  target.element.setAttribute("removed", "1");
  await persistCoreCatalog(context, core, operation.catalog);
  return "changed";
}

async function applyCatalogCreate(context, operation) {
  if (!operation.class.startsWith(`C${operation.catalog}`)) {
    throw new PatchPlanError(
      `${operation.opId}: XML class ${operation.class} does not belong to the ${operation.catalog} Catalog`,
    );
  }
  const baseMatch = await context.catalogSource.findObject(operation.catalog, operation.object);
  let core = await loadCoreCatalog(context.coreRoot, operation.catalog, false);
  let object = core ? findCatalogObject(core.document, operation.object) : null;
  if (baseMatch) {
    throw new PatchPlanError(
      `${operation.opId}: ${operation.catalog}/${operation.object} already exists in the base Catalog; use catalog.clone or catalog.set`,
    );
  }
  if (object) {
    const parent = object.hasAttribute("parent") ? object.getAttribute("parent") : null;
    const expectedParent = operation.parent ?? null;
    if (object.tagName === operation.class && parent === expectedParent) {
      context.createdObjects.add(`${operation.catalog}/${operation.object}`.toLowerCase());
      return "already";
    }
    throw new PatchPlanError(
      `${operation.opId}: Catalog object already exists as ${object.tagName}${parent ? ` parent=${parent}` : ""}`,
    );
  }

  if (operation.parent) {
    const coreParent = core ? findCatalogObject(core.document, operation.parent) : null;
    const baseParent = await context.catalogSource.findObject(operation.catalog, operation.parent);
    const parentObject = coreParent ?? baseParent?.object;
    if (!parentObject) {
      throw new PatchPlanError(
        `${operation.opId}: parent object ${operation.catalog}/${operation.parent} does not exist`,
      );
    }
    if (parentObject.tagName !== operation.class) {
      throw new PatchPlanError(
        `${operation.opId}: parent ${operation.parent} uses ${parentObject.tagName}, not ${operation.class}`,
      );
    }
  }
  if (!core) core = await loadCoreCatalog(context.coreRoot, operation.catalog, true);
  object = core.document.createElement(operation.class);
  object.setAttribute("id", operation.object);
  if (operation.parent) object.setAttribute("parent", operation.parent);
  core.document.documentElement.appendChild(object);
  await persistCoreCatalog(context, core, operation.catalog);
  context.createdObjects.add(`${operation.catalog}/${operation.object}`.toLowerCase());
  return "changed";
}

async function applyCatalogClone(context, operation) {
  let core = await loadCoreCatalog(context.coreRoot, operation.catalog, false);
  const coreSource = core ? findCatalogObject(core.document, operation.source) : null;
  const baseSource = await context.catalogSource.findObject(operation.catalog, operation.source);
  const source = coreSource ?? baseSource?.object;
  if (!source) {
    throw new PatchPlanError(
      `${operation.opId}: clone source ${operation.catalog}/${operation.source} does not exist; provide --catalog-root when it is an official object`,
    );
  }

  const baseTarget = await context.catalogSource.findObject(operation.catalog, operation.object);
  let target = core ? findCatalogObject(core.document, operation.object) : null;
  if (baseTarget) {
    throw new PatchPlanError(`${operation.opId}: clone target ${operation.catalog}/${operation.object} already exists`);
  }
  if (target) {
    if (target.tagName === source.tagName && target.getAttribute("parent") === operation.source) {
      context.createdObjects.add(`${operation.catalog}/${operation.object}`.toLowerCase());
      return "already";
    }
    throw new PatchPlanError(`${operation.opId}: clone target already exists with different class or parent`);
  }

  if (!core) core = await loadCoreCatalog(context.coreRoot, operation.catalog, true);
  target = core.document.createElement(source.tagName);
  target.setAttribute("id", operation.object);
  target.setAttribute("parent", operation.source);
  core.document.documentElement.appendChild(target);
  await persistCoreCatalog(context, core, operation.catalog);
  context.createdObjects.add(`${operation.catalog}/${operation.object}`.toLowerCase());
  return "changed";
}

async function applyCatalogInsert(context, operation) {
  const collection = parseCatalogPath(operation.path);
  const last = collection.at(-1);
  if (!last?.name || last.index !== undefined || last.attribute) {
    throw new PatchPlanError(`${operation.opId}: catalog.insert path must end at an unindexed array field`);
  }
  const segments = [
    ...collection.slice(0, -1),
    { name: last.name, index: String(operation.index) },
  ];
  let baseMatch = await context.catalogSource.findObject(operation.catalog, operation.object);
  let core = await loadCoreCatalog(context.coreRoot, operation.catalog, false);
  let coreObject = core ? findCatalogObject(core.document, operation.object) : null;
  if (!baseMatch && coreObject) {
    baseMatch = await findExternalParent(context, operation.catalog, core.document, coreObject);
  }
  const coreState = resolvePathElement(core?.document, coreObject, segments);
  const baseState = resolvePathElement(baseMatch?.document, baseMatch?.object, segments);
  const effective = coreState.found ? coreState : baseState;

  if (effective.found && !effective.removed) {
    const desiredValueMatches = !Object.hasOwn(operation, "value") ||
      scalarEquals(valueFromElementState(effective), operation.value);
    const desiredAttributesMatch = Object.entries(operation.attributes ?? {}).every(
      ([name, value]) => scalarEquals(valueFromElementState(effective, name), value),
    );
    if (desiredValueMatches && desiredAttributesMatch) return "already";
    throw new PatchPlanError(
      `${operation.opId}: array index ${operation.index} already exists with different content`,
    );
  }

  if (!core) core = await loadCoreCatalog(context.coreRoot, operation.catalog, true);
  coreObject = findCatalogObject(core.document, operation.object);
  if (!coreObject) {
    if (!baseMatch) {
      throw new PatchPlanError(
        `${operation.opId}: cannot determine the XML class for ${operation.catalog}/${operation.object}; create it first or provide --catalog-root`,
      );
    }
    coreObject = core.document.createElement(baseMatch.object.tagName);
    coreObject.setAttribute("id", operation.object);
    core.document.documentElement.appendChild(coreObject);
  }
  const target = ensurePathOnObject(core.document, coreObject, segments).element;
  target.removeAttribute("removed");
  if (Object.hasOwn(operation, "value")) target.setAttribute("value", serializeScalar(operation.value));
  for (const [name, value] of Object.entries(operation.attributes ?? {})) {
    target.setAttribute(name, serializeScalar(value));
  }
  await persistCoreCatalog(context, core, operation.catalog);
  return "changed";
}

async function applyCatalogClear(context, operation) {
  const collection = parseCatalogPath(operation.path);
  const last = collection.at(-1);
  if (!last?.name || last.index !== undefined || last.attribute) {
    throw new PatchPlanError(`${operation.opId}: catalog.clear path must end at an unindexed array field`);
  }
  const containerSegments = collection.slice(0, -1);
  const key = `${operation.catalog}/${operation.object}`.toLowerCase();
  const baseMatch = await context.catalogSource.findObject(operation.catalog, operation.object);
  let core = await loadCoreCatalog(context.coreRoot, operation.catalog, false);
  let coreObject = core ? findCatalogObject(core.document, operation.object) : null;

  if (!baseMatch && !context.createdObjects.has(key)) {
    throw new PatchPlanError(
      `${operation.opId}: catalog.clear requires --catalog-root to enumerate inherited array indexes for ${operation.catalog}/${operation.object}`,
    );
  }

  const effective = new Map();
  if (baseMatch) {
    collectIndexedChildren(baseMatch.document, baseMatch.object, containerSegments, last.name, effective);
  } else if (coreObject?.getAttribute("parent")) {
    const coreParent = findCatalogObject(core.document, coreObject.getAttribute("parent"));
    const baseParent = await context.catalogSource.findObject(
      operation.catalog,
      coreObject.getAttribute("parent"),
    );
    if (baseParent) {
      collectIndexedChildren(baseParent.document, baseParent.object, containerSegments, last.name, effective);
    } else if (!coreParent) {
      throw new PatchPlanError(
        `${operation.opId}: catalog.clear cannot enumerate inherited indexes from parent ${coreObject.getAttribute("parent")}; provide --catalog-root`,
      );
    }
  }
  if (coreObject) {
    collectIndexedChildren(core.document, coreObject, containerSegments, last.name, effective);
  }
  if (effective.size === 0) return "already";

  if (!core) core = await loadCoreCatalog(context.coreRoot, operation.catalog, true);
  coreObject = findCatalogObject(core.document, operation.object);
  if (!coreObject) {
    if (!baseMatch) {
      throw new PatchPlanError(`${operation.opId}: Catalog object does not exist: ${operation.catalog}/${operation.object}`);
    }
    coreObject = core.document.createElement(baseMatch.object.tagName);
    coreObject.setAttribute("id", operation.object);
    core.document.documentElement.appendChild(coreObject);
  }
  const container = containerSegments.length === 0
    ? coreObject
    : ensurePathOnObject(core.document, coreObject, containerSegments).element;
  for (const child of [...elementChildren(container)]) {
    if (child.tagName === last.name) container.removeChild(child);
  }
  for (const index of [...effective.keys()].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))) {
    const marker = core.document.createElement(last.name);
    marker.setAttribute("index", index);
    marker.setAttribute("removed", "1");
    container.appendChild(marker);
  }
  await persistCoreCatalog(context, core, operation.catalog);
  return "changed";
}

function resolveCorePath(coreRoot, relativePath) {
  if (
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath) ||
    /^[A-Za-z]:/.test(relativePath)
  ) {
    throw new PatchPlanError(`Unsafe core path: ${relativePath}`);
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) {
    throw new PatchPlanError(`Unsafe core path: ${relativePath}`);
  }
  const root = path.resolve(coreRoot);
  const resolved = path.resolve(root, ...segments);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new PatchPlanError(`Path escapes the Map Runtime core: ${relativePath}`);
  }
  return resolved;
}

async function applyGalaxySource(context, operation) {
  const target = resolveCorePath(context.coreRoot, operation.path);
  const source = operation.source.replaceAll("\r\n", "\n");
  const currentExists = await exists(target);
  const current = currentExists ? (await readFile(target, "utf8")).replaceAll("\r\n", "\n") : null;
  const sourceAlready = current === source;

  if (currentExists && !sourceAlready) {
    if (!operation.expectSha256) {
      throw new PatchPlanError(
        `${operation.opId}: Galaxy module already exists with different content; expectSha256 is required to replace it`,
      );
    }
    const actualHash = sha256(await readFile(target));
    if (actualHash.toLowerCase() !== operation.expectSha256.toLowerCase()) {
      throw new PatchPlanError(
        `${operation.opId}: Galaxy SHA-256 mismatch; expected ${operation.expectSha256}, found ${actualHash}`,
      );
    }
  }

  const manifestPath = path.join(context.coreRoot, "GameA.Core.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!manifest.galaxy || !Array.isArray(manifest.galaxy.modules)) {
    throw new PatchPlanError("GameA.Core.json does not contain galaxy.modules");
  }
  const normalizedPath = operation.path.replaceAll("\\", "/");
  if (String(manifest.galaxy.core).replaceAll("\\", "/").toLowerCase() === normalizedPath.toLowerCase()) {
    throw new PatchPlanError(`${operation.opId}: galaxy.source cannot replace the frozen Map Runtime core module`);
  }
  const existing = manifest.galaxy.modules.find(
    (module) => String(module.path).replaceAll("\\", "/").toLowerCase() === normalizedPath.toLowerCase(),
  );
  const init = operation.register.init ?? null;
  const configure = operation.register.configure ?? null;
  const registrationAlready =
    existing && Number(existing.order) === operation.register.order &&
    (existing.init ?? null) === init && (existing.configure ?? null) === configure;

  const initConflict = init
    ? manifest.galaxy.modules.find(
        (module) =>
          module !== existing && module.init === init &&
          String(module.path).replaceAll("\\", "/").toLowerCase() !== normalizedPath.toLowerCase(),
      )
    : null;
  if (initConflict) {
    throw new PatchPlanError(
      `${operation.opId}: init function ${init} is already registered by ${initConflict.path}`,
    );
  }
  const configureConflict = configure
    ? manifest.galaxy.modules.find(
        (module) =>
          module !== existing && module.configure === configure &&
          String(module.path).replaceAll("\\", "/").toLowerCase() !== normalizedPath.toLowerCase(),
      )
    : null;
  if (configureConflict) {
    throw new PatchPlanError(
      `${operation.opId}: configure function ${configure} is already registered by ${configureConflict.path}`,
    );
  }
  if (existing && !registrationAlready && currentExists && !sourceAlready && !operation.expectSha256) {
    throw new PatchPlanError(`${operation.opId}: conflicting Galaxy module registration for ${normalizedPath}`);
  }

  if (!sourceAlready) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source, "utf8");
    context.changedFiles.add(operation.path);
  }
  if (!registrationAlready) {
    const replacement = { path: normalizedPath, order: operation.register.order };
    if (init) replacement.init = init;
    if (configure) replacement.configure = configure;
    if (existing) Object.assign(existing, replacement);
    else manifest.galaxy.modules.push(replacement);
    manifest.galaxy.modules.sort(
      (left, right) => Number(left.order) - Number(right.order) || String(left.path).localeCompare(String(right.path)),
    );
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    context.changedFiles.add("GameA.Core.json");
  }
  return sourceAlready && registrationAlready ? "already" : "changed";
}

function commanderScopeHash(parts) {
  return sha256(parts.join("\0")).slice(0, 16);
}

function upgradeReference(catalog, object, catalogPath) {
  parseCatalogPath(catalogPath);
  return `${catalog},${object},${catalogPath.replaceAll(".@", ".")}`;
}

// Shared with the read-only query projection. Exact spelling is part of the
// generated Upgrade identity; never normalize an existing operation here.
export function commanderStatIdentity(operation) {
  const scopeHash = commanderScopeHash([
    "stat", operation.commanderId, operation.catalog, operation.object, operation.path,
    ...(operation.prestigeUpgrade ? ['prestige', operation.prestigeUpgrade] : []),
  ]);
  return { scopeHash, upgradeId: `GameACommanderStat${scopeHash}`,
    reference: upgradeReference(operation.catalog, operation.object, operation.path) };
}

export function commanderCloneIdentity(operation) {
  const scopeHash = commanderScopeHash(["unit-clone", operation.commanderId, operation.sourceUnit]);
  return { scopeHash, upgradeId: `GameACommanderClone${scopeHash}` };
}

export function commanderUpgradeArtifact(operation) {
  const identity = operation.kind === "commander.stat.set"
    ? commanderStatIdentity(operation) : commanderCloneIdentity(operation);
  const configure = `GameA_CommanderUpgrade_${identity.scopeHash}_Configure`;
  return { ...identity, path: `Base.SC2Data/Generated/CommanderUpgrade_${identity.scopeHash}.galaxy`,
    configure, source: commanderUpgradeGalaxy({ commanderId: operation.commanderId,
      prestigeUpgrade: operation.prestigeUpgrade,
      upgradeId: identity.upgradeId, configureFunction: configure }) };
}

export function inspectCatalogEditValue({ coreDocument, coreObject, baseDocument, baseObject, catalogPath, engineField, projectedField }) {
  const mastery = inspectMasteryPoint(baseObject, coreObject, catalogPath);
  if (mastery) return mastery;
  requireCanonicalEditPath((coreObject ?? baseObject)?.tagName, catalogPath);
  const segments = parseCatalogPath(catalogPath);
  const local = readInheritedPath(coreDocument, coreObject, segments);
  const baseValue = readInheritedPath(baseDocument, baseObject, segments);
  // A Catalog object can be assembled from several dependency load layers.
  // direct_xml represents one authored layer, while catalog_fields contains
  // the deterministic merged value. Use that projection only when neither
  // local XML, an engine observation nor the available base XML has the member.
  const value = local !== MISSING ? local : engineField ? engineField.value
    : baseValue !== MISSING ? baseValue : projectedField ? projectedField.value : MISSING;
  const layouts = [inspectSelectorLayout(coreDocument, coreObject, segments, catalogPath, Boolean(engineField)),
    inspectSelectorLayout(baseDocument, baseObject, segments, catalogPath, Boolean(engineField))];
  return { exists: value !== MISSING, value: value === MISSING ? null : value,
    writeSupport: layouts.find(layout => !layout.supported) ?? { supported: true, reason: null },
    source: local !== MISSING ? "core" : engineField ? "sc2-engine" : value !== MISSING ? "official" : "unknown" };
}

async function readEffectiveCatalogValue(context, catalog, object, catalogPath) {
  let baseMatch = await context.catalogSource.findObject(catalog, object);
  const core = await loadCoreCatalog(context.coreRoot, catalog, false);
  const coreObject = core ? findCatalogObject(core.document, object) : null;
  if (!baseMatch && coreObject) {
    baseMatch = await findExternalParent(context, catalog, core.document, coreObject);
  }
  const result = inspectCatalogEditValue({ coreDocument: core?.document, coreObject,
    baseDocument: baseMatch?.document, baseObject: baseMatch?.object, catalogPath,
    engineField: context.catalogSource.engineField(catalog, baseMatch?.object.getAttribute('id'), catalogPath) });
  assertCatalogWriteSupported(result, { opId: `${catalog}/${object}/${catalogPath}` });
  return result.exists ? result.value : MISSING;
}

function findUpgradeEffect(upgrade, reference) {
  return elementChildren(upgrade).find(
    (child) => child.tagName === "EffectArray" && child.getAttribute("Reference") === reference,
  );
}

function ensureUpgradeChild(document, upgrade, tagName, attributes) {
  const existing = elementChildren(upgrade).find(
    (child) =>
      child.tagName === tagName &&
      Object.entries(attributes).every(([name, value]) => child.getAttribute(name) === String(value)),
  );
  if (existing) return false;
  const child = document.createElement(tagName);
  for (const [name, value] of Object.entries(attributes)) child.setAttribute(name, String(value));
  upgrade.appendChild(child);
  return true;
}

async function loadCommanderUpgrade(context, upgradeId) {
  const baseMatch = await context.catalogSource.findObject("Upgrade", upgradeId);
  let core = await loadCoreCatalog(context.coreRoot, "Upgrade", false);
  let upgrade = core ? findCatalogObject(core.document, upgradeId) : null;
  if (baseMatch && !upgrade) {
    throw new PatchPlanError(`Generated commander upgrade ID already exists in the base Catalog: ${upgradeId}`);
  }
  if (!core) core = await loadCoreCatalog(context.coreRoot, "Upgrade", true);
  if (!upgrade) {
    upgrade = core.document.createElement("CUpgrade");
    upgrade.setAttribute("id", upgradeId);
    core.document.documentElement.appendChild(upgrade);
  } else if (upgrade.tagName !== "CUpgrade") {
    throw new PatchPlanError(`Generated commander upgrade ${upgradeId} is not a CUpgrade`);
  }
  return { core, upgrade };
}

async function persistCommanderUpgrade(context, core, upgrade, affectedUnit = null) {
  ensureUpgradeChild(core.document, upgrade, "Flags", { index: "UpgradeCheat", value: "0" });
  ensureUpgradeChild(core.document, upgrade, "MaxLevel", { value: "1" });
  if (affectedUnit) ensureUpgradeChild(core.document, upgrade, "AffectedUnitArray", { value: affectedUnit });
  await persistCoreCatalog(context, core, "Upgrade");
}

export function commanderUpgradeGalaxy({ commanderId, upgradeId, configureFunction, prestigeUpgrade }) {
  return renderCommanderUpgradeGalaxy({ commanderId, upgradeId, configureFunction, prestigeUpgrade });
}

function renderCommanderUpgradeGalaxy({ commanderId, upgradeId, configureFunction, prestigeUpgrade }, legacy = false) {
  // Configure runs after preparation commits the prestige selection, but BEFORE
  // CC_ApplyTech grants its Upgrade. Keep this timing: moving Set after official
  // startup Add/Multiply effects would erase those effects.
  const selectedPrestige = prestigeUpgrade && !legacy;
  const condition = !prestigeUpgrade ? '' : legacy
    ? ` && TechTreeUpgradeCount(player, "${prestigeUpgrade}", c_techCountCompleteOnly) > 0`
    : ` && prestige != null && UserDataGetGameLink("PlayerPrestige", prestige, "PrimaryUpgrade", 1) == "${prestigeUpgrade}"`;
  return `// Generated by PatchPlan for a commander-scoped upgrade.\n\n` +
    `void ${configureFunction} () {\n` +
    `    int player;\n` +
    (selectedPrestige ? `    string prestige;\n` : '') +
    `    playergroup commanders;\n\n` +
    `    commanders = libCOOC_gf_CommanderPlayers();\n` +
    `    player = -1;\n` +
    `    while (true) {\n` +
    `        player = PlayerGroupNextPlayer(commanders, player);\n` +
    `        if (player < 0) {\n` +
    `            break;\n` +
    `        }\n` +
    (selectedPrestige ? `        prestige = libCOOC_gf_CC_PlayerActivePrestigeInstance(player);\n` : '') +
    `        if (libCOOC_gf_ActiveCommanderForPlayer(player) == "${commanderId}"${condition} && TechTreeUpgradeCount(player, "${upgradeId}", c_techCountCompleteOnly) == 0) {\n` +
    `            TechTreeUpgradeAddLevel(player, "${upgradeId}", 1);\n` +
    `        }\n` +
    `    }\n` +
    `}\n`;
}

async function legacyCommanderUpgradeHash(coreRoot, operation, artifact) {
  if (!operation.prestigeUpgrade) return undefined;
  const target = resolveCorePath(coreRoot, artifact.path);
  if (!(await exists(target))) return undefined;
  const bytes = await readFile(target);
  const legacy = renderCommanderUpgradeGalaxy({ commanderId: operation.commanderId,
    prestigeUpgrade: operation.prestigeUpgrade, upgradeId: artifact.upgradeId,
    configureFunction: artifact.configure }, true);
  // Only our exact old template (including CRLF checkouts) is safe to migrate.
  return bytes.toString('utf8').replaceAll('\r\n', '\n') === legacy ? sha256(bytes) : undefined;
}

async function ensureCommanderUpgradeRuntime(context, operation, scopeHash, upgradeId) {
  const configureFunction = `GameA_CommanderUpgrade_${scopeHash}_Configure`;
  const artifact = { path: `Base.SC2Data/Generated/CommanderUpgrade_${scopeHash}.galaxy`,
    upgradeId, configure: configureFunction };
  return applyGalaxySource(context, {
    opId: operation.opId,
    kind: "galaxy.source",
    path: artifact.path,
    expectSha256: await legacyCommanderUpgradeHash(context.coreRoot, operation, artifact),
    source: commanderUpgradeGalaxy({
      commanderId: operation.commanderId,
      prestigeUpgrade: operation.prestigeUpgrade,
      upgradeId,
      configureFunction,
    }),
    register: { order: 300, configure: configureFunction },
  });
}

async function applyCommanderStatSet(context, operation) {
  if (operation.prestigeUpgrade && !(await context.catalogSource.findObject('Upgrade', operation.prestigeUpgrade))) {
    throw new PatchPlanError(`${operation.opId}: unknown prestige Upgrade ${operation.prestigeUpgrade}`);
  }
  const { scopeHash, upgradeId, reference } = commanderStatIdentity(operation);
  const existingUpgradeCatalog = await loadCoreCatalog(context.coreRoot, "Upgrade", false);
  const existingUpgrade = existingUpgradeCatalog
    ? findCatalogObject(existingUpgradeCatalog.document, upgradeId)
    : null;
  const existingEffect = existingUpgrade ? findUpgradeEffect(existingUpgrade, reference) : null;
  const current = existingEffect?.hasAttribute("Value")
    ? existingEffect.getAttribute("Value")
    : await readEffectiveCatalogValue(context, operation.catalog, operation.object, operation.path);
  const decision = assertExpectation(operation, current, operation.value, true);

  let catalogStatus = "already";
  if (decision !== "already" || !existingEffect) {
    const { core, upgrade } = await loadCommanderUpgrade(context, upgradeId);
    const effects = elementChildren(upgrade).filter((child) => child.tagName === "EffectArray");
    const effect = findUpgradeEffect(upgrade, reference);
    if (effects.length > (effect ? 1 : 0)) {
      throw new PatchPlanError(`${operation.opId}: generated commander stat upgrade contains unexpected effects`);
    }
    const target = effect ?? core.document.createElement("EffectArray");
    target.setAttribute("Operation", "Set");
    target.setAttribute("Reference", reference);
    target.setAttribute("Value", serializeScalar(operation.value));
    if (!effect) upgrade.appendChild(target);
    await persistCommanderUpgrade(
      context,
      core,
      upgrade,
      operation.catalog === "Unit" ? operation.object : null,
    );
    catalogStatus = "changed";
  }
  const runtimeStatus = await ensureCommanderUpgradeRuntime(context, operation, scopeHash, upgradeId);
  return catalogStatus === "already" && runtimeStatus === "already" ? "already" : "changed";
}

async function applyCommanderUnitActorClone(context, operation) {
  const sourceActorId = operation.sourceActor ?? operation.sourceUnit;
  const actorId = operation.actorId ?? operation.unitId;
  let core = await loadCoreCatalog(context.coreRoot, "Actor", false);
  const coreSource = core ? findCatalogObject(core.document, sourceActorId) : null;
  const baseSource = await context.catalogSource.findObject("Actor", sourceActorId);
  const source = coreSource ?? baseSource?.object;
  if (!source || source.tagName !== "CActorUnit") {
    throw new PatchPlanError(
      `${operation.opId}: source Actor/${sourceActorId} is not a CActorUnit; specify sourceActor when it differs from the Unit ID`,
    );
  }

  const baseTarget = await context.catalogSource.findObject("Actor", actorId);
  let target = core ? findCatalogObject(core.document, actorId) : null;
  if (baseTarget && !target) {
    throw new PatchPlanError(`${operation.opId}: clone target Actor/${actorId} already exists in the base Catalog`);
  }
  if (!core) core = await loadCoreCatalog(context.coreRoot, "Actor", true);

  const desired = core.document.importNode(source, true);
  desired.setAttribute("id", actorId);
  desired.setAttribute("unitName", operation.unitId);

  // Many stock CActorUnit objects implicitly use a CModel with the same ID.
  // That implicit link changes when the Actor ID is cloned, so materialize it.
  if (!findDirectChild(desired, "Model")) {
    const sameIdModel = await context.catalogSource.findObject("Model", sourceActorId);
    if (sameIdModel) {
      const model = core.document.createElement("Model");
      model.setAttribute("value", sourceActorId);
      desired.appendChild(model);
    }
  }

  if (target) {
    if (target.tagName !== "CActorUnit" || target.getAttribute("unitName") !== operation.unitId) {
      throw new PatchPlanError(`${operation.opId}: clone target Actor/${actorId} has a conflicting binding`);
    }
    const normalizedTarget = target.toString().replace(/>\s+</g, "><").trim();
    const normalizedDesired = desired.toString().replace(/>\s+</g, "><").trim();
    if (normalizedTarget === normalizedDesired) return "already";
    const isLegacyShallowClone =
      target.getAttribute("parent") === sourceActorId && elementChildren(target).length === 0;
    if (!isLegacyShallowClone) {
      throw new PatchPlanError(`${operation.opId}: clone target Actor/${actorId} has been customized`);
    }
    target.parentNode.replaceChild(desired, target);
  } else {
    core.document.documentElement.appendChild(desired);
  }

  await persistCoreCatalog(context, core, "Actor");
  context.createdObjects.add(`actor/${actorId}`.toLowerCase());
  return "changed";
}

async function applyCommanderUnitClone(context, operation) {
  if (operation.sourceUnit === operation.unitId) {
    throw new PatchPlanError(`${operation.opId}: commander.unit.clone requires a new unitId`);
  }
  const cloneStatus = await applyCatalogClone(context, {
    opId: operation.opId,
    kind: "catalog.clone",
    catalog: "Unit",
    source: operation.sourceUnit,
    object: operation.unitId,
  });
  const sourceName = await readEffectiveCatalogValue(context, "Unit", operation.sourceUnit, "Name");
  const materializedSourceName = sourceName === MISSING
    ? `Unit/Name/${operation.sourceUnit}`
    : String(sourceName)
        .replaceAll("##id##", operation.sourceUnit)
        .replaceAll("##unitName##", operation.sourceUnit);
  const unitNameStatus = await applyCatalogSet(context, {
    opId: `${operation.opId}:unit-name`,
    kind: "catalog.set",
    catalog: "Unit",
    object: operation.unitId,
    path: "Name",
    value: materializedSourceName,
  });
  const actorCloneStatus = await applyCommanderUnitActorClone(context, operation);
  const { scopeHash, upgradeId } = commanderCloneIdentity(operation);
  const desiredEffects = [];
  const seenReferences = new Set();
  for (const redirect of operation.redirects) {
    const reference = upgradeReference(redirect.catalog, redirect.object, redirect.path);
    if (seenReferences.has(reference)) {
      throw new PatchPlanError(`${operation.opId}: duplicate unit redirect ${reference}`);
    }
    seenReferences.add(reference);
    const current = await readEffectiveCatalogValue(
      context,
      redirect.catalog,
      redirect.object,
      redirect.path,
    );
    const expectationMatches = redirect.expectAbsent === true
      ? current === MISSING
      : scalarEquals(current, redirect.expect);
    if (!expectationMatches) {
      const shown = current === MISSING ? "<absent>" : JSON.stringify(current);
      const expected = redirect.expectAbsent === true ? "<absent>" : JSON.stringify(redirect.expect);
      throw new PatchPlanError(
        `${operation.opId}: redirect ${reference} expected ${expected}, found ${shown}`,
      );
    }
    desiredEffects.push({ reference, value: operation.unitId });
  }

  const { core, upgrade } = await loadCommanderUpgrade(context, upgradeId);
  const existingEffects = elementChildren(upgrade).filter((child) => child.tagName === "EffectArray");
  const desiredByReference = new Map(desiredEffects.map((effect) => [effect.reference, effect]));
  for (const effect of existingEffects) {
    const reference = effect.getAttribute("Reference");
    const desired = desiredByReference.get(reference);
    if (!desired || effect.getAttribute("Operation") !== "Set" || effect.getAttribute("Value") !== desired.value) {
      throw new PatchPlanError(`${operation.opId}: generated commander clone upgrade contains a conflicting redirect`);
    }
  }
  let upgradeChanged = false;
  for (const desired of desiredEffects) {
    if (findUpgradeEffect(upgrade, desired.reference)) continue;
    const effect = core.document.createElement("EffectArray");
    effect.setAttribute("Operation", "Set");
    effect.setAttribute("Reference", desired.reference);
    effect.setAttribute("Value", desired.value);
    upgrade.appendChild(effect);
    upgradeChanged = true;
  }
  if (existingEffects.length !== desiredEffects.length && !upgradeChanged) {
    throw new PatchPlanError(`${operation.opId}: generated commander clone upgrade redirect count differs`);
  }
  if (upgradeChanged || existingEffects.length === 0) {
    await persistCommanderUpgrade(context, core, upgrade, operation.unitId);
  }
  const runtimeStatus = await ensureCommanderUpgradeRuntime(context, operation, scopeHash, upgradeId);
  return cloneStatus === "already" &&
    actorCloneStatus === "already" &&
    unitNameStatus === "already" &&
    !upgradeChanged &&
    runtimeStatus === "already"
    ? "already"
    : "changed";
}

async function applyLocaleSet(context, operation) {
  const relative = `${operation.locale}.SC2Data/LocalizedData/GameStrings.txt`;
  const target = resolveCorePath(context.coreRoot, relative);
  const currentText = (await exists(target)) ? await readFile(target, "utf8") : "";
  const lines = currentText.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();

  const matching = [];
  for (let index = 0; index < lines.length; index += 1) {
    const separator = lines[index].indexOf("=");
    if (separator > 0 && lines[index].slice(0, separator) === operation.key) matching.push(index);
  }
  const current = matching.length > 0 ? lines[matching[0]].slice(operation.key.length + 1) : MISSING;
  const decision = assertExpectation(
    operation,
    current,
    operation.value,
    Object.hasOwn(operation, "expect"),
  );
  if (decision === "already" && matching.length === 1) return "already";

  if (decision !== "already") {
    const replacement = `${operation.key}=${operation.value}`;
    if (matching.length > 0) lines[matching[0]] = replacement;
    else lines.push(replacement);
  }
  for (let index = matching.length - 1; index >= 1; index -= 1) lines.splice(matching[index], 1);

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${lines.join("\n")}\n`, "utf8");
  context.changedFiles.add(relative);
  return "changed";
}

function parseUnifiedHunks(patchText) {
  const lines = patchText.replaceAll("\r\n", "\n").split("\n");
  const hunks = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index] === "") {
      index += 1;
      continue;
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(lines[index]);
    if (!header) throw new PatchPlanError(`Invalid unified diff hunk header: ${lines[index]}`);
    const hunk = {
      oldStart: Number(header[1]),
      oldCount: header[2] === undefined ? 1 : Number(header[2]),
      newStart: Number(header[3]),
      newCount: header[4] === undefined ? 1 : Number(header[4]),
      lines: [],
    };
    index += 1;
    while (index < lines.length && !lines[index].startsWith("@@ ")) {
      const line = lines[index];
      if (line === "\\ No newline at end of file") {
        index += 1;
        continue;
      }
      if (line === "" && index === lines.length - 1) break;
      if (!/^[ +\-]/.test(line)) throw new PatchPlanError(`Invalid unified diff line: ${line}`);
      hunk.lines.push({ type: line[0], text: line.slice(1) });
      index += 1;
    }
    const oldCount = hunk.lines.filter((line) => line.type !== "+").length;
    const newCount = hunk.lines.filter((line) => line.type !== "-").length;
    if (oldCount !== hunk.oldCount || newCount !== hunk.newCount) {
      throw new PatchPlanError(
        `Unified diff count mismatch at old line ${hunk.oldStart}: expected ${hunk.oldCount}/${hunk.newCount}, found ${oldCount}/${newCount}`,
      );
    }
    hunks.push(hunk);
  }
  if (hunks.length === 0) throw new PatchPlanError("file.patch contains no hunks");
  return hunks;
}

function splitTextLines(text) {
  const normalized = text.replaceAll("\r\n", "\n");
  const trailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline, eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

function hunkSequence(hunk, side) {
  return hunk.lines
    .filter((line) => line.type === " " || line.type === side)
    .map((line) => line.text);
}

function sequenceMatches(lines, start, sequence) {
  if (start < 0 || start + sequence.length > lines.length) return false;
  return sequence.every((line, offset) => lines[start + offset] === line);
}

function patchAlreadyApplied(sourceLines, hunks) {
  return hunks.every((hunk) => {
    const sequence = hunkSequence(hunk, "+");
    if (sequence.length === 0) return sourceLines.length === 0;
    return sequenceMatches(sourceLines, hunk.newStart - 1, sequence);
  });
}

function applyUnifiedPatch(text, patchText) {
  const parsed = splitTextLines(text);
  const hunks = parseUnifiedHunks(patchText);
  if (patchAlreadyApplied(parsed.lines, hunks)) return { text, already: true };

  const output = [...parsed.lines];
  let offset = 0;
  for (const hunk of hunks) {
    const start = hunk.oldStart - 1 + offset;
    const oldSequence = hunkSequence(hunk, "-");
    if (!sequenceMatches(output, start, oldSequence)) {
      throw new PatchPlanError(`Unified diff context mismatch near old line ${hunk.oldStart}`);
    }
    const newSequence = hunkSequence(hunk, "+");
    output.splice(start, oldSequence.length, ...newSequence);
    offset += newSequence.length - oldSequence.length;
  }
  const result = output.join(parsed.eol) + (parsed.trailingNewline ? parsed.eol : "");
  return { text: result, already: false };
}

async function applyFilePatch(context, operation) {
  const target = resolveCorePath(context.coreRoot, operation.path);
  if (!(await exists(target)) || !(await stat(target)).isFile()) {
    throw new PatchPlanError(`${operation.opId}: file.patch target does not exist: ${operation.path}`);
  }
  const bytes = await readFile(target);
  const currentHash = sha256(bytes);
  const currentText = bytes.toString("utf8");
  if (currentHash.toLowerCase() !== operation.baseSha256.toLowerCase()) {
    const probe = applyUnifiedPatch(currentText, operation.patch);
    if (probe.already) return "already";
    throw new PatchPlanError(
      `${operation.opId}: file SHA-256 mismatch; expected ${operation.baseSha256}, found ${currentHash}`,
    );
  }
  const result = applyUnifiedPatch(currentText, operation.patch);
  if (result.already) return "already";
  await writeFile(target, result.text, "utf8");
  context.changedFiles.add(operation.path);
  return "changed";
}

export async function validatePatchPlan(plan, schemaLocation) {
  const schemaDirectory = path.extname(schemaLocation) ? path.dirname(schemaLocation) : schemaLocation;
  const v1Path = path.join(schemaDirectory, "patch-plan.schema.json");
  const v2Path = path.join(schemaDirectory, "patch-plan-v2.schema.json");
  if (plan.formatVersion !== 1 && plan.formatVersion !== 2) {
    throw new PatchPlanError(`Unsupported PatchPlan formatVersion: ${plan.formatVersion}`);
  }
  const v1Schema = JSON.parse(await readFile(v1Path, "utf8"));
  const schema = plan.formatVersion === 1
    ? v1Schema
    : JSON.parse(await readFile(v2Path, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  if (plan.formatVersion === 2) ajv.addSchema(v1Schema);
  const validate = ajv.compile(schema);
  if (!validate(plan)) {
    const details = validate.errors.map(
      (error) => `${error.instancePath || "/"} ${error.message}`,
    );
    throw new PatchPlanError("PatchPlan schema validation failed", details);
  }
  const ids = plan.operations.map((operation) => operation.opId);
  if (new Set(ids).size !== ids.length) {
    throw new PatchPlanError("PatchPlan operation opId values must be unique");
  }
  if (plan.formatVersion === 2) {
    const dependencies = new Set(plan.dependsOn ?? []);
    const conflicts = new Set(plan.conflictsWith ?? []);
    if (dependencies.has(plan.id) || conflicts.has(plan.id)) {
      throw new PatchPlanError("PatchPlan cannot depend on or conflict with itself");
    }
    const overlap = [...dependencies].find((id) => conflicts.has(id));
    if (overlap) throw new PatchPlanError(`PatchPlan lists '${overlap}' in both dependsOn and conflictsWith`);
  }
  return plan;
}

async function assertCompatibility(repoRoot, plan) {
  const baselinePath = path.join(repoRoot, "game-a", "runtime-baseline.json");
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  if (baseline.sc2?.dataBuild !== plan.compatibility.sc2DataBuild) {
    throw new PatchPlanError(
      `SC2 data build mismatch: plan=${plan.compatibility.sc2DataBuild}, Map Runtime=${baseline.sc2?.dataBuild ?? "unknown"}`,
    );
  }
  if (baseline.schemaVersion !== plan.compatibility.runtimeContract) {
    throw new PatchPlanError(
      `Map Runtime runtime contract mismatch: plan=${plan.compatibility.runtimeContract}, Map Runtime=${baseline.schemaVersion}`,
    );
  }
}

async function assertPlanRelations(repoRoot, plan) {
  if (plan.formatVersion !== 2) return;
  const patchesRoot = path.join(repoRoot, "game-a", "patches");
  for (const dependency of plan.dependsOn ?? []) {
    const dependencyPlan = path.join(patchesRoot, `${dependency}.patch-plan.json`);
    const dependencyReceipt = path.join(patchesRoot, `${dependency}.receipt.json`);
    if (!(await exists(dependencyPlan)) || !(await exists(dependencyReceipt))) {
      throw new PatchPlanError(
        `Required PatchPlan '${dependency}' has not been applied with a receipt`,
      );
    }
  }
  for (const conflict of plan.conflictsWith ?? []) {
    const conflictPlan = path.join(patchesRoot, `${conflict}.patch-plan.json`);
    if (await exists(conflictPlan)) {
      throw new PatchPlanError(`Conflicting PatchPlan '${conflict}' is already applied`);
    }
  }

  if (!(await exists(patchesRoot))) return;
  const dependencies = new Set(plan.dependsOn ?? []);
  const requestedTargets = plan.operations.flatMap(operationTargets);
  for (const entry of await readdir(patchesRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".receipt.json")) continue;
    const receipt = JSON.parse(await readFile(path.join(patchesRoot, entry.name), "utf8"));
    if (receipt.planId === plan.id || dependencies.has(receipt.planId)) continue;
    for (const existingOperation of receipt.operations ?? []) {
      const existingTargets = Array.isArray(existingOperation.targets) && existingOperation.targets.length > 0
        ? existingOperation.targets
        : existingOperation.target
          ? [existingOperation.target]
          : [];
      const conflict = requestedTargets
        .flatMap((requested) => existingTargets.map((existing) => ({ requested, existing })))
        .find(({ requested, existing }) => targetsConflict(requested, existing));
      if (conflict) {
        throw new PatchPlanError(
          `PatchPlan target '${conflict.requested}' conflicts with applied plan '${receipt.planId}' at '${conflict.existing}'; declare it in dependsOn or choose a different target`,
        );
      }
    }
  }
}

export function operationTargets(operation) {
  let targets;
  switch (operation.kind) {
    case "catalog.create":
    case "catalog.clone":
      targets = [`catalog/${operation.catalog}/${operation.object}`];
      break;
    case "catalog.set":
    case "catalog.remove":
      targets = [`catalog/${operation.catalog}/${operation.object}/${operation.catalog === 'User' ? masteryPointSelector(operation.path)?.physicalPath ?? operation.path : operation.path}`];
      break;
    case "catalog.insert":
      targets = [`catalog/${operation.catalog}/${operation.object}/${operation.path}[${operation.index}]`];
      break;
    case "catalog.clear":
      targets = [`catalog/${operation.catalog}/${operation.object}/${operation.path}[*]`];
      break;
    case "commander.stat.set":
      targets = [`commander/${operation.commanderId}/stat/${operation.catalog}/${operation.object}/${operation.path}`];
      break;
    case "commander.unit.clone":
      targets = [
        `commander/${operation.commanderId}/unit/${operation.sourceUnit}`,
        `catalog/Unit/${operation.unitId}`,
        `catalog/Actor/${operation.actorId ?? operation.unitId}`,
        ...(operation.redirects ?? []).map(
          (redirect) => `catalog/${redirect.catalog}/${redirect.object}/${redirect.path}`,
        ),
      ];
      break;
    case "locale.set":
      targets = [`locale/${operation.locale}/${operation.key}`];
      break;
    case "galaxy.source":
    case "file.patch":
      targets = [`file/${operation.path.toLowerCase()}`];
      break;
    default:
      targets = [`${operation.kind}/${operation.opId}`];
      break;
  }
  return [...new Set(targets)];
}

export function operationTarget(operation) {
  return operationTargets(operation)[0];
}

export function targetsConflict(left, right) {
  if (left === right) return true;
  if (!left.startsWith("catalog/") || !right.startsWith("catalog/")) return false;
  const leftParts = left.split("/");
  const rightParts = right.split("/");
  if (leftParts[1] !== rightParts[1] || leftParts[2] !== rightParts[2]) return false;
  if (leftParts.length === 3 || rightParts.length === 3) return true;
  const leftPath = leftParts.slice(3).join("/");
  const rightPath = rightParts.slice(3).join("/");
  const leftWildcard = leftPath.endsWith("[*]") ? leftPath.slice(0, -3) : null;
  const rightWildcard = rightPath.endsWith("[*]") ? rightPath.slice(0, -3) : null;
  if (leftWildcard && (rightPath === leftWildcard || rightPath.startsWith(`${leftWildcard}[`))) return true;
  if (rightWildcard && (leftPath === rightWildcard || leftPath.startsWith(`${rightWildcard}[`))) return true;
  return leftPath.startsWith(`${rightPath}.`) || rightPath.startsWith(`${leftPath}.`);
}

async function listFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(root, child));
    else if (entry.isFile()) files.push(child.replaceAll("\\", "/"));
  }
  return files;
}

async function fileHashOrNull(root, relativePath) {
  const file = resolveCorePath(root, relativePath);
  return (await exists(file)) ? sha256(await readFile(file)) : null;
}

export async function treeHash(root) {
  const digest = createHash("sha256");
  for (const relative of await listFiles(root)) {
    digest.update(relative);
    digest.update("\0");
    digest.update(await readFile(resolveCorePath(root, relative)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function buildReceipt({ plan, application, beforeCore, afterCore }) {
  const files = [];
  for (const relativePath of application.changedFiles) {
    files.push({
      path: relativePath,
      beforeSha256: await fileHashOrNull(beforeCore, relativePath),
      afterSha256: await fileHashOrNull(afterCore, relativePath),
    });
  }
  return {
    receiptVersion: 1,
    planId: plan.id,
    planFormatVersion: plan.formatVersion,
    planSha256: sha256(stableJson(planForStorage(plan))),
    appliedAt: new Date().toISOString(),
    compatibility: plan.compatibility,
    operations: application.results,
    files,
    coreTreeBeforeSha256: await treeHash(beforeCore),
    coreTreeAfterSha256: await treeHash(afterCore),
  };
}

export async function applyPlanToCore({ coreRoot, plan, catalogRoot = null, databaseFile = null }) {
  databaseFile ??= catalogRoot ? path.join(path.dirname(path.dirname(path.resolve(catalogRoot))), 'coop.sqlite') : null;
  validatePrestigeContract(plan, { databaseFile });
  const context = {
    coreRoot: path.resolve(coreRoot),
    planId: plan.id,
    catalogSource: new CatalogSource(catalogRoot, databaseFile),
    changedFiles: new Set(),
    createdObjects: new Set(),
  };
  const results = [];
  for (const operation of plan.operations) {
    let status;
    switch (operation.kind) {
      case "catalog.set":
        status = await applyCatalogSet(context, operation);
        break;
      case "catalog.remove":
        status = await applyCatalogRemove(context, operation);
        break;
      case "catalog.create":
        status = await applyCatalogCreate(context, operation);
        break;
      case "catalog.clone":
        status = await applyCatalogClone(context, operation);
        break;
      case "catalog.insert":
        status = await applyCatalogInsert(context, operation);
        break;
      case "catalog.clear":
        status = await applyCatalogClear(context, operation);
        break;
      case "commander.stat.set":
        status = await applyCommanderStatSet(context, operation);
        break;
      case "commander.unit.clone":
        status = await applyCommanderUnitClone(context, operation);
        break;
      case "galaxy.source":
        status = await applyGalaxySource(context, operation);
        break;
      case "locale.set":
        status = await applyLocaleSet(context, operation);
        break;
      case "file.patch":
        status = await applyFilePatch(context, operation);
        break;
      default:
        throw new PatchPlanError(`Unsupported operation: ${operation.kind}`);
    }
    const targets = operationTargets(operation);
    results.push({
      opId: operation.opId,
      kind: operation.kind,
      target: targets[0],
      targets,
      status,
      verified:
        Object.hasOwn(operation, "expect") ||
        Object.hasOwn(operation, "expectSha256") ||
        operation.kind === "file.patch" ||
        operation.kind === "commander.stat.set" ||
        operation.kind === "commander.unit.clone" ||
        ["catalog.create", "catalog.clone", "catalog.insert", "catalog.clear"].includes(operation.kind),
    });
  }
  return { results, changedFiles: [...context.changedFiles].sort() };
}

export function validateGalaxySource(source, label = "Galaxy source") {
  const cStyleArray = /^(\s*)(?:const\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*([^\]\r\n]+)\s*\]\s*(?:=|;)/gm;
  const match = cStyleArray.exec(source);
  if (!match) return;

  const line = source.slice(0, match.index).split(/\r?\n/).length;
  throw new PatchPlanError(
    `${label}:${line}: Galaxy array dimensions belong after the type; use '${match[2]}[${match[4].trim()}] ${match[3]}'`,
  );
}

async function validateCoreStructure(coreRoot) {
  const gameDataRoot = path.join(coreRoot, "Base.SC2Data", "GameData");
  const entries = await readdir(gameDataRoot, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".xml")) continue;
    const file = path.join(entry.parentPath, entry.name);
    const document = parseXml(await readFile(file, "utf8"), file);
    if (document.documentElement.tagName !== "Catalog") {
      throw new PatchPlanError(`Generated Catalog does not have a Catalog root: ${file}`);
    }
  }
  const includesPath = path.join(coreRoot, "Base.SC2Data", "GameData.xml");
  const includes = parseXml(await readFile(includesPath, "utf8"), includesPath);
  const included = new Set(
    elementChildren(includes.documentElement)
      .filter((element) => element.tagName === "Catalog")
      .map((element) => element.getAttribute("path").toLowerCase()),
  );
  for (const entry of await readdir(gameDataRoot, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith("data.xml")) {
      const expected = `gamedata/${entry.name}`.toLowerCase();
      if (!included.has(expected)) throw new PatchPlanError(`GameData.xml is missing Catalog include: ${expected}`);
    }
  }

  const manifestPath = path.join(coreRoot, "GameA.Core.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const modulePaths = new Set();
  const registeredFunctions = new Set();
  const galaxyFiles = [...(manifest.galaxy?.modules ?? [])];
  if (manifest.galaxy?.core) galaxyFiles.push({ path: manifest.galaxy.core });
  for (const module of galaxyFiles) {
    const normalized = String(module.path).replaceAll("\\", "/").toLowerCase();
    if (modulePaths.has(normalized)) throw new PatchPlanError(`Duplicate Galaxy module path: ${module.path}`);
    modulePaths.add(normalized);
    const galaxyPath = resolveCorePath(coreRoot, module.path);
    if (!(await exists(galaxyPath))) {
      throw new PatchPlanError(`Registered Galaxy module is missing: ${module.path}`);
    }
    validateGalaxySource(await readFile(galaxyPath, "utf8"), String(module.path));
    for (const [kind, functionName] of [["init", module.init], ["configure", module.configure]]) {
      if (!functionName) continue;
      if (registeredFunctions.has(functionName)) {
        throw new PatchPlanError(`Duplicate Galaxy ${kind} function: ${functionName}`);
      }
      registeredFunctions.add(functionName);
    }
  }
}

function runPowerShell(script, args, cwd) {
  const executable = process.platform === "win32" ? "powershell.exe" : "pwsh";
  const result = spawnSync(
    executable,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
    { cwd, encoding: "utf8", windowsHide: true, env: { ...process.env, COOPAGENT_WORKSPACE_ROOT: "", COOPAGENT_TEMPLATE_ROOT: "" } },
  );
  if (result.status !== 0) {
    throw new PatchPlanError(
      `Map Runtime validation command failed: ${path.basename(script)}`,
      [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean),
    );
  }
  return result.stdout.trim();
}

async function validateInGameASandbox(repoRoot, stagedCore) {
  const temporary = await mkdtemp(path.join(tmpdir(), "coopagent-game-a-check-"));
  const sourceGameA = path.join(repoRoot, "game-a");
  const sandboxGameA = path.join(temporary, "game-a");
  try {
    await cp(sourceGameA, sandboxGameA, {
      recursive: true,
      filter(source) {
        const relative = path.relative(sourceGameA, source).replaceAll("\\", "/");
        if (!relative) return true;
        return !(
          relative === "build" || relative.startsWith("build/") ||
          relative === "runtime" || relative.startsWith("runtime/") ||
          relative === "maps" || relative.startsWith("maps/") ||
          relative === "GameA.Sandbox.SC2Map" ||
          relative === "projects/GameA.SC2Map" || relative.startsWith("projects/GameA.SC2Map/")
        );
      },
    });
    const sandboxCore = path.join(sandboxGameA, "core", "GameA.SC2Mod");
    await rm(sandboxCore, { recursive: true, force: true });
    await cp(stagedCore, sandboxCore, { recursive: true });
    // Validation uses the staged core, with shared host inputs materialized only
    // in this disposable sandbox. Never inherit the live workspace override.
    if (applicationRoot(repoRoot) !== repoRoot) {
      await cp(path.join(APP_ROOT, 'game-a/scripts'), path.join(sandboxGameA, 'scripts'), { recursive: true });
      await cp(path.join(APP_ROOT, 'game-a/projects'), path.join(sandboxGameA, 'projects'), { recursive: true });
    }
    const scripts = path.join(sandboxGameA, "scripts");
    runPowerShell(path.join(scripts, "validate-game-a.ps1"), [], repoRoot);
    runPowerShell(path.join(scripts, "build-game-a.ps1"), ["-Check"], repoRoot);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function readStoredPlan(planPath) {
  if (!(await exists(planPath))) return null;
  return JSON.parse(await readFile(planPath, "utf8"));
}

function planForStorage(plan) {
  const schema = plan.formatVersion === 2
    ? "../../docs/schemas/patch-plan-v2.schema.json"
    : "../../docs/schemas/patch-plan.schema.json";
  return { ...plan, $schema: schema };
}

async function commitPlanAndCore({
  repoRoot, stagedCore, storedPlanPath, storedPlan, storedReceiptPath, receipt,
  changedFiles, writePlan, writeReceipt, transactionHooks,
}) {
  const entries = [];
  for (const relative of changedFiles) {
    const source = path.resolve(stagedCore, relative);
    if (!source.startsWith(`${path.resolve(stagedCore)}${path.sep}`)) {
      throw new PatchPlanError(`Invalid staged file: ${relative}`);
    }
    entries.push({
      target: `game-a/core/GameA.SC2Mod/${relative.replaceAll("\\", "/")}`,
      bytes: await exists(source) ? await readFile(source) : null,
    });
  }
  for (const [enabled, file, value] of [
    [writePlan, storedPlanPath, storedPlan],
    [writeReceipt, storedReceiptPath, receipt],
  ]) {
    if (enabled) entries.push({
      target: path.relative(repoRoot, file).replaceAll("\\", "/"),
      bytes: Buffer.from(`${JSON.stringify(value, null, 2)}\n`),
    });
  }
  return commitGameATransaction(repoRoot, { planId: receipt.planId, entries, hooks: transactionHooks });
}

export async function executePatchPlan({
  repoRoot,
  ...options
}) {
  return withGameALock(repoRoot, async () => {
    if (options.check) assertGameAReadable(repoRoot);
    else await recoverGameATransactionLocked(repoRoot);
    return executePatchPlanLocked({ repoRoot, ...options });
  });
}

// Internal composition entry point. The caller must hold withGameALock.
export async function executePatchPlanLocked({
  repoRoot,
  planPath,
  check = false,
  catalogRoot = null,
  databaseFile = null,
  expectedPlanSha256 = null,
  planContent = null,
  expectedCoreTreeAfterSha256 = null,
  preparationId = null,
  provenance = null,
  beforeCommit,
  runGameAValidation = true,
  transactionHooks,
}) {
  const resolvedRepo = path.resolve(repoRoot);
  const resolvedPlan = path.resolve(resolvedRepo, planPath);
  const schemaPath = path.join(applicationRoot(resolvedRepo), "docs", "schemas");
  const planBytes = planContent === null ? await readFile(resolvedPlan) : Buffer.from(planContent);
  const planSha256 = sha256(planBytes);
  if (expectedPlanSha256 && expectedPlanSha256.toLowerCase() !== planSha256) {
    throw new PatchPlanError("PatchPlan content changed before executor acquired the project lock");
  }
  const plan = JSON.parse(planBytes.toString("utf8"));
  await validatePatchPlan(plan, schemaPath);
  await assertCompatibility(resolvedRepo, plan);
  await assertPlanRelations(resolvedRepo, plan);

  const coreRoot = path.join(resolvedRepo, "game-a", "core", "GameA.SC2Mod");
  // Compose validators here (after module initialization); pure path/identity
  // helpers remain shared with the query projection. No MCP-only safety gate.
  const { reviewPatchPlan } = await import("../../runtime/coop-mcp/lib/patch-plan-review.mjs");
  const { openGameAArtifacts } = await import("../../runtime/coop-mcp/lib/game-a-artifacts.mjs");
  const { auditPatchArtifacts } = await import("./patch-plan-artifact-audit.mjs");
  databaseFile ??= catalogRoot ? path.join(path.dirname(path.dirname(path.resolve(catalogRoot))), "coop.sqlite") : null;
  const databaseAvailable = databaseFile && await exists(databaseFile);
  if (!databaseAvailable && (plan.scope?.kind === "commander" || plan.postconditions?.length)) {
    throw new PatchPlanError("Scoped/postcondition validation requires the local co-op Catalog database");
  }
  const requireValid = (review) => {
    if (review.summary.errorCount > 0) {
      const error = new PatchPlanError(`PatchPlan ${review.validationPhase} validation failed`,
        review.diagnostics.filter((item) => item.severity === "error").map((item) => `[${item.code}] ${item.message}`));
      error.review = review;
      throw error;
    }
    return review;
  };
  const preReview = requireValid(reviewPatchPlan(plan, { databaseFile, coreRoot, phase: "pre" }));
  const storedPlanPath = path.join(resolvedRepo, "game-a", "patches", `${plan.id}.patch-plan.json`);
  const storedReceiptPath = path.join(resolvedRepo, "game-a", "patches", `${plan.id}.receipt.json`);
  const storedPlan = planForStorage(plan);
  const existingPlan = await readStoredPlan(storedPlanPath);
  const existingReceipt = await readStoredPlan(storedReceiptPath);
  if (existingPlan && stableJson(existingPlan) !== stableJson(storedPlan)) {
    throw new PatchPlanError(`A different applied PatchPlan already uses id '${plan.id}'`);
  }
  if (plan.formatVersion === 2 && (!plan.scope || !plan.isolation) && !(existingPlan && existingReceipt)) {
    throw new PatchPlanError("New PatchPlan v2 must declare scope and isolation; only recorded historical plans may omit them");
  }

  // A migration needs its own receipt. Never silently rewrite historical output
  // while replaying a plan whose immutable receipt describes the old runtime.
  if (existingReceipt) {
    for (const operation of plan.operations) {
      if (operation.kind !== 'commander.stat.set' || !operation.prestigeUpgrade) continue;
      if (await legacyCommanderUpgradeHash(coreRoot, operation, commanderUpgradeArtifact(operation))) {
        throw new PatchPlanError(`Legacy prestige activation requires a new dependent PatchPlan (dependsOn: ${plan.id}); preserve the existing receipt and use the current scalar value as expect/value to repair activation only`);
      }
    }
  }

  // A compound plan can materialize an Actor and then customize it. Replaying
  // its intermediate clone step against the already-completed Actor would reject
  // those same-plan additions as foreign customization. Reuse ONLY an exact,
  // recorded final tree; drift and unrecorded partial applications still take the
  // normal path. All artifact, semantic and build checks below remain mandatory.
  const recordedFinalState = Boolean(existingPlan && existingReceipt
    && existingReceipt.planId === plan.id
    && existingReceipt.planSha256 === sha256(stableJson(storedPlan))
    && existingReceipt.coreTreeAfterSha256 === await treeHash(coreRoot)
    && stableJson(existingReceipt.operations?.map(op => [op.opId, op.kind]))
      === stableJson(plan.operations.map(op => [op.opId, op.kind])));

  const temporary = await mkdtemp(path.join(tmpdir(), `coopagent-patch-${plan.id}-`));
  const stagedCore = path.join(temporary, "GameA.SC2Mod");
  try {
    await cp(coreRoot, stagedCore, { recursive: true });
    const application = recordedFinalState
      ? { results: existingReceipt.operations.map(op => ({ ...op, status: "already" })), changedFiles: [] }
      : await applyPlanToCore({ coreRoot: stagedCore, plan, catalogRoot, databaseFile });
    await validateCoreStructure(stagedCore);
    const artifactAudit = await auditPatchArtifacts({ beforeCore: coreRoot, afterCore: stagedCore, plan, application });
    let review = preReview;
    if (databaseAvailable) {
      const artifacts = openGameAArtifacts({ repoRoot: resolvedRepo, coreRoot: stagedCore, databaseFile,
        commanderId: plan.scope?.kind === "commander" ? plan.scope.commanderId : null });
      try {
        review = requireValid(reviewPatchPlan(plan, { databaseFile, coreRoot: stagedCore, artifacts }));
      } finally { artifacts.close(); }
    }
    review = { ...review, artifactAudit };
    if (runGameAValidation) await validateInGameASandbox(resolvedRepo, stagedCore);
    const receipt = await buildReceipt({
      plan,
      application,
      beforeCore: coreRoot,
      afterCore: stagedCore,
    });
    if (expectedCoreTreeAfterSha256 && receipt.coreTreeAfterSha256 !== expectedCoreTreeAfterSha256) {
      throw new PatchPlanError("Prepared artifact changed; prepare the plan again before submitting");
    }
    if (projectIdentity(resolvedRepo)) receipt.projectId = projectIdentity(resolvedRepo);
    if (provenance) receipt.source = provenance;
    if (preparationId) receipt.preparationId = preparationId;
    if (!check && beforeCommit) await beforeCommit();

    if (!check && (!existingPlan || !existingReceipt || application.changedFiles.length > 0)) {
      await commitPlanAndCore({
        repoRoot: resolvedRepo,
        stagedCore,
        coreRoot,
        storedPlanPath,
        storedPlan,
        storedReceiptPath,
        receipt,
        changedFiles: application.changedFiles,
        writePlan: !existingPlan,
        writeReceipt: !existingReceipt,
        transactionHooks,
      });
    }
    return {
      id: plan.id,
      planSha256,
      review,
      mode: check ? "check" : "apply",
      operations: application.results,
      changedFiles: application.changedFiles,
      planRecord: path.relative(resolvedRepo, storedPlanPath).replaceAll("\\", "/"),
      planRecorded: !check && !existingPlan,
      receiptRecord: path.relative(resolvedRepo, storedReceiptPath).replaceAll("\\", "/"),
      receiptRecorded: !check && !existingReceipt,
      receipt,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function defaultRepoRoot() {
  return workspaceRoot();
}
