import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { extractGalaxySymbols, GALAXY_SYMBOL_VERSION } from "./galaxy-symbols.mjs";
import { createEngineCatalogSchema, importEngineCatalog, readEngineCache } from "./engine-catalog-store.mjs";
import { buildCoopSemantics } from './coop-semantics.mjs';
import { normalizeUpgradeArrays } from './upgrade-array-projection.mjs';

const DATABASE_SCHEMA_VERSION = 2;
const CATALOG_PROJECTION_VERSION = 3;
// Official co-op expansion profile. Multiplayer variants are separate data
// branches, not additive expansion dependencies (native B97579 array regression).
const PACKAGE_LAYOUT = [
  ["core.sc2mod", "mods/core.sc2mod"],
  ["liberty.sc2mod", "mods/liberty.sc2mod"],
  ["swarm.sc2mod", "mods/swarm.sc2mod"],
  ["void.sc2mod", "mods/void.sc2mod"],
  ["libertystory.sc2campaign", "campaigns/libertystory.sc2campaign"],
  ["liberty.sc2campaign", "campaigns/liberty.sc2campaign"],
  ["swarmstoryutil.sc2mod", "campaigns/swarmstoryutil.sc2mod"],
  ["swarmstory.sc2campaign", "campaigns/swarmstory.sc2campaign"],
  ["swarm.sc2campaign", "campaigns/swarm.sc2campaign"],
  ["voidstory.sc2campaign", "campaigns/voidstory.sc2campaign"],
  ["void.sc2campaign", "campaigns/void.sc2campaign"],
  ["starcoop.sc2mod", "mods/starcoop/starcoop.sc2mod"],
  ["egonstetmann.sc2mod", "mods/starcoop/commanders/egonstetmann.sc2mod"],
  ["arcturusmengsk.sc2mod", "mods/starcoop/commanders/arcturusmengsk.sc2mod"],
  ["alliedcommanders.sc2mod", "mods/alliedcommanders.sc2mod"],
];

const REFERENCE_HINTS = new Map([
  ["abil", "Abil"],
  ["ability", "Abil"],
  ["actor", "Actor"],
  ["behavior", "Behavior"],
  ["button", "Button"],
  ["commander", "Commander"],
  ["effect", "Effect"],
  ["model", "Model"],
  ["mover", "Mover"],
  ["requirement", "Requirement"],
  ["sound", "Sound"],
  ["turret", "Turret"],
  ["unit", "Unit"],
  ["upgrade", "Upgrade"],
  ["validator", "Validator"],
  ["weapon", "Weapon"],
]);

const USER_VALUE_CATALOGS = new Map([
  ["abilcmd", { catalog: "Abil", attribute: "Abil" }],
  ["actor", { catalog: "Actor", attribute: "Actor" }],
  ["behavior", { catalog: "Behavior", attribute: "Behavior" }],
  ["button", { catalog: "Button", attribute: "Button" }],
  ["effect", { catalog: "Effect", attribute: "Effect" }],
  ["model", { catalog: "Model", attribute: "Model" }],
  ["requirement", { catalog: "Requirement", attribute: "Requirement" }],
  ["sound", { catalog: "Sound", attribute: "Sound" }],
  ["unit", { catalog: "Unit", attribute: "Unit" }],
  ["upgrade", { catalog: "Upgrade", attribute: "Upgrade" }],
  ["validator", { catalog: "Validator", attribute: "Validator" }],
  ["weapon", { catalog: "Weapon", attribute: "Weapon" }],
]);

const USER_GAME_LINK_CATALOGS = new Map([
  ["armycategoryoff", "ArmyCategory"],
  ["armycategoryon", "ArmyCategory"],
  ["button", "Button"],
  ["campaignperkskin", "Skin"],
  ["commanderdata", "Commander"],
  ["commanderskin", "Skin"],
  ["defaultvoicepack", "VoicePack"],
  ["effect", "Effect"],
  ["globalcastunit", "Unit"],
  ["herounitfirstrevivebehavior", "Behavior"],
  ["herounitnormalrevivebehavior", "Behavior"],
  ["heroreviverextrarevivebehavior", "Behavior"],
  ["heroreviveunit", "Unit"],
  ["herostructure", "Unit"],
  ["herounit", "Unit"],
  ["morpharmyunit", "Unit"],
  ["portraitactor", "Actor"],
  ["race", "Race"],
  ["scorestatisticcoop", "ScoreValue"],
  ["scorestatisticself", "ScoreValue"],
  ["spawnrace", "Race"],
  ["talentdata", "Talent"],
]);

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRelative(root, file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

function walkFiles(root) {
  if (!existsSync(root)) return [];
  const result = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) result.push(target);
    }
  }
  return result;
}

export function elementChildren(element) {
  const result = [];
  for (let child = element.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) result.push(child);
  }
  return result;
}

function parseXml(source, file, warnings) {
  const errors = [];
  const document = new DOMParser({
    onError: (level, message) => errors.push(`${level}: ${message}`),
  }).parseFromString(source, "application/xml");
  if (!document?.documentElement || document.documentElement.tagName === "parsererror") {
    throw new Error(`无法解析 XML：${file}`);
  }
  for (const message of errors) warnings.push(`${file}: ${message}`);
  return document;
}

function getAttributeCaseInsensitive(element, name) {
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    if (attribute.name.toLowerCase() === name.toLowerCase()) return attribute.value;
  }
  return null;
}

export function objectIdFor(element) {
  const id = getAttributeCaseInsensitive(element, "id");
  if (id) return id;
  if (getAttributeCaseInsensitive(element, "default") === "1") return `@default:${element.tagName}`;
  return `@anonymous:${element.tagName}`;
}

function childKey(element) {
  for (const attributeName of ["index", "id"]) {
    const value = getAttributeCaseInsensitive(element, attributeName);
    if (value !== null) {
      return `${element.tagName.toLowerCase()}\u0000${attributeName}\u0000${value.toLowerCase()}`;
    }
  }
  return null;
}

function replaceElement(target, replacement) {
  target.parentNode.replaceChild(replacement.cloneNode(true), target);
}

export function mergeElement(target, patch) {
  const patchChildren = elementChildren(patch);
  const metadataAttributes = new Set(['id', 'parent', 'default', 'index', 'removed', 'value']);
  const scalarChild = (node) => node.attributes.length === 1
    && node.attributes.item(0).name.toLowerCase() === 'value' && elementChildren(node).length === 0;
  for (let index = 0; index < patch.attributes.length; index += 1) {
    const attribute = patch.attributes.item(index);
    // Scalar struct members have both XML spellings. A later attribute replaces
    // the earlier <Member value="..."/>; retaining both creates conflicting facts.
    // Do not guess precedence for two spellings within the same definition.
    if (!metadataAttributes.has(attribute.name.toLowerCase()) && !patchChildren.some(node => node.tagName === attribute.name)) {
      const old = elementChildren(target).filter(node => node.tagName === attribute.name);
      if (old.length === 1 && scalarChild(old[0])) target.removeChild(old[0]);
    }
    target.setAttribute(attribute.name, attribute.value);
  }

  const patchTagCounts = new Map();
  for (const child of patchChildren) {
    const key = child.tagName.toLowerCase();
    patchTagCounts.set(key, (patchTagCounts.get(key) ?? 0) + 1);
  }

  for (const incoming of patchChildren) {
    if (scalarChild(incoming) && !metadataAttributes.has(incoming.tagName.toLowerCase()) && !patch.hasAttribute(incoming.tagName)) {
      target.removeAttribute(incoming.tagName);
    }
    const existingChildren = elementChildren(target);
    const indexedKey = childKey(incoming);
    let match = indexedKey
      ? existingChildren.find((candidate) => childKey(candidate) === indexedKey)
      : null;
    const removed = getAttributeCaseInsensitive(incoming, "removed") === "1";

    if (!match && !indexedKey) {
      const sameTag = existingChildren.filter(
        (candidate) => candidate.tagName.toLowerCase() === incoming.tagName.toLowerCase(),
      );
      const scalarLike =
        getAttributeCaseInsensitive(incoming, "value") !== null ||
        (elementChildren(incoming).length === 0 && incoming.attributes.length > 0);
      if (sameTag.length === 1 && (patchTagCounts.get(incoming.tagName.toLowerCase()) === 1 || scalarLike)) {
        [match] = sameTag;
      }
    }

    if (removed) {
      if (match) target.removeChild(match);
      continue;
    }
    if (!match) {
      target.appendChild(incoming.cloneNode(true));
      continue;
    }

    const incomingHasChildren = elementChildren(incoming).length > 0;
    const matchHasChildren = elementChildren(match).length > 0;
    if (incomingHasChildren || matchHasChildren) mergeElement(match, incoming);
    else replaceElement(match, incoming);
  }
  return target;
}

function pathSegment(element, siblingState) {
  const index = getAttributeCaseInsensitive(element, "index");
  if (index !== null) return `${element.tagName}[${index}]`;
  const tag = element.tagName.toLowerCase();
  const ordinal = siblingState.get(tag) ?? 0;
  siblingState.set(tag, ordinal + 1);
  const duplicates = siblingState._counts.get(tag) ?? 0;
  return duplicates > 1 ? `${element.tagName}[#${ordinal}]` : element.tagName;
}

export function flattenObject(element) {
  const fields = new Map();
  const removals = [];

  function visit(current, parentPath) {
    const children = elementChildren(current);
    const counts = new Map();
    for (const child of children) {
      const tag = child.tagName.toLowerCase();
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    const siblingState = new Map();
    siblingState._counts = counts;

    for (const child of children) {
      const segment = pathSegment(child, siblingState);
      const fieldPath = parentPath ? `${parentPath}.${segment}` : segment;
      if (getAttributeCaseInsensitive(child, "removed") === "1") {
        removals.push(fieldPath);
        continue;
      }

      let wroteScalar = false;
      for (let index = 0; index < child.attributes.length; index += 1) {
        const attribute = child.attributes.item(index);
        const lower = attribute.name.toLowerCase();
        if (lower === "index" || lower === "removed") continue;
        const attributePath = lower === "value" ? fieldPath : `${fieldPath}.@${attribute.name}`;
        fields.set(attributePath, {
          path: attributePath,
          value: attribute.value,
          fieldTag: child.tagName,
          attribute: lower === "value" ? "value" : attribute.name,
        });
        wroteScalar = true;
      }
      if (!wroteScalar && elementChildren(child).length === 0) {
        const text = Array.from({ length: child.childNodes.length }, (_, index) => child.childNodes.item(index))
          .filter((node) => node.nodeType === 3)
          .map((node) => node.data)
          .join("")
          .trim();
        if (text) fields.set(fieldPath, { path: fieldPath, value: text, fieldTag: child.tagName, attribute: null });
      }
      visit(child, fieldPath);
    }
  }

  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    if (["id", "default"].includes(attribute.name.toLowerCase())) continue;
    fields.set(`@${attribute.name}`, {
      path: `@${attribute.name}`,
      value: attribute.value,
      fieldTag: element.tagName,
      attribute: attribute.name,
    });
  }
  visit(element, "");
  return { fields, removals };
}

function deletePrefix(target, prefix) {
  for (const key of target.keys()) {
    if (key === prefix || key.startsWith(`${prefix}.`)) target.delete(key);
  }
}

export function inferReferenceCatalog(field, catalogNames, source = null) {
  const sourceClass = source?.element?.tagName ?? "";
  if (source?.catalog?.toLowerCase() === "requirement") {
    if (
      sourceClass === "CRequirement" && /^NodeArray(?:\[|$)/.test(field.path) &&
      (field.attribute?.toLowerCase() === "link" || field.path.endsWith(".@Link"))
    ) return "Requirement";
    if (/^CRequirement(?:And|Or|Xor|Not|Odd|Eq|NE|GT|GTE|LT|LTE|Sum|Mul|Div|Mod)$/.test(sourceClass) &&
        /^OperandArray(?:\[|$)/.test(field.path)) {
      return "Requirement";
    }
    const typedRequirement = /^CRequirement(?:Count|Allow)(Abil|Behavior|Unit|Upgrade)$/.exec(sourceClass);
    if (typedRequirement && (field.path === "Link" || field.path.endsWith(".@Link"))) {
      return typedRequirement[1];
    }
  }
  const haystack = `${field.fieldTag} ${field.attribute ?? ""} ${field.path}`.toLowerCase();
  for (const [hint, catalog] of REFERENCE_HINTS) {
    if (haystack.includes(hint) && catalogNames.has(catalog.toLowerCase())) return catalog;
  }
  if (field.attribute?.toLowerCase() === "link") {
    for (const name of [...catalogNames.values()].sort((left, right) => right.length - left.length)) {
      if (haystack.includes(name)) return name;
    }
  }
  return null;
}

export function dataReference(field, catalogNames) {
  const match = /^([^,]+),([^,]+),(.+)$/.exec(field.value ?? "");
  if (!match) return null;
  const catalog = [...catalogNames.values()].find(
    (candidate) => candidate.toLowerCase() === match[1].trim().toLowerCase(),
  );
  if (!catalog) return null;
  return {
    catalog,
    objectId: match[2].trim(),
    targetFieldPath: match[3].trim(),
  };
}

function findDescendants(element, predicate) {
  const result = [];
  const pending = [element];
  while (pending.length > 0) {
    const current = pending.pop();
    if (predicate(current)) result.push(current);
    pending.push(...elementChildren(current));
  }
  return result;
}

function firstFieldValue(element, fieldId) {
  for (const candidate of findDescendants(element, () => true)) {
    const field = elementChildren(candidate).find(
      (child) => child.tagName === "Field" && getAttributeCaseInsensitive(child, "Id") === fieldId,
    );
    if (!field) continue;
    for (let index = 0; index < candidate.attributes.length; index += 1) {
      const attribute = candidate.attributes.item(index);
      if (!["id", "index"].includes(attribute.name.toLowerCase())) return attribute.value;
    }
  }
  return null;
}

function valueField(element) {
  return elementChildren(element).find((child) => child.tagName === "Field") ?? null;
}

function typedUserLink(element) {
  const field = valueField(element);
  const fieldId = field ? getAttributeCaseInsensitive(field, "Id") : null;
  const index = field ? Number(getAttributeCaseInsensitive(field, "Index") ?? 0) : 0;
  const tag = element.tagName.toLowerCase();
  let descriptor = USER_VALUE_CATALOGS.get(tag) ?? null;
  if (tag === "gamelink" && fieldId) {
    const catalog = USER_GAME_LINK_CATALOGS.get(fieldId.toLowerCase());
    descriptor = catalog ? { catalog, attribute: "GameLink" } : null;
  }
  if (!descriptor) return null;
  const objectId = getAttributeCaseInsensitive(element, descriptor.attribute);
  if (!objectId) return null;
  return {
    catalog: descriptor.catalog,
    objectId,
    fieldId,
    index,
    commandIndex:
      tag === "abilcmd" ? Number(getAttributeCaseInsensitive(element, "Cmd") ?? 0) : null,
  };
}

function typedUserLinks(instance) {
  return elementChildren(instance).map(typedUserLink).filter(Boolean);
}

function userInstancesForCommander(userElement, commanderId) {
  if (!userElement) return [];
  return elementChildren(userElement).filter(
    (child) =>
      child.tagName === "Instances" &&
      findDescendants(
        child,
        (candidate) =>
          candidate.tagName === "User" &&
          getAttributeCaseInsensitive(candidate, "Type") === "PlayerCommanders" &&
          getAttributeCaseInsensitive(candidate, "Instance") === commanderId,
      ).length > 0,
  );
}

function userInstanceById(userElement, instanceId) {
  if (!userElement || !instanceId) return null;
  return (
    elementChildren(userElement).find(
      (child) =>
        child.tagName === "Instances" &&
        getAttributeCaseInsensitive(child, "Id") === instanceId,
    ) ?? null
  );
}

function localizedUserField(instance, fieldId, textLookupStatement) {
  const key = instance ? firstFieldValue(instance, fieldId) : null;
  return {
    key,
    nameZhCN: key ? textLookupStatement.get("zhCN", key)?.value ?? null : null,
    nameEnUS: key ? textLookupStatement.get("enUS", key)?.value ?? null : null,
  };
}

function indexedFieldRecords(fields, prefix) {
  const records = new Map();
  const pattern = new RegExp(`^${prefix}(?:\\[#(\\d+)\\])?(?:\\.@?(.+))?$`);
  for (const [pathName, field] of fields) {
    const match = pattern.exec(pathName);
    if (!match) continue;
    const index = Number(match[1] ?? 0);
    if (!records.has(index)) records.set(index, { index });
    records.get(index)[match[2] ?? "value"] = field.value;
  }
  return [...records.values()].sort((left, right) => left.index - right.index);
}

function buildCommanderProfile({
  commander,
  userObjects,
  objectLookup,
  effectiveFieldsFor,
  textLookupStatement,
  localizedUnitIds,
}) {
  const profile = {
    schemaVersion: 1,
    roster: { buildings: [], units: [] },
    levelPerks: [],
    prestiges: [],
    masteries: [],
    panel: {
      traits: [],
      casterUnit: null,
      abilityCommands: [],
      defaultUpgrades: [],
    },
  };
  const strongLinks = [];
  const addStrongLink = (link) => {
    if (!link) return;
    const key = `${link.catalog}\u0000${link.objectId}`;
    if (!objectLookup.has(key)) return;
    if (!strongLinks.some((candidate) => candidate.catalog === link.catalog && candidate.objectId === link.objectId)) {
      strongLinks.push(link);
    }
  };
  const localizedCatalogName = (catalog, objectId) => {
    const key = `${catalog}/Name/${objectId}`;
    return {
      key,
      nameZhCN: textLookupStatement.get("zhCN", key)?.value ?? null,
      nameEnUS: textLookupStatement.get("enUS", key)?.value ?? null,
    };
  };
  const localizedUserOrLinkName = (instance, links) => {
    const direct = localizedUserField(instance, "Name", textLookupStatement);
    if (direct.nameZhCN || direct.nameEnUS) return direct;
    const button = links.find((link) => link.catalog === "Button");
    return button ? localizedCatalogName("Button", button.objectId) : direct;
  };
  const resolveRosterUnit = (semanticId) => {
    if (objectLookup.has(`Unit\u0000${semanticId}`)) return semanticId;
    const categoryKey = `ArmyCategory\u0000${semanticId}`;
    const categoryUnit = effectiveFieldsFor(categoryKey).get("Unit")?.value ?? null;
    return categoryUnit && objectLookup.has(`Unit\u0000${categoryUnit}`) ? categoryUnit : null;
  };
  const techUnit = userObjects.get("TechUnit") ?? null;
  const commanderTechUnits = userInstancesForCommander(techUnit, commander.id);
  const preferredCommanderUnits = new Set();
  const preferredCommanderUnitsByName = new Map();
  for (const instance of commanderTechUnits) {
    const unitId = resolveRosterUnit(getAttributeCaseInsensitive(instance, "Id"));
    if (!unitId) continue;
    preferredCommanderUnits.add(unitId);
    const localized = localizedUserField(instance, "Name", textLookupStatement);
    for (const name of [localized.nameZhCN, localized.nameEnUS].filter(Boolean)) {
      preferredCommanderUnitsByName.set(name.split(/\s*\/{3}\s*/)[0].trim(), unitId);
    }
  }
  const resolveDisplayUnit = (displayUnitId) => {
    const stripped = displayUnitId.replace(/ACGluescreenDummy$/i, "");
    const strippedExists = objectLookup.has(`Unit\u0000${stripped}`);
    const localized = localizedCatalogName("Unit", displayUnitId);
    const localizedName = localized.nameZhCN ?? localized.nameEnUS;
    if (!localizedName) return strippedExists ? stripped : displayUnitId;
    const normalizedName = localizedName.split(/\s*\/{3}\s*/)[0].trim();
    const preferredByName = preferredCommanderUnitsByName.get(normalizedName);
    if (preferredByName) return preferredByName;
    const localizedCandidates = localizedUnitIds.get(normalizedName) ?? [];
    const candidates = [...new Set([...(strippedExists ? [stripped] : []), ...localizedCandidates])];
    const playable = candidates
      .filter((candidate) => !/ACGluescreenDummy|Burrowed|Cocoon|Missile|Weapon$/i.test(candidate))
      .sort((left, right) => {
        const leftPreferred = preferredCommanderUnits.has(left) ? 0 : 1;
        const rightPreferred = preferredCommanderUnits.has(right) ? 0 : 1;
        const leftCommander = left.toLowerCase().includes(commander.objectId.toLowerCase()) ? 0 : 1;
        const rightCommander = right.toLowerCase().includes(commander.objectId.toLowerCase()) ? 0 : 1;
        return leftPreferred - rightPreferred || leftCommander - rightCommander || left.length - right.length || left.localeCompare(right);
      });
    return playable[0] ?? displayUnitId;
  };
  const addRosterItem = ({ techId, unitId, source, unlockedAtLevel = null, localized = null }) => {
    if (!unitId) return;
    const unitKey = `Unit\u0000${unitId}`;
    if (!objectLookup.has(unitKey)) return;
    const isStructure = effectiveFieldsFor(unitKey).get("Attributes[Structure]")?.value === "1";
    const target = profile.roster[isStructure ? "buildings" : "units"];
    if (target.some((candidate) => candidate.unitId === unitId)) return;
    const resolvedLocalized = localized?.nameZhCN || localized?.nameEnUS
      ? localized
      : localizedCatalogName("Unit", unitId);
    target.push({
      techId,
      unitId,
      ...resolvedLocalized,
      source,
      unlockedAtLevel,
    });
    addStrongLink({ catalog: "Unit", objectId: unitId, fieldId: source, index: 0, commandIndex: null });
  };

  const commanderFields = effectiveFieldsFor(`Commander\u0000${commander.objectId}`);
  const commanderRoster = indexedFieldRecords(commanderFields, "UnitArray");
  for (const item of commanderRoster) {
    if (!item.Unit) continue;
    const unitId = resolveDisplayUnit(item.Unit);
    addRosterItem({
      techId: item.Unit,
      unitId,
      localized: localizedCatalogName("Unit", item.Unit),
      source: "Commander.UnitArray",
    });
    addStrongLink({ catalog: "Unit", objectId: item.Unit, fieldId: "UnitArray", index: item.index, commandIndex: null });
  }

  for (const instance of userInstancesForCommander(techUnit, commander.id)) {
    const techId = getAttributeCaseInsensitive(instance, "Id");
    if (!techId) continue;
    const unitId = resolveRosterUnit(techId);
    const unitKey = unitId ? `Unit\u0000${unitId}` : null;
    const isStructure = unitKey && effectiveFieldsFor(unitKey).get("Attributes[Structure]")?.value === "1";
    if (commanderRoster.length > 0 && !isStructure) continue;
    const localized = localizedUserField(instance, "Name", textLookupStatement);
    addRosterItem({
      techId,
      unitId,
      localized,
      source: "TechUnit",
    });
  }

  const userLevelPerks = [];
  const campaignPerk = userObjects.get("CampaignPerk") ?? null;
  for (const instance of userInstancesForCommander(campaignPerk, commander.id)) {
    const id = getAttributeCaseInsensitive(instance, "Id");
    if (!id) continue;
    const levelUser = findDescendants(
      instance,
      (candidate) =>
        candidate.tagName === "User" &&
        getAttributeCaseInsensitive(candidate, "Type") === "PlayerLevels",
    )[0];
    const levelId = levelUser ? getAttributeCaseInsensitive(levelUser, "Instance") : null;
    const levelMatch = levelId ? /Level(\d+)$/i.exec(levelId) : null;
    const links = typedUserLinks(instance);
    links.forEach(addStrongLink);
    userLevelPerks.push({
      id,
      level: levelMatch ? Number(levelMatch[1]) : null,
      levelId,
      ...localizedUserOrLinkName(instance, links),
      links,
    });
    for (const link of (commanderRoster.length === 0 ? links : []).filter(
      (candidate) => candidate.catalog === "ArmyCategory" && candidate.fieldId === "ArmyCategoryOn",
    )) {
      addRosterItem({
        techId: link.objectId,
        unitId: resolveRosterUnit(link.objectId),
        source: "CampaignPerk.ArmyCategoryOn",
        unlockedAtLevel: levelMatch ? Number(levelMatch[1]) : null,
      });
    }
  }
  userLevelPerks.sort((left, right) => (left.level ?? 999) - (right.level ?? 999) || left.id.localeCompare(right.id));
  const commanderLevelPerks = indexedFieldRecords(commanderFields, "TalentTreeArray")
    .filter((perk) => perk.IsHidden !== "1" && perk.Level && perk.Talent)
    .map((perk) => {
      const localized = localizedCatalogName("Button", perk.Talent);
      const userPerk = userLevelPerks.find((candidate) => candidate.level === Number(perk.Level));
      addStrongLink({ catalog: "Button", objectId: perk.Talent, fieldId: "TalentTreeArray", index: perk.index, commandIndex: null });
      return {
        id: perk.Talent,
        level: Number(perk.Level),
        levelId: userPerk?.levelId ?? null,
        ...localized,
        links: userPerk?.links ?? [],
      };
    });
  profile.levelPerks = commanderLevelPerks.length > 0 ? commanderLevelPerks : userLevelPerks;

  const playerPrestige = userObjects.get("PlayerPrestige") ?? null;
  for (const value of elementChildren(commander.instance ?? { firstChild: null })) {
    if (
      value.tagName !== "User" ||
      getAttributeCaseInsensitive(value, "Type") !== "PlayerPrestige"
    ) continue;
    const field = valueField(value);
    if (!field || getAttributeCaseInsensitive(field, "Id") !== "Prestige") continue;
    const id = getAttributeCaseInsensitive(value, "Instance");
    if (!id) continue;
    const prestigeInstance = userInstanceById(playerPrestige, id);
    const prestigeLinks = prestigeInstance ? typedUserLinks(prestigeInstance) : [];
    const localized = localizedUserOrLinkName(prestigeInstance, prestigeLinks);
    const fallbackLocalized = localized.nameZhCN || localized.nameEnUS
      ? localized
      : localizedCatalogName("Button", id);
    profile.prestiges.push({
      id,
      index: Number(getAttributeCaseInsensitive(field, "Index") ?? profile.prestiges.length),
      ...fallbackLocalized,
    });
  }
  profile.prestiges.sort((left, right) => left.index - right.index);
  const commanderPrestiges = indexedFieldRecords(commanderFields, "PrestigeArray")
    .filter((prestige) => prestige.value)
    .map((prestige) => {
      addStrongLink({ catalog: "Upgrade", objectId: prestige.value, fieldId: "PrestigeArray", index: prestige.index, commandIndex: null });
      return {
        id: prestige.value,
        index: prestige.index,
        ...localizedCatalogName("Button", prestige.value),
      };
    });
  if (commanderPrestiges.length > 0) profile.prestiges = commanderPrestiges;

  const masteryUpgrades = userObjects.get("MasteryUpgrades") ?? null;
  for (const instance of userInstancesForCommander(masteryUpgrades, commander.id)) {
    const id = getAttributeCaseInsensitive(instance, "Id");
    if (!id) continue;
    const links = typedUserLinks(instance);
    links.forEach(addStrongLink);
    profile.masteries.push({
      id,
      category: Number(firstFieldValue(instance, "Category") ?? 0),
      internalIndex: Number(firstFieldValue(instance, "InternalIndex") ?? 0),
      ...localizedUserField(instance, "Name", textLookupStatement),
      links,
    });
  }
  profile.masteries.sort(
    (left, right) => left.category - right.category || left.internalIndex - right.internalIndex || left.id.localeCompare(right.id),
  );

  profile.panel.traits = indexedFieldRecords(commanderFields, "CommanderAbilArray")
    .filter((trait) => trait.Button)
    .map((trait) => ({
      buttonId: trait.Button,
      index: trait.index,
      ...localizedCatalogName("Button", trait.Button),
    }));
  for (const trait of profile.panel.traits) {
    addStrongLink({ catalog: "Button", objectId: trait.buttonId, fieldId: "CommanderAbilArray", index: trait.index, commandIndex: null });
  }

  for (const value of elementChildren(commander.instance ?? { firstChild: null })) {
    const link = typedUserLink(value);
    if (link) addStrongLink(link);
    if (!link || link.fieldId !== "DefaultAbilityCommands") continue;
    profile.panel.abilityCommands.push({
      abilityId: link.objectId,
      commandIndex: link.commandIndex,
      index: link.index,
    });
  }
  profile.panel.abilityCommands.sort((left, right) => left.index - right.index);
  profile.panel.defaultUpgrades = elementChildren(commander.instance ?? { firstChild: null })
    .map(typedUserLink)
    .filter((link) => link?.fieldId === "DefaultUpgrades" && link.catalog === "Upgrade")
    .sort((left, right) => left.index - right.index)
    .map((link) => link.objectId);
  profile.panel.casterUnit = elementChildren(commander.instance ?? { firstChild: null })
    .map(typedUserLink)
    .find((link) => link?.fieldId === "GlobalCastUnit" && link.catalog === "Unit")?.objectId ?? null;

  for (const fieldId of ["HeroUnit", "HeroReviveUnit", "HeroStructure"]) {
    for (const link of elementChildren(commander.instance ?? { firstChild: null }).map(typedUserLink)) {
      if (link?.fieldId !== fieldId || link.catalog !== "Unit") continue;
      const unitKey = `Unit\u0000${link.objectId}`;
      if (!objectLookup.has(unitKey)) continue;
      addRosterItem({
        techId: link.objectId,
        unitId: link.objectId,
        source: `PlayerCommanders.${fieldId}`,
      });
    }
  }

  return { profile, strongLinks };
}

function parseLocalizedFile(contents) {
  const result = [];
  for (const rawLine of contents.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const separator = rawLine.indexOf("=");
    if (separator <= 0) continue;
    result.push([rawLine.slice(0, separator).trim(), rawLine.slice(separator + 1)]);
  }
  return result;
}

function createSchema(database) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE packages (
      id TEXT PRIMARY KEY, load_order INTEGER NOT NULL, source_root TEXT NOT NULL,
      dependency_basis TEXT NOT NULL
    );
    CREATE TABLE source_files (
      id INTEGER PRIMARY KEY, package_id TEXT NOT NULL, relative_path TEXT NOT NULL,
      kind TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
      UNIQUE(package_id, relative_path)
    );
    CREATE TABLE catalog_definitions (
      id INTEGER PRIMARY KEY, load_order INTEGER NOT NULL, catalog TEXT NOT NULL,
      class TEXT NOT NULL, object_id TEXT NOT NULL, parent_id TEXT, is_default INTEGER NOT NULL,
      source_file TEXT NOT NULL, xml TEXT NOT NULL
    );
    CREATE INDEX catalog_definitions_object ON catalog_definitions(catalog, object_id, load_order);
    CREATE TABLE catalog_objects (
      catalog TEXT NOT NULL, object_id TEXT NOT NULL, class TEXT NOT NULL,
      parent_id TEXT, is_default INTEGER NOT NULL, source_file TEXT NOT NULL,
      direct_xml TEXT NOT NULL, PRIMARY KEY(catalog, object_id)
    ) WITHOUT ROWID;
    CREATE INDEX catalog_objects_id ON catalog_objects(object_id);
    CREATE TABLE catalog_fields (
      catalog TEXT NOT NULL, object_id TEXT NOT NULL, path TEXT NOT NULL,
      value TEXT NOT NULL, field_tag TEXT NOT NULL, attribute TEXT,
      source_file TEXT NOT NULL, origin_object_id TEXT NOT NULL, inheritance_depth INTEGER NOT NULL,
      PRIMARY KEY(catalog, object_id, path)
    ) WITHOUT ROWID;
    CREATE TABLE object_references (
      source_catalog TEXT NOT NULL, source_object_id TEXT NOT NULL, field_path TEXT NOT NULL,
      target_catalog TEXT NOT NULL, target_object_id TEXT NOT NULL,
      confidence REAL NOT NULL, evidence TEXT NOT NULL,
      PRIMARY KEY(source_catalog, source_object_id, field_path, target_catalog, target_object_id)
    ) WITHOUT ROWID;
    CREATE INDEX object_references_target ON object_references(target_catalog, target_object_id);
    CREATE TABLE localized_text (
      locale TEXT NOT NULL, text_key TEXT NOT NULL, value TEXT NOT NULL,
      source_file TEXT NOT NULL, PRIMARY KEY(locale, text_key)
    ) WITHOUT ROWID;
    CREATE INDEX localized_text_key ON localized_text(text_key, locale);
    CREATE TABLE galaxy_files (
      source_file TEXT PRIMARY KEY, package_id TEXT NOT NULL, sha256 TEXT NOT NULL, contents TEXT NOT NULL
    );
    CREATE TABLE galaxy_symbols (
      source_file TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL,
      PRIMARY KEY(source_file, name, kind, line)
    ) WITHOUT ROWID;
    CREATE INDEX galaxy_symbols_name ON galaxy_symbols(name);
    CREATE TABLE commanders (
      id TEXT PRIMARY KEY, commander_object_id TEXT NOT NULL, user_reference TEXT,
      name_key TEXT, name_zhcn TEXT, name_enus TEXT
    );
    CREATE TABLE commander_profiles (
      commander_id TEXT PRIMARY KEY, profile_json TEXT NOT NULL
    );
    CREATE TABLE commander_membership (
      commander_id TEXT NOT NULL, catalog TEXT NOT NULL, object_id TEXT NOT NULL,
      evidence TEXT NOT NULL, depth INTEGER NOT NULL,
      PRIMARY KEY(commander_id, catalog, object_id, evidence)
    ) WITHOUT ROWID;
    CREATE INDEX commander_membership_object ON commander_membership(catalog, object_id);
    CREATE VIRTUAL TABLE search_index USING fts5(kind, key, title, body);
  `);
  createEngineCatalogSchema(database);
}

function prepareStatements(database) {
  return {
    meta: database.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)"),
    package: database.prepare(
      "INSERT INTO packages(id, load_order, source_root, dependency_basis) VALUES (?, ?, ?, ?)",
    ),
    sourceFile: database.prepare(
      "INSERT OR IGNORE INTO source_files(package_id, relative_path, kind, sha256, size) VALUES (?, ?, ?, ?, ?)",
    ),
    definition: database.prepare(`
      INSERT INTO catalog_definitions(load_order, catalog, class, object_id, parent_id, is_default, source_file, xml)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    object: database.prepare(`
      INSERT INTO catalog_objects(catalog, object_id, class, parent_id, is_default, source_file, direct_xml)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    field: database.prepare(`
      INSERT INTO catalog_fields(catalog, object_id, path, value, field_tag, attribute, source_file, origin_object_id, inheritance_depth)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    reference: database.prepare(`
      INSERT OR IGNORE INTO object_references(source_catalog, source_object_id, field_path, target_catalog, target_object_id, confidence, evidence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    text: database.prepare(
      "INSERT OR REPLACE INTO localized_text(locale, text_key, value, source_file) VALUES (?, ?, ?, ?)",
    ),
    galaxyFile: database.prepare(
      "INSERT INTO galaxy_files(source_file, package_id, sha256, contents) VALUES (?, ?, ?, ?)",
    ),
    galaxySymbol: database.prepare(
      "INSERT OR IGNORE INTO galaxy_symbols(source_file, name, kind, line) VALUES (?, ?, ?, ?)",
    ),
    commander: database.prepare(`
      INSERT INTO commanders(id, commander_object_id, user_reference, name_key, name_zhcn, name_enus)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    commanderProfile: database.prepare(
      "INSERT INTO commander_profiles(commander_id, profile_json) VALUES (?, ?)",
    ),
    membership: database.prepare(`
      INSERT OR IGNORE INTO commander_membership(commander_id, catalog, object_id, evidence, depth)
      VALUES (?, ?, ?, ?, ?)
    `),
    search: database.prepare("INSERT INTO search_index(kind, key, title, body) VALUES (?, ?, ?, ?)"),
  };
}

function catalogFileCandidates(packages) {
  const result = [];
  for (const packageInfo of packages) {
    for (const file of walkFiles(packageInfo.root)) {
      const relative = normalizeRelative(packageInfo.root, file);
      if (!relative.toLowerCase().includes("base.sc2data/gamedata")) continue;
      if (!file.toLowerCase().endsWith(".xml")) continue;
      const marker = relative.toLowerCase().indexOf("base.sc2data/gamedata");
      const afterRoot = relative.slice(marker + "base.sc2data/gamedata".length).replace(/^\//, "");
      const depth = afterRoot.split("/").length - 1;
      result.push({ ...packageInfo, file, relative, depth });
    }
  }
  return result.sort(
    (left, right) =>
      left.loadOrder - right.loadOrder || left.depth - right.depth || left.relative.localeCompare(right.relative),
  );
}

function discoverCatalogNames(candidates) {
  const values = new Map();
  for (const candidate of candidates) {
    const base = path.basename(candidate.file, ".xml");
    if (!base.toLowerCase().endsWith("data")) continue;
    const stem = base.slice(0, -4);
    if (!stem || ["game", "sc2"].includes(stem.toLowerCase())) continue;
    if (!values.has(stem.toLowerCase())) values.set(stem.toLowerCase(), stem[0].toUpperCase() + stem.slice(1));
  }
  for (const value of REFERENCE_HINTS.values()) {
    if (!values.has(value.toLowerCase())) values.set(value.toLowerCase(), value);
  }
  values.set("game", "Game");
  return values;
}

export function catalogForClass(className, catalogNames) {
  if (!className.startsWith("C")) return "Unknown";
  const remainder = className.slice(1);
  const matches = [...catalogNames.keys()]
    .filter((name) => remainder.toLowerCase().startsWith(name))
    .sort((left, right) => right.length - left.length);
  if (matches.length === 0) return "Unknown";
  const length = matches[0].length;
  return remainder.slice(0, length);
}

function atomicInstallDirectory(temporary, output) {
  const parent = path.dirname(output);
  mkdirSync(parent, { recursive: true });
  const backup = `${output}.previous-${process.pid}`;
  if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
  if (existsSync(output)) renameSync(output, backup);
  try {
    renameSync(temporary, output);
    if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (!existsSync(output) && existsSync(backup)) renameSync(backup, output);
    throw error;
  }
}

export function defaultCascRoot() {
  const localData = process.env.LOCALAPPDATA ??
    process.env.XDG_DATA_HOME ??
    (process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Local")
      : path.join(os.homedir(), ".local", "share"));
  const base = path.join(localData, "CoopAgent", "casc");
  if (!existsSync(base)) throw new Error(`找不到 CASC 提取目录：${base}`);
  const candidates = readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(base, entry.name, "manifest.json")))
    .map((entry) => ({ path: path.join(base, entry.name), mtime: statSync(path.join(base, entry.name)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime);
  if (candidates.length === 0) throw new Error(`CASC 提取目录中没有可用版本：${base}`);
  return candidates[0].path;
}

export function defaultDatabaseRoot(build) {
  const base = process.env.LOCALAPPDATA ??
    process.env.XDG_DATA_HOME ??
    (process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Local")
      : path.join(os.homedir(), ".local", "share"));
  return path.join(base, "CoopAgent", "database", build);
}

export function buildCascDatabase({ cascRoot = defaultCascRoot(), output = null, engineCaches = [], onProgress = () => {} } = {}) {
  cascRoot = path.resolve(cascRoot);
  const cascManifestFile = path.join(cascRoot, "manifest.json");
  if (!existsSync(cascManifestFile)) throw new Error(`缺少 CASC manifest：${cascManifestFile}`);
  const cascManifestBuffer = readFileSync(cascManifestFile);
  const cascManifest = JSON.parse(cascManifestBuffer.toString("utf8"));
  const build = path.basename(cascRoot);
  output = path.resolve(output ?? defaultDatabaseRoot(build));
  const filesRoot = path.join(cascRoot, "files");
  if (!existsSync(path.join(filesRoot, "mods"))) {
    throw new Error(`缺少 CASC files/mods：${path.join(filesRoot, "mods")}`);
  }

  const packages = [];
  for (const [id, relative] of PACKAGE_LAYOUT) {
    const root = path.join(filesRoot, ...relative.split("/"));
    if (!existsSync(root)) continue;
    packages.push({ id, root, loadOrder: packages.length });
  }
  if (!packages.some((entry) => entry.id === "starcoop.sc2mod")) {
    throw new Error("提取结果中缺少 Mods/StarCoop/StarCoop.SC2Mod，无法构建合作模式数据库");
  }

  const temporary = `${output}.building-${process.pid}`;
  if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { recursive: true });
  const databaseFile = path.join(temporary, "coop.sqlite");
  const database = new DatabaseSync(databaseFile);
  createSchema(database);
  const statements = prepareStatements(database);
  const warnings = [];
  const serializer = new XMLSerializer();
  const objectMaps = new Map();
  const objectSources = new Map();
  const definitionSources = new Map();
  const upgradeDefinitions = new Map();
  const candidates = catalogFileCandidates(packages);
  const catalogNames = discoverCatalogNames(candidates);
  let definitionOrder = 0;
  let catalogFileCount = 0;

  statements.meta.run("schemaVersion", String(DATABASE_SCHEMA_VERSION));
  statements.meta.run("catalogProjectionVersion", String(CATALOG_PROJECTION_VERSION));
  statements.meta.run("packageProfile", "official-coop-expansions-v2");
  statements.meta.run("sc2Build", build);
  statements.meta.run("sc2Version", String(cascManifest.source?.version ?? "unknown"));
  statements.meta.run("cascManifestSha256", sha256Buffer(cascManifestBuffer));
  statements.meta.run("createdAt", new Date().toISOString());
  for (const packageInfo of packages) {
    statements.package.run(
      packageInfo.id,
      packageInfo.loadOrder,
      packageInfo.root,
      packageInfo.id === "starcoop.sc2mod"
        ? "AlliedCommanders DocumentInfo direct dependency; built-in expansion profile excludes multiplayer branches"
        : "Built-in official co-op expansion profile; not a parsed DocumentInfo dependency graph",
    );
  }

  onProgress(`解析 ${candidates.length} 个 Catalog 候选文件...`);
  database.exec("BEGIN");
  try {
    for (const candidate of candidates) {
      const buffer = readFileSync(candidate.file);
      const sourceFile = `${candidate.id}:${candidate.relative}`;
      statements.sourceFile.run(
        candidate.id,
        candidate.relative,
        "catalog",
        sha256Buffer(buffer),
        buffer.length,
      );
      const document = parseXml(buffer.toString("utf8"), sourceFile, warnings);
      if (document.documentElement.tagName !== "Catalog") continue;
      catalogFileCount += 1;
      for (const definition of elementChildren(document.documentElement)) {
        if (!definition.tagName.startsWith("C")) continue;
        const catalog = catalogForClass(definition.tagName, catalogNames);
        const objectId = objectIdFor(definition);
        const parentId = getAttributeCaseInsensitive(definition, "parent");
        const isDefault = getAttributeCaseInsensitive(definition, "default") === "1" ? 1 : 0;
        const xml = serializer.serializeToString(definition);
        if (catalog === 'Upgrade') {
          if (!upgradeDefinitions.has(objectId)) upgradeDefinitions.set(objectId, []);
          upgradeDefinitions.get(objectId).push({ element: definition.cloneNode(true), sourceFile });
        }
        statements.definition.run(
          definitionOrder++,
          catalog,
          definition.tagName,
          objectId,
          parentId,
          isDefault,
          sourceFile,
          xml,
        );

        if (!objectMaps.has(catalog)) objectMaps.set(catalog, new Map());
        const objects = objectMaps.get(catalog);
        if (objects.has(objectId)) mergeElement(objects.get(objectId), definition);
        else objects.set(objectId, definition.cloneNode(true));
        objectSources.set(`${catalog}\u0000${objectId}`, sourceFile);

        const sourceMapKey = `${catalog}\u0000${objectId}`;
        if (!definitionSources.has(sourceMapKey)) definitionSources.set(sourceMapKey, new Map());
        const fieldSources = definitionSources.get(sourceMapKey);
        const flattened = flattenObject(definition);
        for (const removal of flattened.removals) deletePrefix(fieldSources, removal);
        for (const field of flattened.fields.values()) fieldSources.set(field.path, sourceFile);
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    database.close();
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }

  const directFields = new Map();
  const objectLookup = new Map();
  const ids = new Map();
  database.exec("BEGIN");
  try {
    const upgradeSources = normalizeUpgradeArrays({ objects: objectMaps.get('Upgrade') ?? new Map(),
      definitions: upgradeDefinitions, children: elementChildren, merge: mergeElement, flatten: flattenObject });
    for (const [objectId, sources] of upgradeSources) {
      const key = `Upgrade\u0000${objectId}`;
      const fields = definitionSources.get(key) ?? new Map();
      for (const field of fields.keys()) if (/^EffectArray(?:\[|\.|$)/.test(field)) fields.delete(field);
      for (const [field, source] of sources) fields.set(field, source);
      definitionSources.set(key, fields);
    }
    for (const [catalog, objects] of objectMaps) {
      for (const [objectId, element] of objects) {
        const key = `${catalog}\u0000${objectId}`;
        const sourceFile = objectSources.get(key);
        const parentId = getAttributeCaseInsensitive(element, "parent");
        const isDefault = getAttributeCaseInsensitive(element, "default") === "1" ? 1 : 0;
        statements.object.run(
          catalog,
          objectId,
          element.tagName,
          parentId,
          isDefault,
          sourceFile,
          serializer.serializeToString(element),
        );
        directFields.set(key, flattenObject(element));
        objectLookup.set(key, { catalog, objectId, element, sourceFile });
        const idKey = objectId.toLowerCase();
        if (!ids.has(idKey)) ids.set(idKey, []);
        ids.get(idKey).push({ catalog, objectId });
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    database.close();
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }

  const effectiveCache = new Map();
  function effectiveFieldsFor(key, chain = new Set()) {
    if (effectiveCache.has(key)) return effectiveCache.get(key);
    if (chain.has(key)) {
      warnings.push(`Catalog inheritance cycle: ${[...chain, key].join(" -> ")}`);
      return new Map();
    }
    const object = objectLookup.get(key);
    if (!object) return new Map();
    const nextChain = new Set(chain).add(key);
    const result = new Map();
    const classDefaultKey = `${object.catalog}\u0000@default:${object.element.tagName}`;
    if (classDefaultKey !== key && objectLookup.has(classDefaultKey)) {
      for (const [fieldPath, field] of effectiveFieldsFor(classDefaultKey, nextChain)) {
        result.set(fieldPath, { ...field, inheritanceDepth: field.inheritanceDepth + 1 });
      }
    }
    const parentId = getAttributeCaseInsensitive(object.element, "parent");
    const parentKey = parentId ? `${object.catalog}\u0000${parentId}` : null;
    if (parentKey && objectLookup.has(parentKey)) {
      for (const [fieldPath, field] of effectiveFieldsFor(parentKey, nextChain)) {
        result.set(fieldPath, { ...field, inheritanceDepth: field.inheritanceDepth + 1 });
      }
    }
    const direct = directFields.get(key);
    for (const removal of direct.removals) deletePrefix(result, removal);
    const sources = definitionSources.get(key) ?? new Map();
    for (const [fieldPath, field] of direct.fields) {
      result.set(fieldPath, {
        ...field,
        sourceFile: sources.get(fieldPath) ?? object.sourceFile,
        originObjectId: object.objectId,
        inheritanceDepth: 0,
      });
    }
    effectiveCache.set(key, result);
    return result;
  }

  onProgress(`解析 ${objectLookup.size} 个对象的继承和有效字段...`);
  let fieldCount = 0;
  database.exec("BEGIN");
  try {
    for (const [key, object] of objectLookup) {
      const effective = effectiveFieldsFor(key);
      for (const field of effective.values()) {
        statements.field.run(
          object.catalog,
          object.objectId,
          field.path,
          field.value,
          field.fieldTag,
          field.attribute,
          field.sourceFile,
          field.originObjectId,
          field.inheritanceDepth,
        );
        fieldCount += 1;
      }
      const searchBody = [...effective.values()].slice(0, 200).map((field) => `${field.path}=${field.value}`).join(" ");
      statements.search.run("catalog", `${object.catalog}/${object.objectId}`, object.objectId, `${object.element.tagName} ${searchBody}`);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    database.close();
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }

  onProgress("构建对象引用图...");
  let referenceCount = 0;
  database.exec("BEGIN");
  try {
    for (const [key, object] of objectLookup) {
      for (const field of effectiveFieldsFor(key).values()) {
        if (!field.value || field.value.length > 200 || /^[\d.+-]+$/.test(field.value)) continue;
        const compound = dataReference(field, catalogNames);
        if (compound) {
          const compoundTarget = (ids.get(compound.objectId.toLowerCase()) ?? []).find(
            (target) => target.catalog.toLowerCase() === compound.catalog.toLowerCase(),
          );
          if (compoundTarget) {
            statements.reference.run(
              object.catalog,
              object.objectId,
              field.path,
              compoundTarget.catalog,
              compoundTarget.objectId,
              1,
              `data-reference:${compound.targetFieldPath}`,
            );
            referenceCount += 1;
          }
          continue;
        }
        const hintedCatalog = inferReferenceCatalog(field, catalogNames, object);
        let targets = ids.get(field.value.toLowerCase()) ?? [];
        let confidence = 0.45;
        let evidence = "unique-object-id";
        if (hintedCatalog) {
          targets = targets.filter((target) => target.catalog.toLowerCase() === hintedCatalog.toLowerCase());
          confidence = 1;
          evidence = `field-hint:${hintedCatalog}`;
        } else if (targets.length !== 1) {
          continue;
        }
        for (const target of targets) {
          statements.reference.run(
            object.catalog,
            object.objectId,
            field.path,
            target.catalog,
            target.objectId,
            confidence,
            evidence,
          );
          referenceCount += 1;
        }
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    database.close();
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }

  onProgress("合并本地化文本并索引 Galaxy 符号...");
  let localizedCount = 0;
  let galaxyFileCount = 0;
  let galaxySymbolCount = 0;
  database.exec("BEGIN");
  try {
    for (const packageInfo of packages) {
      for (const file of walkFiles(packageInfo.root).sort()) {
        const relative = normalizeRelative(packageInfo.root, file);
        const lower = relative.toLowerCase();
        if (lower.endsWith(".txt") && lower.includes(".sc2data/localizeddata/")) {
          const localeMatch = /(?:^|\/)([a-z]{4})\.sc2data\/localizeddata\//i.exec(relative);
          if (!localeMatch) continue;
          const locale = localeMatch[1];
          const buffer = readFileSync(file);
          const sourceFile = `${packageInfo.id}:${relative}`;
          statements.sourceFile.run(packageInfo.id, relative, "localized-text", sha256Buffer(buffer), buffer.length);
          for (const [textKey, value] of parseLocalizedFile(buffer.toString("utf8"))) {
            statements.text.run(locale, textKey, value, sourceFile);
            localizedCount += 1;
          }
        } else if (lower.endsWith(".galaxy")) {
          const buffer = readFileSync(file);
          const contents = buffer.toString("utf8");
          const sourceFile = `${packageInfo.id}:${relative}`;
          statements.sourceFile.run(packageInfo.id, relative, "galaxy", sha256Buffer(buffer), buffer.length);
          statements.galaxyFile.run(sourceFile, packageInfo.id, sha256Buffer(buffer), contents);
          galaxyFileCount += 1;
          for (const symbol of extractGalaxySymbols(contents)) {
            statements.galaxySymbol.run(sourceFile, symbol.name, symbol.kind, symbol.line);
            galaxySymbolCount += 1;
          }
        }
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    database.close();
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }

  database.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)").run("galaxySymbolVersion", String(GALAXY_SYMBOL_VERSION));
  const textLookupStatement = database.prepare(
    "SELECT value FROM localized_text WHERE lower(locale) = lower(?) AND text_key = ?",
  );
  const localizedUnitIds = new Map();
  for (const row of database.prepare(`
    SELECT substr(text_key, 11) AS object_id, value
    FROM localized_text
    WHERE lower(locale) IN ('zhcn', 'enus') AND text_key LIKE 'Unit/Name/%'
  `).all()) {
    if (!objectLookup.has(`Unit\u0000${row.object_id}`)) continue;
    const normalized = row.value.split(/\s*\/{3}\s*/)[0].trim();
    if (!normalized) continue;
    if (!localizedUnitIds.has(normalized)) localizedUnitIds.set(normalized, []);
    localizedUnitIds.get(normalized).push(row.object_id);
  }
  const commanderObjects = [...objectLookup.values()].filter((object) => object.catalog === "Commander");
  const userObjects = new Map(
    [...objectLookup.values()]
      .filter((object) => object.catalog === "User")
      .map((object) => [object.objectId, object.element]),
  );
  const playerCommanders = objectLookup.get("User\u0000PlayerCommanders")?.element ?? null;
  const commanderData = [];
  for (const object of commanderObjects) {
    const referenceElement = elementChildren(object.element).find((child) => child.tagName === "UserReference");
    const userReference = referenceElement ? getAttributeCaseInsensitive(referenceElement, "value") : null;
    if (!userReference?.toLowerCase().startsWith("playercommanders;")) continue;
    const commanderId = userReference?.split(";").at(-1) || object.objectId;
    const instance = playerCommanders
      ? elementChildren(playerCommanders).find(
          (child) => child.tagName === "Instances" && getAttributeCaseInsensitive(child, "Id") === commanderId,
        )
      : null;
    const nameKey = instance ? firstFieldValue(instance, "Name") : null;
    const nameZh = nameKey ? textLookupStatement.get("zhCN", nameKey)?.value ?? null : null;
    const nameEn = nameKey ? textLookupStatement.get("enUS", nameKey)?.value ?? null : null;
    commanderData.push({ id: commanderId, objectId: object.objectId, userReference, nameKey, nameZh, nameEn, instance });
  }

  const outgoing = new Map();
  for (const row of database.prepare(
    "SELECT source_catalog, source_object_id, target_catalog, target_object_id FROM object_references WHERE confidence >= 0.9",
  ).all()) {
    const key = `${row.source_catalog}\u0000${row.source_object_id}`;
    if (!outgoing.has(key)) outgoing.set(key, []);
    outgoing.get(key).push({ catalog: row.target_catalog, objectId: row.target_object_id });
  }

  database.exec("BEGIN");
  try {
    for (const commander of commanderData) {
      statements.commander.run(
        commander.id,
        commander.objectId,
        commander.userReference,
        commander.nameKey,
        commander.nameZh,
        commander.nameEn,
      );
      statements.search.run(
        "commander",
        commander.id,
        commander.nameZh ?? commander.nameEn ?? commander.objectId,
        `${commander.objectId} ${commander.userReference ?? ""}`,
      );
      const { profile, strongLinks } = buildCommanderProfile({
        commander,
        userObjects,
        objectLookup,
        effectiveFieldsFor,
        textLookupStatement,
        localizedUnitIds,
      });
      statements.commanderProfile.run(commander.id, JSON.stringify(profile));
      const members = new Map();
      const addMember = (catalog, objectId, evidence, depth) => {
        const key = `${catalog}\u0000${objectId}`;
        const previous = members.get(key);
        if (!previous || depth < previous.depth) members.set(key, { catalog, objectId, evidence, depth });
      };
      addMember("Commander", commander.objectId, "commander-root", 0);
      for (const link of strongLinks) {
        addMember(
          link.catalog,
          link.objectId,
          `typed-userdata:${link.fieldId ?? link.catalog}`,
          0,
        );
      }

      let frontier = [...members.keys()];
      for (let depth = 1; depth <= 2 && members.size < 5000; depth += 1) {
        const next = [];
        for (const sourceKey of frontier) {
          for (const target of outgoing.get(sourceKey) ?? []) {
            const targetKey = `${target.catalog}\u0000${target.objectId}`;
            if (!members.has(targetKey)) {
              addMember(target.catalog, target.objectId, `reference-depth:${depth}`, depth);
              next.push(targetKey);
            }
          }
        }
        frontier = next;
      }
      for (const member of members.values()) {
        statements.membership.run(commander.id, member.catalog, member.objectId, member.evidence, member.depth);
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    database.close();
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }

  onProgress("解析本机合作模式语义层...");
  let semantics;
  try { semantics = buildCoopSemantics(database); }
  catch (error) {
    database.close();
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }

  onProgress("写出 PatchPlan 兼容的 merged/GameData...");
  const mergedRoot = path.join(temporary, "merged", "GameData");
  mkdirSync(mergedRoot, { recursive: true });
  const includeLines = [];
  for (const [catalog, objects] of [...objectMaps.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (catalog === "Unknown") continue;
    const fileName = `${catalog}Data.xml`;
    const lines = ['<?xml version="1.0" encoding="utf-8"?>', "<Catalog>"];
    for (const element of objects.values()) lines.push(`    ${serializer.serializeToString(element)}`);
    lines.push("</Catalog>", "");
    writeFileSync(path.join(mergedRoot, fileName), lines.join("\n"), "utf8");
    includeLines.push(`    <Catalog path="GameData/${fileName}"/>`);
  }
  writeFileSync(
    path.join(temporary, "merged", "GameData.xml"),
    ['<?xml version="1.0" encoding="utf-8"?>', "<Includes>", ...includeLines, "</Includes>", ""].join("\n"),
    "utf8",
  );

  const acceptance = {
    integrity:
      database.prepare("PRAGMA integrity_check").get().integrity_check === "ok",
    raynorCommander: Boolean(
      database.prepare("SELECT 1 FROM commanders WHERE id='TerranRaynor'").get(),
    ),
    hyperionUnit: Boolean(
      database
        .prepare("SELECT 1 FROM catalog_objects WHERE catalog='Unit' AND object_id='HyperionVoidCoop'")
        .get(),
    ),
    hyperionSummonChain: Boolean(
      database
        .prepare(`
          SELECT 1
          FROM object_references ability_effect
          JOIN object_references effect_unit
            ON effect_unit.source_catalog=ability_effect.target_catalog
           AND effect_unit.source_object_id=ability_effect.target_object_id
          WHERE ability_effect.source_catalog='Abil'
            AND ability_effect.source_object_id='VoidCoopSummonHyperion'
            AND ability_effect.target_catalog='Effect'
            AND effect_unit.target_catalog='Unit'
            AND effect_unit.target_object_id='HyperionVoidCoop'
        `)
        .get(),
    ),
    raynorBarracksCampaignUnits: Boolean(
      database
        .prepare(`
          SELECT 1
          FROM catalog_fields medic
          JOIN catalog_fields firebat
            ON firebat.catalog=medic.catalog
           AND firebat.object_id=medic.object_id
          WHERE medic.catalog='Abil'
            AND medic.object_id='BarracksTrain'
            AND medic.path='InfoArray[Train5].Unit'
            AND medic.value='Medic'
            AND firebat.path='InfoArray[Train6].Unit'
            AND firebat.value='Firebat'
        `)
        .get(),
    ),
  };
  acceptance.passed = Object.values(acceptance).every(Boolean);
  if (!acceptance.passed) {
    warnings.push(`Co-op dependency acceptance failed: ${JSON.stringify(acceptance)}`);
  }

  database.exec("PRAGMA optimize");
  database.close();
  const engineImports = engineCaches.map((cachePath) => importEngineCatalog(databaseFile, readEngineCache(cachePath), { cachePath }));
  const report = {
    schemaVersion: DATABASE_SCHEMA_VERSION,
    catalogProjectionVersion: CATALOG_PROJECTION_VERSION,
    packageProfile: "official-coop-expansions-v2",
    sc2Build: build,
    packages: packages.map((entry) => entry.id),
    stats: {
      catalogFiles: catalogFileCount,
      catalogDefinitions: definitionOrder,
      catalogObjects: objectLookup.size,
      unknownCatalogObjects: objectMaps.get("Unknown")?.size ?? 0,
      effectiveFields: fieldCount,
      references: referenceCount,
      localizedEntriesProcessed: localizedCount,
      galaxyFiles: galaxyFileCount,
      galaxySymbols: galaxySymbolCount,
      commanders: commanderData.length,
    },
    acceptance,
    semantics,
    engineImports,
    projectionSources: { legacy: "interpreted-not-engine-verified", engineCoverage: engineImports.length ? "partial" : "none" },
    warnings,
  };
  writeFileSync(path.join(temporary, "build-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(
    path.join(temporary, "manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: DATABASE_SCHEMA_VERSION,
        catalogProjectionVersion: CATALOG_PROJECTION_VERSION,
        packageProfile: "official-coop-expansions-v2",
        createdAt: new Date().toISOString(),
        source: {
          cascRoot,
          cascManifestSha256: sha256Buffer(cascManifestBuffer),
          sc2Build: build,
          sc2Version: cascManifest.source?.version ?? null,
        },
        outputs: { database: "coop.sqlite", mergedGameData: "merged/GameData" },
        packages: packages.map((entry) => ({ id: entry.id, loadOrder: entry.loadOrder })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  atomicInstallDirectory(temporary, output);
  return { output, databaseFile: path.join(output, "coop.sqlite"), report };
}
