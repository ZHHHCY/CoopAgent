import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { elementChildren, flattenObject } from "./casc-database-builder.mjs";
import { commanderUpgradeArtifact, PatchPlanError } from "./patch-plan-executor.mjs";
import { masteryPointSelector } from './mastery-point-editor.mjs';

const normalized = (value) => String(value).replaceAll(".@", ".").replace(/\[#(\d+)\]/g, "[$1]")
  .replace(/^(EffectArray\[\d+\])\.Value$/, '$1');
const covers = (target, field) => target === "*" || field === target || field.startsWith(`${target}.`)
  || (target.endsWith("[*]") && field.startsWith(`${target.slice(0, -3)}[`));
const read = async (root, file) => readFile(path.join(root, file), "utf8").catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
const bytes = async (root, file) => readFile(path.join(root, file)).catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
const stable = (value) => JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === "object"
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const strings = (source) => new Map((source ?? "").replace(/^\uFEFF/, "").split(/\r?\n/)
  .filter((line) => line.indexOf("=") > 0 && !line.startsWith("//"))
  .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
async function files(root, relative = "") {
  const result = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new PatchPlanError(`Artifact contains a symbolic link: ${child}`);
    if (entry.isDirectory()) result.push(...await files(root, child));
    else if (entry.isFile()) result.push(child);
  }
  return result;
}
function document(source) {
  return new DOMParser({ onError: (level, message) => { throw new Error(`${level}: ${message}`); } })
    .parseFromString(source ?? "<Catalog/>", "application/xml");
}
function objects(source) {
  return new Map(elementChildren(document(source).documentElement)
    .map((element) => [element.getAttribute("id") || `@default:${element.tagName}`, element]));
}
function fields(element) {
  if (!element) return new Map();
  const flattened = flattenObject(element);
  const result = new Map([...flattened.fields.values()].map((row) => [normalized(row.path), row.value]));
  for (const removal of flattened.removals) result.set(normalized(removal), "<removed>");
  for (let i = 0; i < element.attributes.length; i++) {
    const attr = element.attributes.item(i);
    if (attr.name !== "id") result.set(`@${attr.name}`, attr.value);
  }
  return result;
}

/** Diff the files, not the writer's report; reject writes outside the compiled
 * operation footprint, even when the plan declares no postconditions. */
export async function auditPatchArtifacts({ beforeCore, afterCore, plan, application }) {
  const allowedFiles = new Set();
  const allowedObjects = new Map();
  const generated = new Map();
  const identityFields = new Map();
  const authorize = (catalog, id, target = "*") => {
    allowedFiles.add(`Base.SC2Data/GameData/${catalog}Data.xml`);
    allowedFiles.add("Base.SC2Data/GameData.xml");
    const key = `${catalog}/${id}`;
    allowedObjects.set(key, [...(allowedObjects.get(key) ?? []), normalized(target)]);
  };
  for (const op of plan.operations) {
    if (op.kind.startsWith("catalog.")) {
      const mastery = op.kind === 'catalog.set' && op.catalog === 'User' && op.object === 'MasteryUpgrades' ? masteryPointSelector(op.path) : null;
      if (mastery) {
        authorize(op.catalog, op.object, mastery.physicalPath);
        identityFields.set(`User/MasteryUpgrades/Instances[${mastery.index}].Id`, mastery.instanceId);
        identityFields.set(`User/MasteryUpgrades/Instances[${mastery.index}].Fixed[0].Field.Id`, 'PointIncrement');
        continue;
      }
      const target = ["catalog.clone", "catalog.create"].includes(op.kind) ? "*"
        : op.kind === "catalog.insert" ? `${op.path}[${op.index}]`
        : op.kind === "catalog.clear" ? `${op.path}[*]` : op.path;
      authorize(op.catalog, op.object, target);
    } else if (["commander.stat.set", "commander.unit.clone"].includes(op.kind)) {
      const artifact = commanderUpgradeArtifact(op);
      generated.set(artifact.upgradeId, { artifact, operation: op });
      authorize("Upgrade", artifact.upgradeId);
      allowedFiles.add(artifact.path);
      allowedFiles.add("GameA.Core.json");
      if (op.kind === "commander.unit.clone") {
        authorize("Unit", op.unitId);
        authorize("Actor", op.actorId ?? op.unitId);
      }
    } else if (op.kind === "galaxy.source") {
      allowedFiles.add(op.path);
      allowedFiles.add("GameA.Core.json");
    } else if (op.kind === "locale.set") {
      allowedFiles.add(`${op.locale}.SC2Data/LocalizedData/GameStrings.txt`);
    } else if (op.kind === "file.patch") allowedFiles.add(op.path);
  }
  const changed = [];
  for (const file of [...new Set([...await files(beforeCore), ...await files(afterCore)])].sort()) {
    const [leftBytes, rightBytes] = await Promise.all([bytes(beforeCore, file), bytes(afterCore, file)]);
    if (leftBytes?.equals(rightBytes ?? Buffer.alloc(0)) || (!leftBytes && !rightBytes)) continue;
    const before = leftBytes?.toString("utf8") ?? null;
    const after = rightBytes?.toString("utf8") ?? null;
    changed.push(file);
    if (!allowedFiles.has(file)) throw new PatchPlanError(`Undeclared artifact file change: ${file}`);
    // Legacy exact-file patches have an explicit byte/hash contract.
    if (plan.operations.some((op) => op.kind === "file.patch" && op.path === file)) continue;
    if (file === "GameA.Core.json") {
      const previous = JSON.parse(before);
      const next = JSON.parse(after);
      const authorizedModules = new Map([...generated.values()].map(({ artifact }) => [artifact.path,
        { path: artifact.path, order: 300, configure: artifact.configure }]));
      for (const op of plan.operations.filter((op) => op.kind === "galaxy.source")) {
        authorizedModules.set(op.path, { path: op.path, ...op.register });
      }
      const oldModules = new Map(previous.galaxy.modules.map((module) => [module.path, module]));
      const nextModules = new Map(next.galaxy.modules.map((module) => [module.path, module]));
      for (const name of new Set([...oldModules.keys(), ...nextModules.keys()])) {
        if (stable(oldModules.get(name)) === stable(nextModules.get(name))) continue;
        if (!authorizedModules.has(name) || stable(nextModules.get(name)) !== stable(authorizedModules.get(name))) {
          throw new PatchPlanError(`Undeclared Galaxy registration change: ${name}`);
        }
      }
      previous.galaxy.modules = []; next.galaxy.modules = [];
      if (stable(previous) !== stable(next)) throw new PatchPlanError("Undeclared Game A manifest change");
    }
    if (file === "Base.SC2Data/GameData.xml") {
      const included = (source) => elementChildren(document(source ?? "<Includes/>").documentElement)
        .map((entry) => ({ tag: entry.tagName, path: entry.getAttribute("path") }));
      const previous = included(before);
      const next = included(after);
      if (stable(next.slice(0, previous.length)) !== stable(previous) || next.slice(previous.length).some((entry) =>
        entry.tag !== "Catalog" || !allowedFiles.has(`Base.SC2Data/${entry.path}`))) {
        throw new PatchPlanError("Undeclared Catalog dependency change");
      }
    }
    const locale = /^([a-z]{4})\.SC2Data\/LocalizedData\/GameStrings\.txt$/i.exec(file)?.[1];
    if (locale) {
      const previous = strings(before), next = strings(after);
      const expected = new Map(plan.operations.filter((op) => op.kind === "locale.set" && op.locale === locale)
        .map((op) => [op.key, op.value]));
      for (const key of new Set([...previous.keys(), ...next.keys()])) {
        if (previous.get(key) === next.get(key)) continue;
        if (!expected.has(key) || next.get(key) !== expected.get(key)) throw new PatchPlanError(`Undeclared localization change: ${locale}/${key}`);
      }
    }
    const catalog = /^Base\.SC2Data\/GameData\/([^/]+)Data\.xml$/.exec(file)?.[1];
    if (!catalog) continue;
    const previous = objects(before);
    const next = objects(after);
    for (const id of new Set([...previous.keys(), ...next.keys()])) {
      const left = fields(previous.get(id));
      const right = fields(next.get(id));
      const targets = allowedObjects.get(`${catalog}/${id}`) ?? [];
      if (previous.get(id)?.tagName !== next.get(id)?.tagName && !targets.length) {
        throw new PatchPlanError(`Undeclared artifact object change: ${catalog}/${id}`);
      }
      for (const field of new Set([...left.keys(), ...right.keys()])) {
        if (left.get(field) === right.get(field)) continue;
        const identity = identityFields.get(`${catalog}/${id}/${field}`);
        if (identity !== undefined && left.get(field) === undefined && right.get(field) === identity) continue;
        if (!targets.some((target) => covers(target, field))) {
          throw new PatchPlanError(`Undeclared artifact field change: ${catalog}/${id}/${field}`);
        }
      }
    }
  }
  if (JSON.stringify(changed) !== JSON.stringify([...application.changedFiles].sort())) {
    throw new PatchPlanError("Artifact diff does not match the executor's changedFiles report");
  }
  // Verify compiled Upgrade contents and activation, not just a desired value
  // projected from the plan. This runs even without user-declared contracts.
  const upgrades = objects(await read(afterCore, "Base.SC2Data/GameData/UpgradeData.xml"));
  const manifest = JSON.parse(await read(afterCore, "GameA.Core.json"));
  for (const { artifact, operation } of generated.values()) {
    const upgrade = upgrades.get(artifact.upgradeId);
    const effects = upgrade ? elementChildren(upgrade).filter((child) => child.tagName === "EffectArray") : [];
    const expected = operation.kind === "commander.stat.set"
      ? [{ reference: artifact.reference, value: String(operation.value) }]
      : operation.redirects.map((redirect) => ({ reference: `${redirect.catalog},${redirect.object},${normalized(redirect.path)}`, value: operation.unitId }));
    if (effects.length !== expected.length || expected.some((item) => !effects.some((effect) =>
      effect.getAttribute("Reference") === item.reference && effect.getAttribute("Value") === item.value
      && effect.getAttribute("Operation") === "Set"))) {
      throw new PatchPlanError(`Generated Upgrade does not match declared scoped writes: ${artifact.upgradeId}`);
    }
    if (await read(afterCore, artifact.path) !== artifact.source ||
      !manifest.galaxy?.modules?.some((module) => module.path === artifact.path && module.configure === artifact.configure)) {
      throw new PatchPlanError(`Generated Upgrade activation does not match declared commander: ${artifact.upgradeId}`);
    }
  }
  return { status: "passed", changedFiles: changed, generatedUpgradeCount: generated.size };
}
