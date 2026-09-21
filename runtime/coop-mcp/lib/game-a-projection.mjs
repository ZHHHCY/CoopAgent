import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import {
  elementChildren, objectIdFor, mergeElement, flattenObject, catalogForClass,
  inferReferenceCatalog, dataReference,
} from "../../../scripts/lib/casc-database-builder.mjs";
import {
  commanderStatIdentity, inspectCatalogEditValue,
} from "../../../scripts/lib/patch-plan-executor.mjs";
import { normalizeUnitArrayFields } from "./unit-arrays.mjs";
import { attachEngineCatalog, fieldCoveredByEngine } from "../../../scripts/lib/engine-catalog-store.mjs";
import { canonicalEditPath, catalogClassBase } from "../../../scripts/lib/catalog-edit-contract.mjs";
import { masteryPointSelector } from '../../../scripts/lib/mastery-point-editor.mjs';
import { commanderEditRoute } from "../../../scripts/lib/commander-edit-policy.mjs";
import { readLinkedCommanderProfile, prestigeActivationId } from '../../../scripts/lib/coop-profile-rules.mjs';

const key = (catalog, id) => `${catalog}\0${id}`.toLowerCase();
export const canonicalFieldPath = (value) => String(value).replaceAll(".@", ".")
  .replace(/\[#(\d+)\]/g, "[$1]").toLowerCase();
// A single unindexed XML sibling is stored without an ordinal in SQLite.
const slotKey = (value) => canonicalFieldPath(value).replace(/\[0\]/g, "");
const scalar = (value) => typeof value === "string" && /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)
  ? Number(value) : value === "true" ? true : value === "false" ? false : value;
const serializer = new XMLSerializer();

function xml(source, file, root = null) {
  const errors = [];
  const document = new DOMParser({ onError: (level, message) => errors.push(`${level}: ${message}`) })
    .parseFromString(source, "application/xml");
  if (errors.length || !document?.documentElement || (root && document.documentElement.tagName !== root)) {
    throw new Error(`Cannot project Game A XML ${file}: ${errors.join("; ") || `expected ${root}`}`);
  }
  return document;
}

function applyFields(target, flattened, origin) {
  for (const prefix of flattened.removals) {
    const normalized = slotKey(prefix);
    for (const fieldPath of target.keys()) {
      const candidate = slotKey(fieldPath);
      if (candidate === normalized || candidate.startsWith(`${normalized}.`)) target.delete(fieldPath);
    }
  }
  for (const field of flattened.fields.values()) {
    for (const fieldPath of target.keys()) {
      if (slotKey(fieldPath) === slotKey(field.path)) target.delete(fieldPath);
    }
    target.set(field.path, { ...field, ...origin });
  }
}

/** Connection-local, in-memory overlay. Caller holds a Game A shared lock for
 * its entire synchronous query. The main SQLite database must be read-only.
 * No cache survives the connection and no extracted database is copied. */
export function attachGameAProjection(database, {
  repoRoot, commanderId = null, prestigeUpgrade = null, coreRoot = path.join(repoRoot, "game-a/core/GameA.SC2Mod"),
}) {
  const engineBaseline = attachEngineCatalog(database);
  const catalogNames = new Map(database.prepare("SELECT DISTINCT catalog FROM main.catalog_objects")
    .all().map(({ catalog }) => [catalog.toLowerCase(), catalog]));
  const officialObject = database.prepare("SELECT * FROM main.catalog_objects WHERE catalog=? AND object_id=?");
  const officialFields = database.prepare("SELECT * FROM _baseline_catalog_fields WHERE catalog=? AND object_id=?");
  const legacyFields = database.prepare("SELECT * FROM main.catalog_fields WHERE catalog=? AND object_id=?");
  const children = database.prepare("SELECT * FROM main.catalog_objects WHERE catalog=? AND parent_id=?");
  const core = new Map();
  const coreDocuments = new Map();
  const affected = new Map();
  const fieldsCache = new Map();
  const warnings = [];
  const includeFile = path.join(coreRoot, "Base.SC2Data/GameData.xml");
  let executorLayoutSupported = true;
  if (existsSync(includeFile)) {
    const includes = xml(readFileSync(includeFile, "utf8"), includeFile, "Includes");
    const physicalRoot = realpathSync(coreRoot);
    for (const include of elementChildren(includes.documentElement)) {
      if (include.tagName !== "Catalog") continue;
      const relative = include.getAttribute("path").replaceAll("\\", "/");
      const file = path.resolve(coreRoot, "Base.SC2Data", relative);
      if (!file.startsWith(`${coreRoot}${path.sep}`) || !realpathSync(file).startsWith(`${physicalRoot}${path.sep}`)) {
        throw new Error(`Game A Catalog include escapes core: ${relative}`);
      }
      const sourceFile = path.relative(repoRoot, file).replaceAll("\\", "/");
      const document = xml(readFileSync(file, "utf8"), sourceFile, "Catalog");
      for (const element of elementChildren(document.documentElement)) {
        const catalog = catalogForClass(element.tagName, catalogNames);
        if (catalog === "Unknown") throw new Error(`Unknown Game A Catalog class: ${element.tagName}`);
        if (relative.toLowerCase() !== `gamedata/${catalog.toLowerCase()}data.xml`) executorLayoutSupported = false;
        const id = objectIdFor(element);
        const objectKey = key(catalog, id);
        const previous = core.get(objectKey);
        if (previous) {
          executorLayoutSupported = false;
          previous.patches.push({ element, sourceFile });
          mergeElement(previous.element, element);
        } else {
          core.set(objectKey, { catalog, id, element: element.cloneNode(true), sourceFile,
            patches: [{ element, sourceFile }] });
        }
      }
    }
  }
  for (const entry of core.values()) {
    if (!coreDocuments.has(entry.catalog)) coreDocuments.set(entry.catalog, xml("<Catalog/>", "projection"));
    coreDocuments.get(entry.catalog).documentElement.appendChild(entry.element.cloneNode(true));
    affected.set(key(entry.catalog, entry.id), { catalog: entry.catalog, object_id: entry.id });
    if (entry.id.startsWith("@default:")) {
      for (const row of database.prepare("SELECT * FROM main.catalog_objects WHERE catalog=? AND class=?")
        .all(entry.catalog, entry.element.tagName)) affected.set(key(row.catalog, row.object_id), row);
    }
  }
  // Descendants must see a changed parent's Catalog values, but must never
  // inherit player Upgrade effects (those are applied in a separate final pass).
  for (const row of affected.values()) {
    for (const child of children.all(row.catalog, row.object_id)) {
      if (!affected.has(key(child.catalog, child.object_id))) affected.set(key(child.catalog, child.object_id), child);
    }
  }

  const unavailableEngine = new Set();
  for (const row of affected.values()) {
    const base = officialObject.get(row.catalog, row.object_id);
    if (engineBaseline.coverage(row.catalog, row.object_id).length && base &&
      ((base.parent_id && affected.has(key(row.catalog, base.parent_id))) || core.has(key(row.catalog, `@default:${base.class}`)))) {
      unavailableEngine.add(key(row.catalog, row.object_id));
      warnings.push({ code: "engine-baseline-parent-edited", catalog: row.catalog, objectId: row.object_id,
        message: "Engine baseline cannot prove propagation from this edited parent/default; current projection remains interpreted." });
    }
  }
  function rawFields(catalog, id, forceEngine = false) {
    const statement = !forceEngine && unavailableEngine.has(key(catalog, id)) ? legacyFields : officialFields;
    const className = officialObject.get(catalog, id)?.class;
    const baseClass = catalogClassBase(className);
    const rows = [...(baseClass ? statement.all(catalog, `@default:${baseClass}`).map(row => ({ ...row, inheritance_depth: row.inheritance_depth + 1 })) : []), ...statement.all(catalog, id)];
    return new Map(rows.map((row) => [row.path, {
      path: row.path, value: row.value, fieldTag: row.field_tag, attribute: row.attribute,
      sourceFile: row.source_file, originObjectId: row.origin_object_id, inheritanceDepth: row.inheritance_depth,
    }]));
  }

  function object(catalog, id) {
    const local = core.get(key(catalog, id));
    const base = officialObject.get(catalog, id);
    if (!local) return base;
    return { ...base, catalog, object_id: id, class: local.element.tagName,
      parent_id: local.element.hasAttribute("parent") ? local.element.getAttribute("parent") : base?.parent_id ?? null,
      is_default: local.element.getAttribute("default") === "1" ? 1 : base?.is_default ?? 0,
      source_file: local.sourceFile, direct_xml: serializer.serializeToString(local.element) };
  }

  function effective(catalog, id, visiting = new Set()) {
    const objectKey = key(catalog, id);
    if (fieldsCache.has(objectKey)) return fieldsCache.get(objectKey);
    if (!affected.has(objectKey)) return rawFields(catalog, id);
    if (visiting.has(objectKey)) throw new Error(`Game A Catalog inheritance cycle: ${catalog}/${id}`);
    visiting = new Set(visiting).add(objectKey);
    const row = object(catalog, id);
    let result = new Map();
    const inherit = (parent) => {
      for (const field of effective(catalog, parent, visiting).values()) {
        result.set(field.path, { ...field, inheritanceDepth: field.inheritanceDepth + 1 });
      }
    };
    if (row && id !== `@default:${row.class}`) inherit(`@default:${row.class}`);
    if (row?.parent_id) inherit(row.parent_id);
    const base = officialObject.get(catalog, id);
    if (base) {
      if (!unavailableEngine.has(objectKey)) {
        for (const query of engineBaseline.coverage(catalog, id)) {
          for (const fieldPath of result.keys()) if (fieldCoveredByEngine(fieldPath, query)) result.delete(fieldPath);
        }
      }
      // Retain direct dependency precedence and its recorded provenance.
      if (base.direct_xml) applyFields(result,
        { fields: new Map(), removals: flattenObject(xml(base.direct_xml, base.source_file).documentElement).removals }, {});
      for (const field of rawFields(catalog, id).values()) {
        if (field.originObjectId === id) applyFields(result, { fields: new Map([[field.path, field]]), removals: [] }, {});
      }
    }
    if (catalog === "Unit") result = normalizeUnitArrayFields(result);
    for (const patch of core.get(objectKey)?.patches ?? []) {
      applyFields(result, flattenObject(patch.element), {
        sourceFile: patch.sourceFile, originObjectId: id, inheritanceDepth: 0,
      });
    }
    fieldsCache.set(objectKey, result);
    return result;
  }

  const applied = [];
  const patchesRoot = path.join(repoRoot, "game-a/patches");
  if (existsSync(patchesRoot)) {
    for (const name of readdirSync(patchesRoot).filter((name) => name.endsWith(".receipt.json")).sort()) {
      const receipt = JSON.parse(readFileSync(path.join(patchesRoot, name), "utf8"));
      if (`${receipt.planId}.receipt.json` !== name) throw new Error(`Invalid receipt identity: ${name}`);
      const planFile = path.join(patchesRoot, `${receipt.planId}.patch-plan.json`);
      if (!existsSync(planFile)) { warnings.push({ code: "applied-plan-unavailable", planId: receipt.planId }); continue; }
      const plan = JSON.parse(readFileSync(planFile, "utf8"));
      if (plan.id !== receipt.planId) throw new Error(`Plan/receipt identity mismatch: ${name}`);
      for (const operation of plan.operations ?? []) {
        if ((receipt.operations ?? []).some((entry) => entry.opId === operation.opId)) {
          applied.push({ operation, planId: plan.id, appliedAt: receipt.appliedAt ?? "", scope: plan.scope ?? null });
        }
      }
    }
  }
  applied.sort((left, right) => left.appliedAt.localeCompare(right.appliedAt) || left.planId.localeCompare(right.planId));
  const commander = commanderId ? database.prepare(
    "SELECT id FROM commanders WHERE lower(id)=lower(?) OR lower(commander_object_id)=lower(?)",
  ).get(commanderId, commanderId) : null;
  if (commanderId && !commander) throw new Error(`Unknown commanderId: ${commanderId}`);
  if (prestigeUpgrade) {
    const row = commander && database.prepare('SELECT profile_json FROM commander_profiles WHERE commander_id=?').get(commander.id);
    if (!row || !(readLinkedCommanderProfile(database,commander.id,JSON.parse(row.profile_json)).prestiges ?? []).some(p => prestigeActivationId(database,p) === prestigeUpgrade)) {
      throw new Error('prestigeUpgrade requires its owning commanderId and a prestige ID from commander.get.');
    }
  }
  const scoped = new Map();
  for (const { operation, planId } of applied) {
    if (operation.kind !== "commander.stat.set" || operation.commanderId !== commander?.id) continue;
    if (operation.prestigeUpgrade && operation.prestigeUpgrade !== prestigeUpgrade) continue;
    const identity = commanderStatIdentity(operation);
    const upgrade = core.get(key("Upgrade", identity.upgradeId));
    const effect = upgrade && elementChildren(upgrade.element).find((element) =>
      element.tagName === "EffectArray" && element.getAttribute("Reference") === identity.reference);
    if (!effect?.hasAttribute("Value")) continue;
    const target = key(operation.catalog, operation.object) + "\0" + canonicalFieldPath(operation.path);
    const values = scoped.get(target) ?? new Map();
    values.set(identity.upgradeId, { ...identity, operation, planId,
      value: effect.getAttribute("Value"), sourceFile: upgrade.sourceFile });
    scoped.set(target, values);
  }
  // Receipts identify history, never replace the actual current Upgrade value.
  // Also recognize generated stats with missing plan records using the same
  // identity function as the executor (e.g. an older/imported project).
  if (commander) for (const upgrade of core.values()) {
    if (upgrade.catalog !== "Upgrade" || !upgrade.id.startsWith("GameACommanderStat")) continue;
    for (const effect of elementChildren(upgrade.element)) {
      if (effect.tagName !== "EffectArray" || !effect.hasAttribute("Value")) continue;
      const reference = dataReference({ value: effect.getAttribute("Reference") }, catalogNames);
      if (!reference) continue;
      const paths = new Set([reference.targetFieldPath]);
      for (const field of effective(reference.catalog, reference.objectId).values()) {
        if (canonicalFieldPath(field.path) === canonicalFieldPath(reference.targetFieldPath) && !field.path.includes("[#")) paths.add(field.path);
      }
      for (const fieldPath of paths) for (const condition of [null, ...(prestigeUpgrade ? [prestigeUpgrade] : [])]) {
        const operation = { kind: "commander.stat.set", commanderId: commander.id,
          ...(condition ? { prestigeUpgrade: condition } : {}),
          catalog: reference.catalog, object: reference.objectId, path: fieldPath };
        const identity = commanderStatIdentity(operation);
        if (identity.upgradeId !== upgrade.id) continue;
        const target = key(operation.catalog, operation.object) + "\0" + canonicalFieldPath(operation.path);
        const values = scoped.get(target) ?? new Map();
        if (!values.has(upgrade.id)) values.set(upgrade.id, { ...identity, operation, planId: null,
          value: effect.getAttribute("Value"), sourceFile: upgrade.sourceFile });
        scoped.set(target, values);
      }
    }
  }

  database.exec("PRAGMA query_only=OFF");
  for (const [name, keys] of [
    ["catalog_objects", "catalog,object_id"], ["catalog_fields", "catalog,object_id,path"],
    ["object_references", "source_catalog,source_object_id,field_path,target_catalog,target_object_id"],
    ["localized_text", "locale,text_key"],
  ]) {
    database.exec(`CREATE TEMP TABLE _gamea_${name} AS SELECT * FROM main.${name} WHERE 0;
      CREATE UNIQUE INDEX _gamea_${name}_key ON _gamea_${name}(${keys});`);
  }
  const putObject = database.prepare(`INSERT OR REPLACE INTO _gamea_catalog_objects
    (catalog,object_id,class,parent_id,is_default,source_file,direct_xml) VALUES (?,?,?,?,?,?,?)`);
  const putField = database.prepare(`INSERT OR REPLACE INTO _gamea_catalog_fields
    (catalog,object_id,path,value,field_tag,attribute,source_file,origin_object_id,inheritance_depth)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  // Resolve all Catalog inheritance before adding player-scoped values.
  for (const row of affected.values()) effective(row.catalog, row.object_id);
  for (const values of scoped.values()) {
    const entry = values.values().next().value;
    const { catalog, object: id } = entry.operation;
    if (!object(catalog, id)) continue;
    if (!fieldsCache.has(key(catalog, id))) fieldsCache.set(key(catalog, id), rawFields(catalog, id));
    affected.set(key(catalog, id), { catalog, object_id: id });
  }
  for (const row of affected.values()) {
    const resolved = object(row.catalog, row.object_id);
    putObject.run(resolved.catalog, resolved.object_id, resolved.class, resolved.parent_id,
      resolved.is_default, resolved.source_file, resolved.direct_xml);
    const fields = new Map(effective(row.catalog, row.object_id));
    for (const [target, values] of scoped) {
      if (!target.startsWith(`${key(row.catalog, row.object_id)}\0`)) continue;
      const entry = values.values().next().value;
      if (values.size !== 1) {
        warnings.push({ code: "multiple-scoped-upgrades", target, upgradeIds: [...values.keys()] });
        // Do not silently substitute the official value for an ambiguous edit.
        for (const fieldPath of fields.keys()) if (canonicalFieldPath(fieldPath) === canonicalFieldPath(entry.operation.path)) fields.delete(fieldPath);
        continue;
      }
      const previous = [...fields.values()].find((field) => canonicalFieldPath(field.path) === canonicalFieldPath(entry.operation.path));
      const field = { path: previous?.path ?? entry.operation.path, value: entry.value,
        fieldTag: previous?.fieldTag ?? entry.operation.path.split(/[.[\]]/).at(-1),
        attribute: previous?.attribute ?? "value" };
      applyFields(fields, { fields: new Map([[field.path, field]]), removals: [] }, {
        sourceFile: entry.sourceFile, originObjectId: entry.upgradeId, inheritanceDepth: 0,
      });
    }
    for (const field of fields.values()) putField.run(row.catalog, row.object_id, field.path,
      field.value, field.fieldTag, field.attribute, field.sourceFile, field.originObjectId, field.inheritanceDepth);
  }
  for (const [name, predicate] of [
    ["catalog_objects", "g.catalog=m.catalog AND g.object_id=m.object_id"],
    ["catalog_fields", "g.catalog=m.catalog AND g.object_id=m.object_id"],
    ["object_references", "g.catalog=m.source_catalog AND g.object_id=m.source_object_id"],
  ]) database.exec(`${name === "catalog_objects" ? "" : `DROP VIEW temp.${name};`}
    CREATE TEMP VIEW ${name} AS SELECT m.* FROM ${name === "catalog_objects" ? "main.catalog_objects" : `_baseline_${name}`} m
    WHERE NOT EXISTS (SELECT 1 FROM _gamea_catalog_objects g WHERE ${predicate})
    UNION ALL SELECT * FROM _gamea_${name}`);

  const putReference = database.prepare("INSERT OR IGNORE INTO _gamea_object_references VALUES (?,?,?,?,?,?,?)");
  const findTarget = database.prepare("SELECT catalog,object_id FROM catalog_objects WHERE catalog=? AND object_id=?");
  const oldReferences = database.prepare("SELECT * FROM _baseline_object_references WHERE source_catalog=? AND source_object_id=?");
  for (const row of affected.values()) {
    const projectedFields = database.prepare("SELECT * FROM _gamea_catalog_fields WHERE catalog=? AND object_id=?")
      .all(row.catalog, row.object_id);
    const baseFields = rawFields(row.catalog, row.object_id);
    for (const ref of oldReferences.all(row.catalog, row.object_id)) {
      if (projectedFields.some((field) => field.path === ref.field_path && field.value === baseFields.get(field.path)?.value)) {
        putReference.run(ref.source_catalog, ref.source_object_id, ref.field_path, ref.target_catalog,
          ref.target_object_id, ref.confidence, ref.evidence);
      }
    }
    for (const rowField of projectedFields) {
      const field = { path: rowField.path, value: rowField.value, fieldTag: rowField.field_tag, attribute: rowField.attribute };
      const reference = dataReference(field, catalogNames);
      const hinted = inferReferenceCatalog(field, catalogNames, {
        catalog: row.catalog, element: { tagName: object(row.catalog, row.object_id).class },
      });
      const targetCatalog = reference?.catalog ?? catalogNames.get(hinted?.toLowerCase());
      let targetId = reference?.objectId ?? field.value;
      if (targetCatalog === "Abil" && /abilcmd/i.test(field.path)) targetId = targetId.split(",")[0];
      if (!targetCatalog || !findTarget.get(targetCatalog, targetId)) continue;
      putReference.run(row.catalog, row.object_id, field.path, targetCatalog, targetId, 1,
        reference ? `data-reference:${reference.targetFieldPath}` : "game-a-field-hint");
    }
  }
  const putText = database.prepare("INSERT OR REPLACE INTO _gamea_localized_text (locale,text_key,value,source_file) VALUES (?,?,?,?)");
  if (existsSync(coreRoot)) for (const name of readdirSync(coreRoot).filter((name) => /^[a-z]{4}\.SC2Data$/i.test(name))) {
    const file = path.join(coreRoot, name, "LocalizedData/GameStrings.txt");
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
      const equal = line.indexOf("=");
      if (equal > 0 && !line.startsWith("//")) putText.run(name.slice(0, 4).toLowerCase(),
        line.slice(0, equal), line.slice(equal + 1), path.relative(repoRoot, file).replaceAll("\\", "/"));
    }
  }
  database.exec(`CREATE TEMP VIEW localized_text AS SELECT m.* FROM main.localized_text m
    WHERE NOT EXISTS (SELECT 1 FROM _gamea_localized_text g WHERE lower(g.locale)=lower(m.locale) AND g.text_key=m.text_key)
    UNION ALL SELECT * FROM _gamea_localized_text; PRAGMA query_only=ON`);

  function inspect(catalog, id, requestedPath) {
    const className = object(catalog, id)?.class;
    requestedPath = canonicalEditPath(className, requestedPath);
    const masterySelector = className === 'CUser' ? masteryPointSelector(requestedPath) : null;
    const fieldCandidates = (fields) => {
      let candidates = [...fields.values()].filter((field) => masterySelector
        ? slotKey(field.path) === slotKey(masterySelector.physicalPath)
        : canonicalFieldPath(canonicalEditPath(className, field.path)) === canonicalFieldPath(requestedPath));
      // Explicit indexed overrides take precedence over ordinal source evidence.
      if (candidates.some(field => !field.path.includes('[#'))) candidates = candidates.filter(field => !field.path.includes('[#'));
      return candidates;
    };
    const getField = (fields) => {
      const candidates=fieldCandidates(fields);
      return candidates.length === 1 ? { ...candidates[0], value: scalar(candidates[0].value),
        valueSource: candidates[0].sourceFile?.startsWith('engine:') ? 'sc2-engine'
          : candidates[0].sourceFile?.startsWith('game-a/') ? 'game-a-projection' : 'legacy-interpreted',
        ...(candidates[0].sourceFile?.startsWith('engine:')
          ? { inheritanceKnown: false, snapshotId: candidates[0].sourceFile.slice(7) } : {}) } : null;
    };
    const official = getField(rawFields(catalog, id, true));
    const coreField = getField(effective(catalog, id));
    const values = scoped.get(`${key(catalog, id)}\0${canonicalFieldPath(requestedPath)}`);
    const entries = [...(values?.values() ?? [])];
    const entry = entries.length === 1 ? entries[0] : null;
    // Editing an Upgrade's operand changes that upgrade's effect definition.
    // A player Set targeting Upgrade.EffectArray is a different runtime design,
    // not the default representation of a mastery/research coefficient edit.
    const playerValue = commander && !['CUpgrade', 'CCommander', 'CUser'].includes(className);
    const operation = entry ? { ...entry.operation } : {
      kind: playerValue ? "commander.stat.set" : "catalog.set",
      ...(playerValue ? { commanderId: commander.id } : {}), catalog, object: id,
      ...(playerValue && prestigeUpgrade ? { prestigeUpgrade } : {}),
      path: className === 'CUpgrade' || masterySelector ? requestedPath : requestedPath.replaceAll(".@", "."),
    };
    // Preserve the established data-reference spelling for player Sets and
    // older Catalog callers. Ability Cost attributes need their physical XML
    // address when offered as a direct Catalog alternative.
    const catalogOperation = { kind: "catalog.set", catalog, object: id,
      path: /^CAbil/.test(className ?? '') && /^Cost\[\d+\]\./.test(requestedPath)
        ? requestedPath : operation.path };
    const baseDocument = xml("<Catalog/>", "official-projection");
    const loaded = new Map();
    const loadBase = (objectId) => {
      if (loaded.has(objectId)) return loaded.get(objectId);
      const row = officialObject.get(catalog, objectId);
      if (!row?.direct_xml) return null;
      const element = xml(row.direct_xml, row.source_file).documentElement;
      loaded.set(objectId, element);
      baseDocument.documentElement.appendChild(element);
      if (row.parent_id) loadBase(row.parent_id);
      if (objectId !== `@default:${row.class}`) loadBase(`@default:${row.class}`);
      if (catalogClassBase(row.class)) loadBase(`@default:${catalogClassBase(row.class)}`);
      return element;
    };
    let baseObject = loadBase(id);
    let local = core.get(key(catalog, id));
    const seen = new Set();
    if (!baseObject) while (local?.element.getAttribute("parent")) {
      const parentId = local.element.getAttribute("parent");
      if (seen.has(parentId)) break;
      seen.add(parentId);
      const localParent = core.get(key(catalog, parentId));
      if (localParent) local = localParent;
      else { baseObject = loadBase(parentId); break; }
    }
    let edit = { exists: false, value: null, source: "unknown" };
    if (!requestedPath.includes("[#") && executorLayoutSupported) {
      const inheritedEngine = baseObject ? getField(rawFields(catalog, baseObject.getAttribute('id'), true)) : null;
      edit = inspectCatalogEditValue({ coreDocument: coreDocuments.get(catalog),
        coreObject: core.get(key(catalog, id))?.element, baseDocument, baseObject, catalogPath: operation.path,
        engineField: inheritedEngine?.valueSource === 'sc2-engine' ? inheritedEngine : undefined,
        // The Cost positional adapter is the only reviewed layout where one
        // dependency layer may author the record and another layer only a
        // sibling member. Do not turn arbitrary flattened fields into writes.
        projectedField: /^CAbil/.test(className ?? '') && /^Cost\[\d+\]\./.test(requestedPath)
          ? official : undefined });
    }
    const metadataOwner = edit.ownerCommanderId ?? (className === 'CCommander' && /^MasteryTalentArray\[\d+\]\.ValuePerRank$/.test(requestedPath)
      ? database.prepare('SELECT id FROM commanders WHERE commander_object_id=?').get(id)?.id : null);
    if(commander && metadataOwner && commander.id!==metadataOwner)edit.writeSupport={supported:false,reason:'mastery-scope-mismatch',
      message:`This mastery metadata belongs to ${metadataOwner}, outside the selected commander ${commander.id}. Query its actual owner or explicitly request global scope.`};
    const catalogAvailable = edit.writeSupport?.supported !== false && edit.exists && coreField !== null && scalar(edit.value) === coreField.value;
    const catalogReason = edit.writeSupport?.supported === false ? edit.writeSupport.reason : catalogAvailable ? null : edit.exists
      ? "catalog-projection-executor-disagree" : "executor-value-unresolved";
    const readDiagnostic = !catalogAvailable && edit.writeSupport?.supported !== false ? {
      reason:catalogReason,
      projectedCandidates:fieldCandidates(effective(catalog,id)).slice(0,16).map(field=>({path:field.path,value:scalar(field.value),
        sourceFile:field.sourceFile,originObjectId:field.originObjectId,inheritanceDepth:field.inheritanceDepth})),
      candidatesTruncated:fieldCandidates(effective(catalog,id)).length>16,
      executorCandidate:{exists:edit.exists,value:scalar(edit.value),source:edit.source},
      boundary:'These are conflicting or incomplete source observations, not a resolved current value or writable expect. Repeating this exact read in the unchanged context will not resolve it. This diagnostic concerns this target field; an existing Upgrade operand has its own independent edit evidence.'
    } : null;
    const catalogEdit = { available: catalogAvailable, source: edit.source, reason: catalogReason,
      ...(edit.writeSupport?.supported === false ? { diagnostic: edit.writeSupport } : {}),
      operation: catalogOperation,
      ...(catalogAvailable ? { expect: scalar(edit.value) } : {}) };
    if (entry && executorLayoutSupported && !requestedPath.includes("[#")) {
      edit = { exists: true, value: entry.value, source: "commander-upgrade" };
    }
    if (!entry && typeof scalar(edit.value) !== "number") {
      operation.kind = "catalog.set";
      delete operation.commanderId;
    }
    const enginePropagationUnknown = unavailableEngine.has(key(catalog, id));
    if (enginePropagationUnknown) {
      catalogEdit.available = false;
      catalogEdit.reason = "engine-baseline-parent-edited";
      delete catalogEdit.expect;
    }
    const available = !enginePropagationUnknown && edit.exists && entries.length <= 1 && (entry !== null || catalogAvailable);
    const scope = commander ? { kind: "commander", commanderId: commander.id } : { kind: "catalog", commanderId: null };
    const authoringRoute = commanderEditRoute({ scope, catalog, objectId: id, className,
      path: operation.path, value: coreField?.value, existingScopedEdit: entry !== null,
      localObject: core.has(key(catalog, id)) && !officialObject.get(catalog, id) });
    return {
      officialBaseline: official, coreCatalog: coreField,
      ...(readDiagnostic?{readDiagnostic}:{}),
      authoringRoute,
      ...(operation.kind === 'catalog.set' && commander ? { scopeNote:
        ['CCommander', 'CUser'].includes(className)
          ? 'This edits commander metadata at the Catalog layer. Verify the linked commander/instance identity and preserve other talents and point limits; this does not change gameplay operands or prove rendered UI behavior.'
          : className === 'CUpgrade'
          ? 'This edits the existing upgrade definition. Check its activation and consumers for the requested scope; preserve Reference/Operation and unrelated entries. A commander context does not prove private ownership. Do not replace this with a player Set on the Upgrade operand merely to express commander scope.'
          : 'catalog.set is a Catalog-layer edit, NOT a requirement to edit every player. For a commander-only structural change, inspect the actual Unit owner with impact.analyze(changeType=structural, includeIsolationPlan=true), clone the changed owner/dependencies, and set the private objects. A missing commander.stat.set route does not prove that a scoped solution is impossible.' } : {}),
      commanderPatch: entry ? { value: scalar(entry.value), commanderId: commander.id,
        upgradeId: entry.upgradeId, sourceFile: entry.sourceFile, planId: entry.planId } : null,
      scope,
      runtimeValue: { known: false, reason: "Research, Buffs, Galaxy and in-game activation are not evaluated." },
      catalogEdit,
      edit: { available, source: edit.source,
        recommended: available && authoringRoute.strategy === 'player-upgrade' && operation.kind === 'commander.stat.set',
        operation: { kind: operation.kind, ...(operation.commanderId ? { commanderId: operation.commanderId } : {}),
          ...(operation.kind === 'commander.stat.set' && operation.prestigeUpgrade ? { prestigeUpgrade: operation.prestigeUpgrade } : {}),
          catalog: operation.catalog, object: operation.object, path: operation.path },
        ...(available ? { expect: scalar(edit.value) } : {}),
        reason: available ? null : enginePropagationUnknown ? "engine-baseline-parent-edited" : entries.length > 1 ? "multiple-scoped-upgrades" : catalogReason },
    };
  }
  return { inspect, applied, catalogFields: effective, metadata: {
    kind: "current-edit-state", commanderId: commander?.id ?? null, prestigeUpgrade,
    localObjectCount: [...core.values()].filter((entry) => !officialObject.get(entry.catalog, entry.id)).length,
    affectedObjectCount: affected.size, runtimeValuesEvaluated: false, warnings,
    baseline: engineBaseline.status,
  } };
}
