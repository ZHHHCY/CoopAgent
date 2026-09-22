import { operationTargets } from "../../../scripts/lib/patch-plan-executor.mjs";
import { canonicalEditPath } from "../../../scripts/lib/catalog-edit-contract.mjs";
import {upgradeOperandScope,masteryMetadataScope} from './definition-scope.mjs';
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DOMParser } from "@xmldom/xmldom";
import { attachEngineCatalog } from "../../../scripts/lib/engine-catalog-store.mjs";

const GUARDED_OPERATION_KINDS = new Set([
  "catalog.set",
  "catalog.remove",
  "commander.stat.set",
]);

const DIRECT_CATALOG_WRITE_KINDS = new Set([
  "catalog.set",
  "catalog.remove",
  "catalog.insert",
  "catalog.clear",
]);

function isUnitCreationReference(reference) {
  const sourceCatalog = String(reference.catalog ?? reference.sourceCatalog ?? "").toLowerCase();
  const sourceClass = String(reference.sourceClass ?? "").toLowerCase();
  const fieldPath = String(reference.fieldPath ?? "").toLowerCase();
  if (sourceCatalog === "abil") return true;
  if (sourceCatalog === "effect") {
    return fieldPath.includes("spawnunit") ||
      fieldPath.includes("createunit") ||
      fieldPath.includes("placeholderunit") ||
      fieldPath.includes("unit");
  }
  if (sourceCatalog === "unit" && fieldPath.includes("producedunit")) return true;
  if (fieldPath.includes("startingunit")) return true;
  return sourceClass.includes("train") ||
    sourceClass.includes("build") ||
    sourceClass.includes("morph") ||
    sourceClass.includes("revive");
}

const VITAL_START_PATHS = new Map([
  ["LifeMax", "LifeStart"],
  ["ShieldsMax", "ShieldsStart"],
  ["EnergyMax", "EnergyStart"],
]);

const UNIT_CLONE_MODEL_FIELDS = new Set([
  "Model",
  "BuildModel",
  "PlacementModel",
  "PortraitModel",
]);

const UNIT_CLONE_PRESENTATION_FIELDS = new Set([
  "BuildModel",
  "GroupIcon.Image",
  "HeroIcon",
  "PlacementModel",
  "PortraitActor",
  "PortraitModel",
  "ShieldArmorIcon",
  "UnitIcon",
  "Wireframe.Image",
]);

function isUnitClonePresentationField(fieldPath) {
  return UNIT_CLONE_PRESENTATION_FIELDS.has(fieldPath) ||
    /^(?:Minimap|StatusBar|StatusColors|StatusTextInfo)/.test(fieldPath);
}

const UNIT_CLONE_VITAL_PAIRS = [
  ["LifeMax", "LifeStart"],
  ["ShieldsMax", "ShieldsStart"],
  ["EnergyMax", "EnergyStart"],
];

const SAFE_PATH_CORRECTIONS = new Map([
  ["LiefMax", "LifeMax"],
  ["LiefStart", "LifeStart"],
  ["ShieldMax", "ShieldsMax"],
  ["ShieldStart", "ShieldsStart"],
]);

function hasOwn(value, property) {
  return value !== null && typeof value === "object" && Object.hasOwn(value, property);
}

function stableCompare(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function displayValue(value) {
  if (value === undefined) return "an unspecified value";
  return JSON.stringify(value);
}

function semanticScalarEquals(actual, expected) {
  if (actual === null || expected === null) return actual === expected;
  if (typeof expected === "number") {
    return actual !== "" && Number.isFinite(Number(actual)) && Number(actual) === expected;
  }
  if (typeof expected === "boolean") {
    return expected
      ? actual === true || actual === "1" || String(actual).toLowerCase() === "true"
      : actual === false || actual === "0" || String(actual).toLowerCase() === "false";
  }
  return String(actual) === String(expected);
}

function pathLeaf(catalogPath) {
  if (typeof catalogPath !== "string") return "";
  const leaf = catalogPath.split(".").at(-1) ?? "";
  return leaf.replace(/\[[^\]]*\]/g, "").replace(/^@/, "");
}

function nonNegativeIntegerIndex(value) {
  const text = String(value);
  if (!/^(0|[1-9]\d*)$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function equivalentOrdinalPrefixes(pathValue) {
  let prefixes = [String(pathValue)];
  const matches = [...String(pathValue).matchAll(/\[(\d+)\]/g)];
  for (const match of matches) {
    const literal = `[${match[1]}]`;
    const ordinal = `[#${match[1]}]`;
    prefixes = [...new Set(prefixes.flatMap((prefix) => [
      prefix,
      prefix.replace(literal, ordinal),
    ]))];
  }
  return prefixes;
}

function implicitOrdinalOccupancy(paths, collectionPath) {
  let occupied = 0;
  for (const prefix of equivalentOrdinalPrefixes(collectionPath)) {
    const pattern = new RegExp(`^${regexEscape(prefix)}\\[#(\\d+)\\](?:\\.|$)`);
    let highest = -1;
    for (const fieldPath of paths) {
      const match = String(fieldPath).match(pattern);
      if (match) highest = Math.max(highest, Number(match[1]));
    }
    occupied += highest + 1;
  }
  return occupied;
}

function directElementChildren(element) {
  return [...element.childNodes].filter((node) => node.nodeType === 1);
}

function addKnownAbility(known, unitId, abilityId) {
  if (!unitId || !abilityId) return;
  const abilities = known.get(unitId) ?? new Set();
  abilities.add(abilityId);
  known.set(unitId, abilities);
}

function readCoreUnitAbilities(coreRoot) {
  const known = new Map();
  const parents = new Map();
  if (!coreRoot) return { known, parents };
  const file = path.join(coreRoot, "Base.SC2Data", "GameData", "UnitData.xml");
  if (!existsSync(file)) return { known, parents };
  const document = new DOMParser().parseFromString(readFileSync(file, "utf8"), "application/xml");
  for (const unit of [...document.getElementsByTagName("CUnit")]) {
    const unitId = unit.getAttribute("id");
    if (!unitId) continue;
    const parent = unit.getAttribute("parent");
    if (parent) parents.set(unitId, parent);
    for (const ability of directElementChildren(unit).filter((child) => child.tagName === "AbilArray")) {
      if (ability.getAttribute("removed") === "1") continue;
      const index = ability.getAttribute("index");
      if (index !== null && nonNegativeIntegerIndex(index) === null) continue;
      addKnownAbility(known, unitId, ability.getAttribute("Link"));
    }
  }
  return { known, parents };
}

function normalizedArrayIndex(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const raw = String(value);
  // CASC projection uses #n for the nth unindexed array entry.  It is not the
  // same entry as an explicitly indexed [n] value; both may legitimately be
  // present after inheritance has been resolved.
  if (/^#\d+$/.test(raw)) return raw;
  const normalized = raw;
  return /^(0|[1-9]\d*)$/.test(normalized) ? Number(normalized) : normalized;
}

function comparableArrayIndex(value) {
  const normalized = String(value).replace(/^#/, "");
  return /^(0|[1-9]\d*)$/.test(normalized) ? Number(normalized) : normalized;
}

function emptyProjectedUnitState() {
  return { abilities: new Map(), commands: new Map() };
}

function cloneProjectedUnitState(state) {
  return {
    abilities: new Map(state.abilities),
    commands: new Map([...state.commands].map(([key, value]) => [key, {
      ...value,
      attributes: { ...value.attributes },
    }])),
  };
}

function commandStateKey(cardIndex, slotIndex) {
  return `${cardIndex}/${slotIndex}`;
}

function parseDatabaseUnitState(database, unitId) {
  const state = emptyProjectedUnitState();
  const rows = database.prepare(`
    SELECT path, value FROM catalog_fields
    WHERE catalog='Unit' AND object_id=?
    ORDER BY path
  `).all(unitId);
  for (const row of rows) {
    const ability = /^AbilArray(?:\[(#?\d+)\])?\.\@?Link$/i.exec(row.path);
    if (ability) {
      const index = normalizedArrayIndex(ability[1], state.abilities.size);
      state.abilities.set(String(index), row.value);
      continue;
    }
    const command = /^CardLayouts(?:\[(#?\d+)\])?\.LayoutButtons(?:\[(#?\d+)\])?\.\@?([A-Za-z_][A-Za-z0-9_]*)$/i.exec(row.path);
    if (!command) continue;
    const cardIndex = normalizedArrayIndex(command[1], 0);
    const slotIndex = normalizedArrayIndex(command[2], "implicit");
    const key = commandStateKey(cardIndex, slotIndex);
    const entry = state.commands.get(key) ?? {
      cardIndex,
      slotIndex,
      attributes: {},
      source: "database",
    };
    entry.attributes[command[3]] = row.value;
    state.commands.set(key, entry);
  }
  return state;
}

function elementAttributes(element) {
  const attributes = {};
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    if (!["index", "removed"].includes(attribute.name)) attributes[attribute.name] = attribute.value;
  }
  return attributes;
}

function applyCoreUnitObject(state, unit) {
  let implicitAbility = state.abilities.size;
  let implicitCard = 0;
  for (const child of directElementChildren(unit)) {
    if (child.tagName === "AbilArray") {
      const index = normalizedArrayIndex(child.getAttribute("index"), implicitAbility++);
      if (child.getAttribute("removed") === "1") state.abilities.delete(String(index));
      else if (child.hasAttribute("Link")) state.abilities.set(String(index), child.getAttribute("Link"));
      continue;
    }
    if (child.tagName !== "CardLayouts") continue;
    const cardIndex = normalizedArrayIndex(child.getAttribute("index"), implicitCard++);
    let implicitButton = 0;
    for (const button of directElementChildren(child).filter((entry) => entry.tagName === "LayoutButtons")) {
      const slotIndex = normalizedArrayIndex(button.getAttribute("index"), `implicit-${implicitButton++}`);
      const key = commandStateKey(cardIndex, slotIndex);
      if (button.getAttribute("removed") === "1") state.commands.delete(key);
      else {
        state.commands.set(key, {
          cardIndex,
          slotIndex,
          attributes: elementAttributes(button),
          source: "game-a-core",
        });
      }
    }
  }
}

function applyPlanToProjectedUnitState(state, plan, unitId) {
  for (const operation of plan.operations ?? []) {
    if (operation.catalog !== "Unit" || operation.object !== unitId) continue;
    if (operation.kind === "catalog.clear" && operation.path === "AbilArray") {
      state.abilities.clear();
      continue;
    }
    const clearCommands = operation.kind === "catalog.clear" &&
      /^CardLayouts\[(\d+)\]\.LayoutButtons$/i.exec(operation.path ?? "");
    if (clearCommands) {
      const cardIndex = Number(clearCommands[1]);
      for (const [key, command] of state.commands) {
        if (comparableArrayIndex(command.cardIndex) === cardIndex) state.commands.delete(key);
      }
      continue;
    }
    if (operation.kind === "catalog.insert" && operation.path === "AbilArray") {
      state.abilities.set(String(operation.index), String(operation.attributes?.Link ?? operation.value ?? ""));
      continue;
    }
    const insertedCommand = operation.kind === "catalog.insert" &&
      /^CardLayouts\[(\d+)\]\.LayoutButtons$/i.exec(operation.path ?? "");
    if (insertedCommand) {
      const cardIndex = Number(insertedCommand[1]);
      const slotIndex = operation.index;
      state.commands.set(commandStateKey(cardIndex, slotIndex), {
        cardIndex,
        slotIndex,
        attributes: Object.fromEntries(
          Object.entries(operation.attributes ?? {}).map(([key, value]) => [key, String(value)]),
        ),
        source: "patch-plan",
      });
      continue;
    }
    const setAbility = operation.kind === "catalog.set" &&
      /^AbilArray\[(\d+)\]\.\@?Link$/i.exec(operation.path ?? "");
    if (setAbility) {
      state.abilities.set(setAbility[1], String(operation.value));
      continue;
    }
    const removeAbility = operation.kind === "catalog.remove" &&
      /^AbilArray\[(\d+)\]$/i.exec(operation.path ?? "");
    if (removeAbility) {
      state.abilities.delete(removeAbility[1]);
      continue;
    }
    const commandField = operation.kind === "catalog.set" &&
      /^CardLayouts\[(\d+)\]\.LayoutButtons\[(\d+)\]\.\@?([A-Za-z_][A-Za-z0-9_]*)$/i.exec(operation.path ?? "");
    if (commandField) {
      const cardIndex = Number(commandField[1]);
      const slotIndex = Number(commandField[2]);
      const key = commandStateKey(cardIndex, slotIndex);
      const entry = state.commands.get(key) ?? {
        cardIndex,
        slotIndex,
        attributes: {},
        source: "patch-plan",
      };
      entry.attributes[commandField[3]] = String(operation.value);
      state.commands.set(key, entry);
      continue;
    }
    const removeCommand = operation.kind === "catalog.remove" &&
      /^CardLayouts\[(\d+)\]\.LayoutButtons\[(\d+)\]$/i.exec(operation.path ?? "");
    if (removeCommand) {
      state.commands.delete(commandStateKey(Number(removeCommand[1]), Number(removeCommand[2])));
    }
  }
}

function parseSimpleCatalogPath(value) {
  return String(value).split(".").map((segment) => {
    if (segment.startsWith("@")) return { attribute: segment.slice(1) };
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[([^\]]+)\])?$/.exec(segment);
    return match ? { name: match[1], index: match[2] } : null;
  });
}

function readDirectCoreField(object, fieldPath) {
  const segments = parseSimpleCatalogPath(fieldPath);
  if (segments.some((segment) => !segment)) return undefined;
  let current = object;
  for (const segment of segments) {
    if (segment.attribute) {
      return current.hasAttribute(segment.attribute) ? current.getAttribute(segment.attribute) : undefined;
    }
    current = directElementChildren(current).find((child) =>
      child.tagName === segment.name &&
      (segment.index === undefined || child.getAttribute("index") === String(segment.index)));
    if (!current || current.getAttribute("removed") === "1") return undefined;
  }
  if (current.hasAttribute("value")) return current.getAttribute("value");
  return true;
}

function flattenDirectCoreFields(object) {
  const fields = new Map();
  const visit = (current, parentPath) => {
    const children = directElementChildren(current);
    const counts = new Map();
    for (const child of children) {
      const tag = child.tagName.toLowerCase();
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    const ordinals = new Map();
    for (const child of children) {
      const tag = child.tagName.toLowerCase();
      const explicitIndex = child.getAttribute("index");
      const ordinal = ordinals.get(tag) ?? 0;
      ordinals.set(tag, ordinal + 1);
      const segment = explicitIndex !== null
        ? `${child.tagName}[${explicitIndex}]`
        : counts.get(tag) > 1 ? `${child.tagName}[#${ordinal}]` : child.tagName;
      const fieldPath = parentPath ? `${parentPath}.${segment}` : segment;
      if (child.getAttribute("removed") === "1") {
        fields.set(fieldPath, undefined);
        continue;
      }
      let wroteScalar = false;
      for (let index = 0; index < child.attributes.length; index += 1) {
        const attribute = child.attributes.item(index);
        if (["index", "removed"].includes(attribute.name.toLowerCase())) continue;
        fields.set(
          attribute.name.toLowerCase() === "value" ? fieldPath : `${fieldPath}.@${attribute.name}`,
          attribute.value,
        );
        wroteScalar = true;
      }
      if (!wroteScalar && directElementChildren(child).length === 0) {
        const value = [...child.childNodes]
          .filter((node) => node.nodeType === 3)
          .map((node) => node.data)
          .join("")
          .trim();
        if (value) fields.set(fieldPath, value);
      }
      visit(child, fieldPath);
    }
  };
  visit(object, "");
  return fields;
}

function parseStaticScalar(value) {
  if (value === undefined || value === null || value === "") return { known: false, value: null };
  if (value === true || value === false || typeof value === "number") return { known: true, value };
  const text = String(value).trim();
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(text)) return { known: true, value: Number(text) };
  if (text.toLowerCase() === "true") return { known: true, value: true };
  if (text.toLowerCase() === "false") return { known: true, value: false };
  return { known: true, value: text };
}

function staticTruth(value) {
  if (!value.known) return null;
  if (typeof value.value === "number") return value.value !== 0;
  if (typeof value.value === "boolean") return value.value;
  return String(value.value).length > 0;
}

function normalizeRequirement(value) {
  return value === undefined || value === null || String(value).trim() === ""
    ? null
    : String(value);
}

function truthyCatalogValue(value) {
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function inheritKnownAbilities(known, parents) {
  let changed = true;
  for (let pass = 0; pass < 32 && changed; pass += 1) {
    changed = false;
    for (const [unitId, parentId] of parents) {
      const parent = known.get(parentId);
      if (!parent) continue;
      const abilities = known.get(unitId) ?? new Set();
      const before = abilities.size;
      for (const abilityId of parent) abilities.add(abilityId);
      known.set(unitId, abilities);
      if (abilities.size !== before) changed = true;
    }
  }
}

function planButtonCommands(plan) {
  const buttons = [];
  for (const operation of plan.operations ?? []) {
    if (operation.catalog !== "Unit") continue;
    if (
      operation.kind === "catalog.insert" &&
      /^CardLayouts\[[^\]]+\]\.LayoutButtons$/.test(operation.path) &&
      typeof operation.attributes?.AbilCmd === "string"
    ) {
      buttons.push({
        operation,
        unitId: operation.object,
        abilityCommand: operation.attributes.AbilCmd,
        face: operation.attributes.Face ?? null,
        slot: nonNegativeIntegerIndex(operation.index),
      });
    }
    if (
      operation.kind === "catalog.set" &&
      /^CardLayouts\[[^\]]+\]\.LayoutButtons\[[^\]]+\]\.@?AbilCmd$/i.test(operation.path) &&
      typeof operation.value === "string"
    ) {
      const slotMatch = operation.path.match(/\.LayoutButtons\[(\d+)\]/i);
      buttons.push({
        operation,
        unitId: operation.object,
        abilityCommand: operation.value,
        face: null,
        slot: slotMatch ? Number(slotMatch[1]) : null,
      });
    }
  }
  return buttons;
}

function applyPlanAbilityAttachments(plan, known, parents) {
  for (const operation of plan.operations ?? []) {
    if (operation.kind === "catalog.clone" && operation.catalog === "Unit") {
      parents.set(operation.object, operation.source);
    }
    if (operation.kind === "catalog.create" && operation.catalog === "Unit" && operation.parent) {
      parents.set(operation.object, operation.parent);
    }
    if (operation.kind === "commander.unit.clone") {
      parents.set(operation.unitId, operation.sourceUnit);
    }
    if (
      operation.kind === "catalog.insert" &&
      operation.catalog === "Unit" &&
      operation.path === "AbilArray" &&
      nonNegativeIntegerIndex(operation.index) !== null
    ) {
      addKnownAbility(known, operation.object, operation.attributes?.Link);
    }
    if (
      operation.kind === "catalog.set" &&
      operation.catalog === "Unit" &&
      /^AbilArray\[\d+\]\.@?Link$/i.test(operation.path)
    ) {
      addKnownAbility(known, operation.object, operation.value);
    }
  }
  inheritKnownAbilities(known, parents);
}

function cleanLocalizedName(value) {
  return String(value ?? "").split(/\s*\/{3}\s*/)[0].trim();
}

const USER_FIELD_LABELS = new Map([
  ["LifeMax", "最大生命值"],
  ["LifeStart", "初始生命值"],
  ["ShieldsMax", "最大护盾"],
  ["ShieldsStart", "初始护盾"],
  ["EnergyMax", "最大能量"],
  ["EnergyStart", "初始能量"],
  ["LifeArmor", "护甲"],
  ["Radius", "体积半径"],
  ["Speed", "移动速度"],
  ["Sight", "视野"],
]);

function structuredChangeText(operation, label) {
  const subject = operation.catalog && operation.object
    ? label(operation.catalog, operation.object)
    : null;
  const leaf = pathLeaf(operation.path);
  const field = USER_FIELD_LABELS.get(leaf) ?? leaf;
  switch (operation.kind) {
    case "catalog.set":
    case "commander.stat.set":
      return `${subject ?? operation.object} · ${field} ${displayValue(operation.expect)} → ${displayValue(operation.value)}`;
    case "catalog.remove":
      return `${subject ?? operation.object} · 移除 ${operation.path}`;
    case "catalog.clear":
      return `${subject ?? operation.object} · 清空 ${operation.path}`;
    case "catalog.create":
      return `新增 ${operation.catalog} · ${operation.object}`;
    case "catalog.clone":
      return `${label(operation.catalog, operation.source)} → ${operation.object}`;
    case "catalog.insert":
      return `${subject ?? operation.object} · 新增 ${operation.path}[${displayValue(operation.index)}]`;
    case "commander.unit.clone":
      return `${label("Unit", operation.sourceUnit)} → ${operation.unitId}`;
    case "galaxy.source":
      return `新增机制脚本 · ${operation.path}`;
    case "locale.set":
      return `${operation.locale} 文本 · ${operation.key}`;
    case "file.patch":
      return `更新源码 · ${operation.path}`;
    default:
      return `${operation.kind ?? "未知操作"} · ${operation.opId ?? "未命名"}`;
  }
}

function buildStructuredChangeItems(plan, label) {
  return (plan.operations ?? []).map((operation, index) => {
    const catalogTargets = [];
    if (operation.catalog && operation.object) {
      catalogTargets.push({
        catalog: operation.catalog,
        objectId: operation.object,
        path: operation.path ?? null,
      });
    }
    if (operation.kind === "catalog.clone" && operation.catalog && operation.source) {
      catalogTargets.push({ catalog: operation.catalog, objectId: operation.source, path: null });
    }
    if (operation.kind === "commander.unit.clone") {
      catalogTargets.push(
        { catalog: "Unit", objectId: operation.sourceUnit, path: null },
        { catalog: "Unit", objectId: operation.unitId, path: null },
      );
    }
    return {
      id: operation.opId ?? `operation-${index + 1}`,
      text: structuredChangeText(operation, label),
      opIds: [operation.opId ?? `operation-${index + 1}`],
      kind: operation.kind ?? "unknown",
      commanderId: operation.commanderId ?? null,
      catalogTargets,
      before: hasOwn(operation, "expect") ? operation.expect : null,
      after: hasOwn(operation, "value") ? operation.value : null,
      field: operation.path ?? null,
    };
  });
}

function buildUserSummary(plan, names = new Map()) {
  const label = (catalog, objectId) => names.get(`${catalog}/${objectId}`.toLowerCase()) ?? objectId;
  const controlledSummary = typeof plan.userSummary?.text === "string"
    ? plan.userSummary.text.trim()
    : "";
  const items = [];
  const buttonOperations = new Set();
  const buttons = planButtonCommands(plan);
  const visibleAbilityIds = new Set();
  for (const button of buttons) {
    const [abilityId, command = "Execute"] = button.abilityCommand.split(",");
    if (!abilityId || /^\d+$/.test(abilityId)) continue;
    visibleAbilityIds.add(abilityId);
    buttonOperations.add(button.operation.opId);
    const unitName = label("Unit", button.unitId);
    const abilityName = button.face ? label("Button", button.face) : abilityId;
    const abilityOperations = (plan.operations ?? []).filter((operation) =>
      operation.catalog === "Abil" && operation.object === abilityId && operation.kind === "catalog.set");
    const range = abilityOperations.find((operation) => pathLeaf(operation.path) === "Range")?.value;
    const cooldown = abilityOperations.find((operation) => pathLeaf(operation.path) === "TimeUse")?.value;
    const facts = [
      range === undefined ? null : `距离 ${displayValue(range)}`,
      cooldown === undefined ? null : `冷却 ${displayValue(cooldown)} 秒`,
    ].filter(Boolean);
    items.push(
      `${unitName}新增或配置可见技能“${abilityName}”（${abilityId},${command}）${button.slot === null ? "" : `，命令卡槽 ${button.slot}`}${facts.length > 0 ? `，${facts.join("，")}` : ""}。`,
    );
  }

  for (const operation of plan.operations ?? []) {
    if (!["catalog.set", "commander.stat.set"].includes(operation.kind)) continue;
    if (buttonOperations.has(operation.opId) || /^(AbilArray|CardLayouts)/.test(operation.path ?? "")) continue;
    if (
      visibleAbilityIds.size > 0 &&
      ["Abil", "Effect", "Requirement", "Validator", "Behavior", "Button"].includes(operation.catalog)
    ) continue;
    const subject = label(operation.catalog, operation.object);
    const leaf = pathLeaf(operation.path);
    const field = USER_FIELD_LABELS.get(leaf) ?? leaf;
    items.push(`${subject} · ${field} ${displayValue(operation.expect)} → ${displayValue(operation.value)}`);
  }
  for (const operation of plan.operations ?? []) {
    if (operation.kind !== "commander.unit.clone") continue;
    items.push(`${label("Unit", operation.sourceUnit)}克隆为 ${label("Unit", operation.unitId)}。`);
  }

  const unique = [...new Set(items)];
  const changeItems = buildStructuredChangeItems(plan, label);
  if (controlledSummary) {
    unique.length = 0;
    unique.push(controlledSummary);
  } else {
    if (unique.length === 0) unique.push(...changeItems.slice(0, 6).map((item) => item.text));
    if (unique.length === 0 && plan.title) unique.push(plan.title);
  }
  return {
    headline: plan.title ?? plan.id ?? "PatchPlan 修改",
    items: unique.slice(0, 6),
    truncated: controlledSummary ? false : unique.length > 6,
    changeItems,
    verificationLevel: "static-review",
    verificationLabel: "仅完成静态语义审查；尚未执行沙盒预演、写入地图运行层或试玩验证。",
    runtimeVerified: false,
  };
}

function operationSystem(operation) {
  switch (operation.kind) {
    case "catalog.set":
    case "catalog.remove":
    case "catalog.create":
    case "catalog.clone":
    case "catalog.insert":
    case "catalog.clear":
      return `Catalog/${operation.catalog ?? "unknown"}`;
    case "commander.stat.set":
    case "commander.unit.clone":
      return `Commander/${operation.commanderId ?? "unknown"}`;
    case "galaxy.source":
      return "Galaxy";
    case "locale.set":
      return `Localization/${operation.locale ?? "unknown"}`;
    case "file.patch":
      return "Files";
    default:
      return "Unknown";
  }
}

export function patchOperationTarget(operation) {
  return operationTargets(operation)[0];
}

function operationResult(operation) {
  switch (operation.kind) {
    case "catalog.set":
    case "commander.stat.set":
      return { action: "set", value: operation.value };
    case "catalog.remove":
      return { action: "remove" };
    case "catalog.clear":
      return { action: "clear" };
    case "catalog.create":
      return { action: "create", class: operation.class, parent: operation.parent ?? null };
    case "catalog.clone":
      return { action: "clone", source: operation.source, object: operation.object };
    case "catalog.insert":
      return {
        action: "insert",
        index: operation.index,
        ...(hasOwn(operation, "value") ? { value: operation.value } : {}),
        ...(operation.attributes ? { attributes: operation.attributes } : {}),
      };
    case "commander.unit.clone":
      return {
        action: "clone-unit",
        sourceUnit: operation.sourceUnit,
        unitId: operation.unitId,
        actorId: operation.actorId ?? operation.unitId,
        redirectCount: Array.isArray(operation.redirects) ? operation.redirects.length : 0,
      };
    case "galaxy.source":
      return {
        action: "write-galaxy-source",
        registrationOrder: operation.register?.order,
        init: operation.register?.init ?? null,
      };
    case "locale.set":
      return { action: "set-localized-text", value: operation.value };
    case "file.patch":
      return { action: "apply-file-patch", baseSha256: operation.baseSha256 };
    default:
      return { action: "unknown" };
  }
}

function operationSummary(operation, target) {
  switch (operation.kind) {
    case "catalog.set":
    case "commander.stat.set":
      return `Set ${target} to ${displayValue(operation.value)}.`;
    case "catalog.remove":
      return `Remove ${target}.`;
    case "catalog.clear":
      return `Clear ${target}.`;
    case "catalog.create":
      return `Create ${target} as ${operation.class}${operation.parent ? ` with parent ${operation.parent}` : ""}.`;
    case "catalog.clone":
      return `Clone ${operation.catalog}/${operation.source} as ${operation.object}.`;
    case "catalog.insert":
      return `Insert entry ${displayValue(operation.index)} into ${target}.`;
    case "commander.unit.clone":
      return `Clone ${operation.sourceUnit} as ${operation.unitId} for ${operation.commanderId}.`;
    case "galaxy.source":
      return `Write and register Galaxy source ${operation.path}.`;
    case "locale.set":
      return `Set ${operation.locale} localized text ${operation.key}.`;
    case "file.patch":
      return `Apply a guarded patch to ${operation.path}.`;
    default:
      return `Execute ${operation.kind ?? "unknown operation"} at ${target}.`;
  }
}

export function projectPatchOperation(operation, index = 0) {
  const targets = operationTargets(operation);
  const target = targets[0];
  const guarded = hasOwn(operation, "expect");
  return {
    index: index + 1,
    opId: operation.opId ?? `operation-${index + 1}`,
    kind: operation.kind ?? "unknown",
    system: operationSystem(operation),
    target,
    targets,
    summary: operationSummary(operation, target),
    precondition: guarded
      ? { type: "expect", value: operation.expect }
      : operation.expectAbsent === true
        ? { type: "expect-absent" }
        : hasOwn(operation, "baseSha256")
          ? { type: "sha256", value: operation.baseSha256 }
          : hasOwn(operation, "expectSha256")
            ? { type: "sha256", value: operation.expectSha256 }
            : { type: "none" },
    result: operationResult(operation),
  };
}

function vitalScope(operation) {
  if (operation.catalog !== "Unit") return null;
  if (operation.kind === "commander.stat.set") {
    return `commander/${operation.commanderId}/Unit/${operation.object}`;
  }
  if (["catalog.set", "catalog.remove", "catalog.clear"].includes(operation.kind)) {
    return `catalog/Unit/${operation.object}`;
  }
  return null;
}

function diagnostic({ severity = "warning", code, operation, target, message, details }) {
  return {
    severity,
    code,
    opId: operation?.opId ?? null,
    target: target ?? null,
    message,
    ...(details ? { details } : {}),
  };
}

function damerauLevenshtein(left, right) {
  const rows = left.length + 1;
  const columns = right.length + 1;
  const matrix = Array.from({ length: rows }, () => Array(columns).fill(0));
  for (let row = 0; row < rows; row += 1) matrix[row][0] = row;
  for (let column = 0; column < columns; column += 1) matrix[0][column] = column;
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      matrix[row][column] = Math.min(
        matrix[row - 1][column] + 1,
        matrix[row][column - 1] + 1,
        matrix[row - 1][column - 1] + cost,
      );
      if (
        row > 1 && column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        matrix[row][column] = Math.min(matrix[row][column], matrix[row - 2][column - 2] + cost);
      }
    }
  }
  return matrix[left.length][right.length];
}

function addDatabaseDiagnostics(plan, diagnostics, databaseFile, coreRoot, options = {}) {
  const actual = options.artifacts ?? null;
  const checkedPostconditions = options.phase === "pre" ? [] : (plan.postconditions ?? []);
  const names = new Map();
  if (!databaseFile || !existsSync(databaseFile)) {
    const postconditions = checkedPostconditions.map((postcondition) => ({
      ...postcondition,
      status: "failed",
      failures: ["catalog-database-unavailable"],
    }));
    for (const postcondition of postconditions) {
      diagnostics.push(diagnostic({
        severity: "error",
        code: "POSTCONDITION_EVIDENCE_UNAVAILABLE",
        target: `postcondition/${postcondition.postId}`,
        message: `Cannot verify ${postcondition.kind} '${postcondition.postId}' without the local co-op Catalog database.`,
      }));
    }
    return { evidence: { checked: false, databaseFile: null }, names, postconditions };
  }
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    database.exec('PRAGMA temp_store=MEMORY; BEGIN');
    attachEngineCatalog(database);
    database.exec("PRAGMA query_only = ON");
    const tableExists = (name) => Boolean(database.prepare(`
      SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?
    `).get(name));
    const hasLocalizedText = tableExists("localized_text");
    const hasCommanderMembership = tableExists("commander_membership");
    const hasObjectReferences = tableExists("object_references");
    const catalogFieldColumns = new Set(
      database.prepare("PRAGMA table_info(catalog_fields)").all().map((column) => column.name),
    );
    const catalogObjectColumns = new Set(
      database.prepare("PRAGMA table_info(catalog_objects)").all().map((column) => column.name),
    );
    const hasFieldValues = catalogFieldColumns.has("value");
    const commanderExists = database.prepare(`
      SELECT 1 FROM commanders WHERE lower(id)=lower(?)
    `);
    const objectParentSelect = catalogObjectColumns.has("parent_id")
      ? "parent_id AS parentId"
      : "NULL AS parentId";
    const readObjectExact = database.prepare(`
      SELECT catalog, object_id AS objectId, class, ${objectParentSelect} FROM catalog_objects
      WHERE catalog=? AND object_id=?
    `);
    const readObject = database.prepare(`
      SELECT catalog, object_id AS objectId, class, ${objectParentSelect} FROM catalog_objects
      WHERE lower(catalog)=lower(?) AND lower(object_id)=lower(?)
    `);
    const readMemberships = hasCommanderMembership ? database.prepare(`
      SELECT DISTINCT commander_id AS commanderId
      FROM commander_membership
      WHERE lower(catalog)=lower(?) AND lower(object_id)=lower(?)
      ORDER BY commander_id
    `) : null;
    const readIncomingConsumers = hasObjectReferences ? database.prepare(`
      SELECT DISTINCT source_catalog AS catalog, source_object_id AS objectId,
             field_path AS fieldPath, confidence
      FROM object_references
      WHERE lower(target_catalog)=lower(?) AND lower(target_object_id)=lower(?)
        AND confidence>=0.75
      ORDER BY source_catalog, source_object_id, field_path
    `) : null;
    const readIncomingUnitReferences = hasObjectReferences ? database.prepare(`
      SELECT DISTINCT r.source_catalog AS catalog, r.source_object_id AS objectId,
             r.field_path AS fieldPath, r.confidence,
             COALESCE(o.class, '') AS sourceClass
      FROM object_references r
      LEFT JOIN catalog_objects o
        ON lower(o.catalog)=lower(r.source_catalog)
       AND lower(o.object_id)=lower(r.source_object_id)
      WHERE lower(r.target_catalog)='unit' AND lower(r.target_object_id)=lower(?)
        AND r.confidence>=0.75
      ORDER BY r.source_catalog, r.source_object_id, r.field_path
    `) : null;
    const readChildren = catalogObjectColumns.has("parent_id") ? database.prepare(`
      SELECT catalog, object_id AS objectId, 'parent' AS fieldPath, 1.0 AS confidence
      FROM catalog_objects
      WHERE lower(catalog)=lower(?) AND lower(parent_id)=lower(?)
      ORDER BY object_id
    `) : null;
    const fieldExists = database.prepare(`
      SELECT 1 FROM catalog_fields
      WHERE catalog=? AND object_id=? AND lower(path)=lower(?)
    `);
    const fieldPaths = database.prepare(`
      SELECT path FROM catalog_fields WHERE catalog=? AND object_id=? ORDER BY path
    `);
    const readFieldValueExact = hasFieldValues ? database.prepare(`
      SELECT value FROM catalog_fields
      WHERE catalog=? AND object_id=? AND path=?
      ${catalogFieldColumns.has("inheritance_depth") ? "ORDER BY inheritance_depth" : ""} LIMIT 1
    `) : null;
    const readFieldValue = hasFieldValues ? database.prepare(`
      SELECT value FROM catalog_fields
      WHERE lower(catalog)=lower(?) AND lower(object_id)=lower(?) AND lower(path)=lower(?)
      ${catalogFieldColumns.has("inheritance_depth") ? "ORDER BY inheritance_depth" : ""} LIMIT 1
    `) : null;
    const readDirectFieldValue = hasFieldValues && catalogFieldColumns.has("inheritance_depth")
      ? database.prepare(`
          SELECT value FROM catalog_fields
          WHERE lower(catalog)=lower(?) AND lower(object_id)=lower(?) AND lower(path)=lower(?)
            AND inheritance_depth=0
          LIMIT 1
        `)
      : null;
    const readDirectObjectFields = hasFieldValues && catalogFieldColumns.has("inheritance_depth")
      ? database.prepare(`
          SELECT path, value FROM catalog_fields
          WHERE lower(catalog)=lower(?) AND lower(object_id)=lower(?)
            AND inheritance_depth=0
          ORDER BY path
        `)
      : null;
    const readObjectParent = catalogObjectColumns.has("parent_id") ? database.prepare(`
      SELECT parent_id AS parentId FROM catalog_objects
      WHERE lower(catalog)=lower(?) AND lower(object_id)=lower(?) LIMIT 1
    `) : null;
    const readNameField = hasFieldValues ? database.prepare(`
      SELECT value FROM catalog_fields
      WHERE catalog=? AND object_id=? AND path='Name'
      ${catalogFieldColumns.has("inheritance_depth") ? "ORDER BY inheritance_depth" : ""} LIMIT 1
    `) : null;
    const readLocalizedName = hasLocalizedText ? database.prepare(`
      SELECT value FROM localized_text
      WHERE locale='zhcn' AND text_key=? LIMIT 1
    `) : null;
    const readLocalizedText = hasLocalizedText ? database.prepare(`
      SELECT value FROM localized_text
      WHERE locale=? AND text_key=? LIMIT 1
    `) : null;
    const readLocalizedAny = hasLocalizedText ? database.prepare(`
      SELECT locale, value FROM localized_text
      WHERE text_key=? ORDER BY locale
    `) : null;
    const readOutgoingEffectReferences = hasObjectReferences ? database.prepare(`
      SELECT field_path AS fieldPath, target_object_id AS objectId
      FROM object_references
      WHERE source_catalog='Effect' AND source_object_id=?
        AND target_catalog='Effect' AND confidence>=0.4
      ORDER BY field_path, target_object_id
    `) : null;
    const readOutgoingRequirementReferences = hasObjectReferences ? database.prepare(`
      SELECT field_path AS fieldPath, target_object_id AS objectId
      FROM object_references
      WHERE source_catalog='Requirement' AND source_object_id=?
        AND target_catalog='Requirement' AND confidence>=0.75
      ORDER BY field_path, target_object_id
    `) : null;
    const objectRecordCache = new Map();
    const objectRecord = (catalog, objectId) => {
      const key = `${catalog}/${objectId}`.toLowerCase();
      if (!objectRecordCache.has(key)) {
        objectRecordCache.set(
          key,
          readObjectExact.get(catalog, objectId) ?? readObject.get(catalog, objectId) ?? null,
        );
      }
      return objectRecordCache.get(key);
    };
    const databaseFieldValue = (catalog, objectId, fieldPath) => {
      const exact = readFieldValueExact?.get(catalog, objectId, fieldPath);
      return exact ? exact.value : readFieldValue?.get(catalog, objectId, fieldPath)?.value;
    };
    const createdObjects = new Set();
    const createdObjectClasses = new Map();
    const unitCloneByUnit = new Map();
    const unitCloneByActor = new Map();
    for (const operation of plan.operations ?? []) {
      if (["catalog.create", "catalog.clone"].includes(operation.kind)) {
        createdObjects.add(`${operation.catalog}/${operation.object}`.toLowerCase());
        if (operation.kind === "catalog.create") {
          createdObjectClasses.set(
            `${operation.catalog}/${operation.object}`.toLowerCase(),
            operation.class,
          );
        }
      }
      if (operation.kind === "commander.unit.clone") {
        const unitKey = `unit/${operation.unitId}`.toLowerCase();
        const actorId = operation.actorId ?? operation.unitId;
        const actorKey = `actor/${actorId}`.toLowerCase();
        createdObjects.add(unitKey);
        createdObjects.add(actorKey);
        createdObjectClasses.set(actorKey, "CActorUnit");
        unitCloneByUnit.set(unitKey, operation);
        unitCloneByActor.set(actorKey, operation);
      }
    }

    const planParents = new Map();
    // A local overlay is not a new private identity if the ID is official.
    // Otherwise a no-op create/clone could exempt subsequent shared writes.
    for (const key of createdObjects) {
      const [catalog, objectId] = key.split("/");
      if (objectRecord(catalog, objectId)) diagnostics.push(diagnostic({
        severity: "error", code: "CREATED_ID_IS_OFFICIAL", target: key,
        message: `Created/clone target ${key} already exists in the official Catalog; choose a private ID.`,
      }));
    }
    for (const operation of plan.operations ?? []) {
      if (operation.kind === "catalog.clone") {
        planParents.set(`${operation.catalog}/${operation.object}`.toLowerCase(), operation.source);
      } else if (operation.kind === "catalog.create" && operation.parent) {
        planParents.set(`${operation.catalog}/${operation.object}`.toLowerCase(), operation.parent);
      } else if (operation.kind === "commander.unit.clone") {
        planParents.set(`unit/${operation.unitId}`.toLowerCase(), operation.sourceUnit);
      }
    }

    const coreCatalogCache = new Map();
    const coreCatalogObjects = (catalog) => {
      const key = String(catalog).toLowerCase();
      if (coreCatalogCache.has(key)) return coreCatalogCache.get(key);
      const objects = new Map();
      if (coreRoot) {
        const file = path.join(coreRoot, "Base.SC2Data", "GameData", `${catalog}Data.xml`);
        if (existsSync(file)) {
          const document = new DOMParser().parseFromString(readFileSync(file, "utf8"), "application/xml");
          for (const object of directElementChildren(document.documentElement)) {
            const objectId = object.getAttribute("id");
            if (objectId) objects.set(objectId.toLowerCase(), object);
          }
        }
      }
      coreCatalogCache.set(key, objects);
      return objects;
    };
    const coreObject = (catalog, objectId) =>
      coreCatalogObjects(catalog).get(String(objectId).toLowerCase()) ?? null;
    const directCatalogFieldValue = (catalog, objectId, fieldPath) => {
      if (actual) return actual.fields(catalog, objectId, false).find((row) => row.inheritance_depth === 0 && row.path === fieldPath)?.value;
      const localObject = coreObject(catalog, objectId);
      if (localObject) {
        const localValue = readDirectCoreField(localObject, fieldPath);
        if (localValue !== undefined) return localValue;
      }
      if (readDirectFieldValue) {
        return readDirectFieldValue.get(catalog, objectId, fieldPath)?.value;
      }
      return databaseFieldValue(catalog, objectId, fieldPath);
    };
    const objectExists = (catalog, objectId) => actual ? Boolean(actual.object(catalog, objectId)) : Boolean(
      createdObjects.has(`${catalog}/${objectId}`.toLowerCase()) ||
      objectRecord(catalog, objectId) ||
      coreObject(catalog, objectId),
    );
    const projectedFieldCache = new Map();
    const projectedField = (
      catalog,
      objectId,
      fieldPath,
      visiting = new Set(),
      includeCommanderStats = true,
    ) => {
      if (actual) return actual.field(catalog, objectId, fieldPath, includeCommanderStats);
      const cacheKey = `${catalog}/${objectId}/${fieldPath}/${includeCommanderStats ? "runtime" : "catalog"}`.toLowerCase();
      if (projectedFieldCache.has(cacheKey)) return projectedFieldCache.get(cacheKey);
      if (visiting.has(cacheKey)) return undefined;
      visiting.add(cacheKey);
      let value;
      let planOwnsField = false;
      for (const operation of plan.operations ?? []) {
        if (operation.kind === "commander.unit.clone") {
          const redirect = operation.redirects?.find((candidate) =>
            candidate.catalog === catalog &&
            candidate.object === objectId &&
            String(candidate.path).toLowerCase() === String(fieldPath).toLowerCase());
          if (redirect) {
            value = operation.unitId;
            planOwnsField = true;
          }
        }
        if (operation.catalog !== catalog || operation.object !== objectId) continue;
        const normalizedPath = String(operation.path ?? "").toLowerCase();
        const normalizedFieldPath = String(fieldPath).toLowerCase();
        if (
          includeCommanderStats &&
          operation.kind === "commander.stat.set" &&
          normalizedPath === normalizedFieldPath
        ) {
          value = operation.value;
          planOwnsField = true;
        } else if (operation.kind === "catalog.set" && normalizedPath === normalizedFieldPath) {
          value = operation.value;
          planOwnsField = true;
        } else if (
          operation.kind === "catalog.remove" &&
          (normalizedFieldPath === normalizedPath || normalizedFieldPath.startsWith(`${normalizedPath}.`))
        ) {
          value = undefined;
          planOwnsField = true;
        } else if (
          operation.kind === "catalog.clear" &&
          normalizedFieldPath.startsWith(`${normalizedPath.toLowerCase()}[`)
        ) {
          value = undefined;
          planOwnsField = true;
        } else if (operation.kind === "catalog.insert") {
          const insertedPath = `${operation.path}[${operation.index}]`;
          if (normalizedFieldPath === insertedPath.toLowerCase() && hasOwn(operation, "value")) {
            value = operation.value;
            planOwnsField = true;
          }
          for (const [attribute, attributeValue] of Object.entries(operation.attributes ?? {})) {
            if (normalizedFieldPath === `${insertedPath}.@${attribute}`.toLowerCase()) {
              value = attributeValue;
              planOwnsField = true;
            }
          }
        }
      }
      if (!planOwnsField && value === undefined) {
        const localObject = coreObject(catalog, objectId);
        if (localObject) value = readDirectCoreField(localObject, fieldPath);
      }
      if (!planOwnsField && value === undefined && readFieldValue) {
        value = databaseFieldValue(catalog, objectId, fieldPath);
      }
      if (!planOwnsField && value === undefined) {
        const objectKey = `${catalog}/${objectId}`.toLowerCase();
        const unitClone = unitCloneByUnit.get(objectKey);
        const actorClone = unitCloneByActor.get(objectKey);
        if (unitClone && String(fieldPath).toLowerCase() === "name") {
          const sourceName = projectedField("Unit", unitClone.sourceUnit, "Name", visiting);
          value = sourceName === undefined
            ? `Unit/Name/${unitClone.sourceUnit}`
            : String(sourceName)
                .replaceAll("##id##", unitClone.sourceUnit)
                .replaceAll("##unitName##", unitClone.sourceUnit);
        } else if (actorClone && String(fieldPath).toLowerCase() === "@unitname") {
          value = actorClone.unitId;
        } else if (actorClone && String(fieldPath).toLowerCase() === "model") {
          const sourceActorId = actorClone.sourceActor ?? actorClone.sourceUnit;
          const directModel = directCatalogFieldValue("Actor", sourceActorId, "Model");
          if (directModel !== undefined) {
            value = directModel;
          } else if (objectExists("Model", sourceActorId)) {
            value = sourceActorId;
          } else {
            value = projectedField("Actor", sourceActorId, fieldPath, visiting);
          }
        } else if (actorClone) {
          const sourceActorId = actorClone.sourceActor ?? actorClone.sourceUnit;
          value = projectedField("Actor", sourceActorId, fieldPath, visiting);
        }
      }
      if (!planOwnsField && value === undefined) {
        const key = `${catalog}/${objectId}`.toLowerCase();
        const localObject = coreObject(catalog, objectId);
        const parentId = planParents.get(key) ??
          localObject?.getAttribute("parent") ??
          objectRecord(catalog, objectId)?.parentId ??
          readObjectParent?.get(catalog, objectId)?.parentId ?? null;
        if (parentId) value = projectedField(catalog, parentId, fieldPath, visiting, false);
      }
      visiting.delete(cacheKey);
      projectedFieldCache.set(cacheKey, value);
      return value;
    };

    const projectedObjectParent = (catalog, objectId) => {
      if (actual) return actual.object(catalog, objectId)?.parent_id ?? null;
      const key = `${catalog}/${objectId}`.toLowerCase();
      const actorClone = unitCloneByActor.get(key);
      const sourceActorId = actorClone?.sourceActor ?? actorClone?.sourceUnit ?? null;
      return planParents.get(key) ??
        coreObject(catalog, objectId)?.getAttribute("parent") ??
        objectRecord(catalog, objectId)?.parentId ??
        (actorClone && String(sourceActorId).toLowerCase() !== String(objectId).toLowerCase()
          ? projectedObjectParent("Actor", sourceActorId)
          : null) ??
        readObjectParent?.get(catalog, objectId)?.parentId ?? null;
    };
    const objectClassCache = new Map();
    const objectClass = (catalog, objectId, visiting = new Set()) => {
      if (actual) return actual.object(catalog, objectId)?.class ?? null;
      const key = `${catalog}/${objectId}`.toLowerCase();
      if (objectClassCache.has(key)) return objectClassCache.get(key);
      if (visiting.has(key)) return null;
      visiting.add(key);
      const directClass = createdObjectClasses.get(key) ??
        coreObject(catalog, objectId)?.tagName ??
        objectRecord(catalog, objectId)?.class ?? null;
      const parentId = projectedObjectParent(catalog, objectId);
      const resolved = directClass ?? (parentId ? objectClass(catalog, parentId, visiting) : null);
      visiting.delete(key);
      objectClassCache.set(key, resolved);
      return resolved;
    };
    const directCoreFieldsCache = new Map();
    const directCoreFields = (catalog, objectId) => {
      if (actual) return new Map(actual.fields(catalog, objectId, false).filter((row) => (row.inheritance_depth ?? row.inheritanceDepth) === 0).map((row) => [row.path, row.value]));
      const key = `${catalog}/${objectId}`.toLowerCase();
      if (!directCoreFieldsCache.has(key)) {
        const object = coreObject(catalog, objectId);
        directCoreFieldsCache.set(key, object ? flattenDirectCoreFields(object) : new Map());
      }
      return directCoreFieldsCache.get(key);
    };
    const inferredUnitCloneActorFields = (sourceActorId) => {
      const fields = new Map();
      for (const row of readDirectObjectFields?.all("Actor", sourceActorId) ?? []) {
        if (isUnitClonePresentationField(row.path)) fields.set(row.path, row.value);
      }
      for (const [fieldPath, value] of directCoreFields("Actor", sourceActorId)) {
        if (!isUnitClonePresentationField(fieldPath)) continue;
        if (value === undefined) fields.delete(fieldPath);
        else fields.set(fieldPath, value);
      }
      return [...fields.entries()]
        .filter(([, value]) => value !== undefined && value !== null && String(value).trim().length > 0)
        .map(([fieldPath, sourceValue]) => ({ fieldPath, sourceValue }))
        .sort((left, right) => stableCompare(left.fieldPath, right.fieldPath));
    };
    const setReference = (references, fieldPath, objectId) => {
      if (objectId === undefined || objectId === null || String(objectId).trim() === "") return;
      references.set(String(fieldPath).toLowerCase(), {
        fieldPath: String(fieldPath),
        objectId: String(objectId),
      });
    };
    const removeReferencePrefix = (references, fieldPath, collection = false) => {
      const normalized = String(fieldPath).toLowerCase();
      for (const key of references.keys()) {
        if (
          key === normalized || key.startsWith(`${normalized}.`) ||
          (collection && key.startsWith(`${normalized}[`))
        ) references.delete(key);
      }
    };

    const effectTargetCache = new Map();
    const projectedEffectTargets = (effectId, visiting = new Set()) => {
      if (actual) return actual.references("Effect", effectId, (fieldPath) => /effect/i.test(fieldPath));
      const key = String(effectId).toLowerCase();
      if (effectTargetCache.has(key)) return effectTargetCache.get(key);
      if (visiting.has(key)) return [];
      visiting.add(key);
      const references = new Map();
      const parentId = projectedObjectParent("Effect", effectId);
      if (parentId) {
        for (const reference of projectedEffectTargets(parentId, visiting)) {
          setReference(references, reference.fieldPath, reference.objectId);
        }
      }
      for (const reference of readOutgoingEffectReferences?.all(effectId) ?? []) {
        setReference(references, reference.fieldPath, reference.objectId);
      }
      for (const [fieldPath, value] of directCoreFields("Effect", effectId)) {
        if (!/effect/i.test(fieldPath)) continue;
        removeReferencePrefix(references, fieldPath);
        setReference(references, fieldPath, value);
      }
      for (const operation of plan.operations ?? []) {
        if (operation.catalog !== "Effect" || operation.object !== effectId) continue;
        if (operation.kind === "catalog.set") {
          removeReferencePrefix(references, operation.path);
          if (/effect/i.test(operation.path)) setReference(references, operation.path, operation.value);
        } else if (operation.kind === "catalog.remove") {
          removeReferencePrefix(references, operation.path);
        } else if (operation.kind === "catalog.clear") {
          removeReferencePrefix(references, operation.path, true);
        } else if (operation.kind === "catalog.insert") {
          const insertedPath = `${operation.path}[${operation.index}]`;
          removeReferencePrefix(references, insertedPath);
          if (/effect/i.test(operation.path)) {
            if (hasOwn(operation, "value")) setReference(references, insertedPath, operation.value);
            for (const [attribute, value] of Object.entries(operation.attributes ?? {})) {
              if (/effect/i.test(attribute) || attribute.toLowerCase() === "link") {
                setReference(references, `${insertedPath}.@${attribute}`, value);
              }
            }
          }
        }
      }
      visiting.delete(key);
      const result = [...references.values()].sort((left, right) =>
        stableCompare(left.fieldPath, right.fieldPath) || stableCompare(left.objectId, right.objectId));
      effectTargetCache.set(key, result);
      return result;
    };

    const coreLocaleCache = new Map();
    const coreLocalizedEntries = (locale) => {
      const key = String(locale).toLowerCase();
      if (coreLocaleCache.has(key)) return coreLocaleCache.get(key);
      const entries = new Map();
      if (coreRoot) {
        const file = path.join(coreRoot, `${locale}.SC2Data`, "LocalizedData", "GameStrings.txt");
        if (existsSync(file)) {
          for (const rawLine of readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
            const separator = rawLine.indexOf("=");
            if (separator <= 0) continue;
            entries.set(rawLine.slice(0, separator), rawLine.slice(separator + 1));
          }
        }
      }
      coreLocaleCache.set(key, entries);
      return entries;
    };
    const projectedLocalizedText = (locale, textKey) => {
      if (actual) return actual.text(locale, textKey);
      let value;
      let planOwnsValue = false;
      for (const operation of plan.operations ?? []) {
        if (
          operation.kind === "locale.set" &&
          operation.locale.toLowerCase() === String(locale).toLowerCase() &&
          operation.key === textKey
        ) {
          value = operation.value;
          planOwnsValue = true;
        }
      }
      if (planOwnsValue) return value;
      if (coreLocalizedEntries(locale).has(textKey)) return coreLocalizedEntries(locale).get(textKey);
      return readLocalizedText?.get(String(locale).toLowerCase(), textKey)?.value;
    };
    const projectedLocalizationEntries = (textKey) => {
      const locales = new Map([
        ["enus", "enUS"],
        ["zhcn", "zhCN"],
      ]);
      const addLocale = (locale) => {
        const normalized = String(locale).toLowerCase();
        if (!locales.has(normalized)) locales.set(normalized, String(locale));
      };
      for (const row of readLocalizedAny?.all(textKey) ?? []) addLocale(row.locale);
      for (const operation of plan.operations ?? []) {
        if (operation.kind === "locale.set" && operation.key === textKey) {
          addLocale(operation.locale);
        }
      }
      return [...locales.values()]
        .map((locale) => ({ locale, value: projectedLocalizedText(locale, textKey) }))
        .filter((entry) => typeof entry.value === "string" && entry.value.trim().length > 0)
        .sort((left, right) => stableCompare(left.locale.toLowerCase(), right.locale.toLowerCase()));
    };

    const requirementReferenceCache = new Map();
    const projectedRequirementReferences = (requirementId, visiting = new Set()) => {
      if (actual) return actual.references("Requirement", requirementId, (fieldPath) => /^NodeArray(?:\[|$)/i.test(fieldPath) || /^OperandArray(?:\[|$)/i.test(fieldPath));
      const key = String(requirementId).toLowerCase();
      if (requirementReferenceCache.has(key)) return requirementReferenceCache.get(key);
      if (visiting.has(key)) return [];
      visiting.add(key);
      const references = new Map();
      const parentId = projectedObjectParent("Requirement", requirementId);
      if (parentId) {
        for (const reference of projectedRequirementReferences(parentId, visiting)) {
          setReference(references, reference.fieldPath, reference.objectId);
        }
      }
      for (const reference of readOutgoingRequirementReferences?.all(requirementId) ?? []) {
        setReference(references, reference.fieldPath, reference.objectId);
      }
      const isRequirementPath = (fieldPath) =>
        /^NodeArray(?:\[|$)/i.test(fieldPath) || /^OperandArray(?:\[|$)/i.test(fieldPath);
      for (const [fieldPath, value] of directCoreFields("Requirement", requirementId)) {
        if (!isRequirementPath(fieldPath)) continue;
        removeReferencePrefix(references, fieldPath);
        setReference(references, fieldPath, value);
      }
      for (const operation of plan.operations ?? []) {
        if (operation.catalog !== "Requirement" || operation.object !== requirementId) continue;
        if (operation.kind === "catalog.set") {
          removeReferencePrefix(references, operation.path);
          if (isRequirementPath(operation.path)) {
            setReference(references, operation.path, operation.value);
          }
        } else if (operation.kind === "catalog.remove") {
          removeReferencePrefix(references, operation.path);
        } else if (operation.kind === "catalog.clear") {
          removeReferencePrefix(references, operation.path, true);
        } else if (operation.kind === "catalog.insert" && isRequirementPath(operation.path)) {
          const insertedPath = `${operation.path}[${operation.index}]`;
          removeReferencePrefix(references, insertedPath);
          if (hasOwn(operation, "value")) setReference(references, insertedPath, operation.value);
          if (hasOwn(operation.attributes ?? {}, "Link")) {
            setReference(references, `${insertedPath}.@Link`, operation.attributes.Link);
          }
        }
      }
      visiting.delete(key);
      const indexOf = (fieldPath) => {
        const raw = /^\w+Array\[#?(\d+)\]/.exec(fieldPath)?.[1];
        return raw === undefined ? Number.MAX_SAFE_INTEGER : Number(raw);
      };
      const result = [...references.values()].sort((left, right) =>
        indexOf(left.fieldPath) - indexOf(right.fieldPath) || stableCompare(left.fieldPath, right.fieldPath));
      requirementReferenceCache.set(key, result);
      return result;
    };

    const evaluateRequirementNode = (requirementId, visiting = new Set(), depth = 0) => {
      const key = String(requirementId).toLowerCase();
      if (depth > 24 || visiting.has(key) || !objectExists("Requirement", requirementId)) {
        return { known: false, value: null };
      }
      const nextVisiting = new Set([...visiting, key]);
      const className = objectClass("Requirement", requirementId);
      const operandIds = projectedRequirementReferences(requirementId)
        .filter((reference) => /^OperandArray(?:\[|$)/i.test(reference.fieldPath))
        .map((reference) => reference.objectId);
      const operands = operandIds.map((operandId) =>
        evaluateRequirementNode(operandId, nextVisiting, depth + 1));
      if (className === "CRequirementConst") {
        return parseStaticScalar(projectedField("Requirement", requirementId, "Value"));
      }
      if (className === "CRequirementNot" || className === "CRequirementOdd") {
        const truth = operands.length > 0 ? staticTruth(operands[0]) : null;
        return truth === null ? { known: false, value: null } : { known: true, value: !truth };
      }
      if (className === "CRequirementAnd") {
        const truths = operands.map(staticTruth);
        if (truths.includes(false)) return { known: true, value: false };
        if (truths.length > 0 && truths.every((value) => value === true)) return { known: true, value: true };
        return { known: false, value: null };
      }
      if (className === "CRequirementOr") {
        const truths = operands.map(staticTruth);
        if (truths.includes(true)) return { known: true, value: true };
        if (truths.length > 0 && truths.every((value) => value === false)) return { known: true, value: false };
        return { known: false, value: null };
      }
      if (className === "CRequirementXor") {
        const truths = operands.map(staticTruth);
        if (truths.filter((value) => value === true).length > 1) return { known: true, value: false };
        if (truths.length > 0 && truths.every((value) => value !== null)) {
          return { known: true, value: truths.filter(Boolean).length === 1 };
        }
        return { known: false, value: null };
      }
      const comparison = /^CRequirement(Eq|NE|GT|GTE|LT|LTE)$/.exec(className ?? "");
      if (comparison && operands.length >= 2 && operands.slice(0, 2).every((operand) => operand.known)) {
        const [left, right] = operands.map((operand) => operand.value);
        const result = {
          Eq: left === right,
          NE: left !== right,
          GT: left > right,
          GTE: left >= right,
          LT: left < right,
          LTE: left <= right,
        }[comparison[1]];
        return { known: true, value: result };
      }
      const arithmetic = /^CRequirement(Sum|Mul|Div|Mod)$/.exec(className ?? "");
      if (arithmetic && operands.length > 0 && operands.every((operand) =>
        operand.known && typeof operand.value === "number")) {
        if (["Div", "Mod"].includes(arithmetic[1]) && operands.slice(1).some((operand) => operand.value === 0)) {
          return { known: false, value: null };
        }
        const values = operands.map((operand) => operand.value);
        const result = values.slice(1).reduce((current, value) => ({
          Sum: current + value,
          Mul: current * value,
          Div: current / value,
          Mod: current % value,
        })[arithmetic[1]], values[0]);
        return { known: true, value: result };
      }
      return { known: false, value: null };
    };
    const requirementStaticEvidence = (requirementId) => {
      const className = objectClass("Requirement", requirementId);
      const missingNodeIds = new Set();
      const visitedNodeIds = new Set();
      const queue = [requirementId];
      while (queue.length > 0 && visitedNodeIds.size < 256) {
        const current = queue.shift();
        const normalized = String(current).toLowerCase();
        if (visitedNodeIds.has(normalized)) continue;
        visitedNodeIds.add(normalized);
        for (const reference of projectedRequirementReferences(current)) {
          if (!objectExists("Requirement", reference.objectId)) {
            missingNodeIds.add(reference.objectId);
          } else {
            queue.push(reference.objectId);
          }
        }
      }
      const phaseLinks = projectedRequirementReferences(requirementId)
        .map((reference) => ({
          ...reference,
          phase: /^NodeArray\[([^\]]+)\](?:\.@?Link)?$/i.exec(reference.fieldPath)?.[1] ?? null,
        }))
        .filter((reference) => reference.phase);
      const phases = className === "CRequirement" && phaseLinks.length > 0
        ? phaseLinks.map((reference) => ({
            phase: reference.phase,
            objectId: reference.objectId,
            result: evaluateRequirementNode(reference.objectId),
          }))
        : [{ phase: "Node", objectId: requirementId, result: evaluateRequirementNode(requirementId) }];
      return {
        class: className,
        missingNodeIds: [...missingNodeIds].sort(stableCompare),
        phases: phases.map((phase) => ({
          phase: phase.phase,
          objectId: phase.objectId,
          state: staticTruth(phase.result) === null
            ? "unknown"
            : staticTruth(phase.result) ? "true" : "false",
        })),
        permanentlyLocked: phases.some((phase) => staticTruth(phase.result) === false),
      };
    };

    const unitStateCache = new Map();
    const projectedUnitState = (unitId, visiting = new Set()) => {
      if (actual) return parseDatabaseUnitState(actual.database, actual.object("Unit", unitId)?.object_id ?? unitId);
      const cacheKey = String(unitId).toLowerCase();
      if (unitStateCache.has(cacheKey)) return cloneProjectedUnitState(unitStateCache.get(cacheKey));
      if (visiting.has(cacheKey)) return emptyProjectedUnitState();
      visiting.add(cacheKey);
      const databaseObject = objectRecord("Unit", unitId);
      const localObject = coreObject("Unit", unitId);
      const parentId = planParents.get(`unit/${unitId}`.toLowerCase()) ??
        localObject?.getAttribute("parent") ??
        databaseObject?.parentId ??
        readObjectParent?.get("Unit", unitId)?.parentId ?? null;
      let state;
      if (databaseObject) state = parseDatabaseUnitState(database, databaseObject.objectId);
      else if (parentId) state = projectedUnitState(parentId, visiting);
      else state = emptyProjectedUnitState();
      if (localObject) applyCoreUnitObject(state, localObject);
      applyPlanToProjectedUnitState(state, plan, unitId);
      visiting.delete(cacheKey);
      unitStateCache.set(cacheKey, cloneProjectedUnitState(state));
      return state;
    };

    const postconditionResults = [];
    const seenPostIds = new Set();
    for (const postcondition of checkedPostconditions) {
      const postTarget = `postcondition/${postcondition.postId}`;
      if (seenPostIds.has(postcondition.postId)) {
        diagnostics.push(diagnostic({
          severity: "error",
          code: "DUPLICATE_POSTCONDITION_ID",
          target: postTarget,
          message: `Postcondition id '${postcondition.postId}' is not unique within the PatchPlan.`,
        }));
        postconditionResults.push({ ...postcondition, status: "failed", failures: ["duplicate-post-id"] });
        continue;
      }
      seenPostIds.add(postcondition.postId);
      const failures = [];
      const evidence = {};

      if (postcondition.kind === "unit.clone") {
        const cloneOperation = (plan.operations ?? []).find((operation) =>
          operation.kind === "commander.unit.clone" &&
          operation.commanderId === postcondition.commanderId &&
          operation.sourceUnit === postcondition.sourceUnitId &&
          operation.unitId === postcondition.unitId &&
          (operation.sourceActor ?? operation.sourceUnit) === postcondition.sourceActorId &&
          (operation.actorId ?? operation.unitId) === postcondition.actorId);
        evidence.cloneOperationOpId = cloneOperation?.opId ?? null;
        if (!cloneOperation) failures.push("clone-operation-missing");

        evidence.sourceUnitExists = objectExists("Unit", postcondition.sourceUnitId);
        evidence.unitExists = objectExists("Unit", postcondition.unitId);
        evidence.unitParentId = projectedObjectParent("Unit", postcondition.unitId);
        if (!evidence.sourceUnitExists) failures.push("source-unit-missing");
        if (!evidence.unitExists) failures.push("unit-missing");
        if (evidence.unitParentId !== postcondition.sourceUnitId) failures.push("unit-parent-mismatch");

        evidence.sourceActorExists = objectExists("Actor", postcondition.sourceActorId);
        evidence.sourceActorClass = objectClass("Actor", postcondition.sourceActorId);
        evidence.actorExists = objectExists("Actor", postcondition.actorId);
        evidence.actorClass = objectClass("Actor", postcondition.actorId);
        evidence.actorUnitName = projectedField("Actor", postcondition.actorId, "@unitName") ?? null;
        if (!evidence.sourceActorExists) failures.push("source-actor-missing");
        if (evidence.sourceActorExists && evidence.sourceActorClass !== "CActorUnit") {
          failures.push("source-actor-not-unit");
        }
        if (!evidence.actorExists) failures.push("actor-missing");
        if (evidence.actorExists && evidence.actorClass !== "CActorUnit") {
          failures.push("actor-class-mismatch");
        }
        if (evidence.actorUnitName !== postcondition.unitId) {
          failures.push("actor-unit-binding-mismatch");
        }

        const resolveActorToken = (value) => value === undefined || value === null
          ? null
          : String(value)
              .replaceAll("##unitName##", postcondition.unitId)
              .replaceAll("##id##", postcondition.actorId);
        evidence.actorModel = projectedField("Actor", postcondition.actorId, "Model") ?? null;
        evidence.resolvedModelId = resolveActorToken(evidence.actorModel);
        evidence.modelExists = evidence.resolvedModelId
          ? objectExists("Model", evidence.resolvedModelId)
          : false;
        if (!evidence.actorModel) failures.push("model-field-missing");
        if (evidence.actorModel && !evidence.modelExists) failures.push("model-target-missing");

        const rawNameKey = projectedField("Unit", postcondition.unitId, "Name");
        evidence.nameKey = rawNameKey === undefined || rawNameKey === null
          ? null
          : String(rawNameKey)
              .replaceAll("##id##", postcondition.unitId)
              .replaceAll("##unitName##", postcondition.unitId);
        evidence.nameEntries = evidence.nameKey
          ? projectedLocalizationEntries(evidence.nameKey)
          : [];
        if (!evidence.nameKey) failures.push("unit-name-missing");
        if (postcondition.nameKey !== undefined && evidence.nameKey !== postcondition.nameKey) {
          failures.push("unit-name-key-mismatch");
        }
        if (evidence.nameKey && evidence.nameEntries.length === 0) {
          failures.push("unit-name-localization-missing");
        }

        evidence.entrypoints = postcondition.entrypoints.map((entrypoint) => {
          if (entrypoint.kind === "catalog") {
            const declaredByClone = Boolean(cloneOperation?.redirects?.some((redirect) =>
              redirect.catalog === entrypoint.catalog &&
              redirect.object === entrypoint.object &&
              redirect.path === entrypoint.path));
            const projectedUnitId = projectedField(
              entrypoint.catalog,
              entrypoint.object,
              entrypoint.path,
            ) ?? null;
            return {
              ...entrypoint,
              connected: declaredByClone && projectedUnitId === postcondition.unitId,
              projectedUnitId,
            };
          }
          const module = (plan.operations ?? []).find((operation) =>
            operation.kind === "galaxy.source" &&
            operation.path === entrypoint.path &&
            /\bUnitCreate\s*\(/.test(String(operation.source ?? "")) &&
            String(operation.source ?? "").includes(`"${postcondition.unitId}"`));
          return { ...entrypoint, connected: Boolean(module), opId: module?.opId ?? null };
        });
        if (evidence.entrypoints.some((entrypoint) => !entrypoint.connected)) {
          failures.push("entrypoint-not-connected");
        }

        const inferredActorFields = inferredUnitCloneActorFields(postcondition.sourceActorId);
        const inferredActorFieldPaths = new Set(inferredActorFields.map((field) => field.fieldPath));
        const inferredActorFieldValues = new Map(inferredActorFields.map((field) => [
          field.fieldPath,
          field.sourceValue,
        ]));
        const actorFieldPaths = new Set([
          ...inferredActorFieldPaths,
          ...(postcondition.requiredActorFields ?? []),
        ]);
        evidence.actorFieldPolicy = {
          inferredFromDirectSourceFields: inferredActorFields.length,
          explicitlyRequired: postcondition.requiredActorFields?.length ?? 0,
        };
        evidence.actorFields = [...actorFieldPaths]
          .sort(stableCompare)
          .map((fieldPath) => {
            const value = projectedField("Actor", postcondition.actorId, fieldPath);
            const present = value !== undefined && value !== null && String(value).trim().length > 0;
            const targetCatalog = UNIT_CLONE_MODEL_FIELDS.has(fieldPath)
              ? "Model"
              : fieldPath === "PortraitActor" ? "Actor" : null;
            const resolvedObjectId = targetCatalog ? resolveActorToken(value) : null;
            const targetExists = resolvedObjectId ? objectExists(targetCatalog, resolvedObjectId) : null;
            return {
              fieldPath,
              source: inferredActorFieldPaths.has(fieldPath) ? "inferred" : "declared",
              sourceValue: inferredActorFieldValues.get(fieldPath) ?? null,
              value: value ?? null,
              present,
              targetCatalog,
              resolvedObjectId,
              targetExists,
            };
          });
        if (evidence.actorFields.some((field) => !field.present)) {
          failures.push("actor-field-missing");
        }
        if (evidence.actorFields.some((field) => field.resolvedObjectId && !field.targetExists)) {
          failures.push("actor-field-target-missing");
        }

        evidence.vitals = UNIT_CLONE_VITAL_PAIRS.map(([maximumPath, startPath]) => {
          const sourceMaximum = projectedField("Unit", postcondition.sourceUnitId, maximumPath);
          const sourceStart = projectedField("Unit", postcondition.sourceUnitId, startPath);
          const targetMaximum = projectedField("Unit", postcondition.unitId, maximumPath);
          const targetStart = projectedField("Unit", postcondition.unitId, startPath);
          let matches = true;
          if (postcondition.vitalPolicy === "preserve-source") {
            matches = semanticScalarEquals(targetMaximum, sourceMaximum) &&
              semanticScalarEquals(targetStart, sourceStart);
          } else if (postcondition.vitalPolicy === "full-start") {
            const applicable = targetMaximum !== undefined || targetStart !== undefined;
            matches = !applicable || (
              targetMaximum !== undefined && targetStart !== undefined &&
              semanticScalarEquals(targetMaximum, targetStart)
            );
          }
          return {
            maximumPath,
            startPath,
            sourceMaximum: sourceMaximum ?? null,
            sourceStart: sourceStart ?? null,
            targetMaximum: targetMaximum ?? null,
            targetStart: targetStart ?? null,
            matches,
          };
        });
        if (postcondition.vitalPolicy && evidence.vitals.some((pair) => !pair.matches)) {
          failures.push(postcondition.vitalPolicy === "preserve-source"
            ? "vitals-not-preserved"
            : "vitals-not-full-at-start");
        }
      } else if (postcondition.kind === "ability.effect-chain") {
        evidence.abilityExists = objectExists("Abil", postcondition.abilityId);
        if (!evidence.abilityExists) failures.push("ability-missing");
        evidence.effectPath = postcondition.effectPath;
        evidence.rootEffectId = postcondition.rootEffectId;
        evidence.projectedRootEffectId = projectedField(
          "Abil",
          postcondition.abilityId,
          postcondition.effectPath,
        ) ?? null;
        if (String(evidence.projectedRootEffectId ?? "") !== postcondition.rootEffectId) {
          failures.push("effect-root-mismatch");
        }
        if (!objectExists("Effect", postcondition.rootEffectId)) failures.push("root-effect-missing");

        const reachable = new Map();
        const missingTargets = new Set();
        const queue = [postcondition.rootEffectId];
        let truncated = false;
        while (queue.length > 0) {
          const current = queue.shift();
          const normalized = String(current).toLowerCase();
          if (reachable.has(normalized)) continue;
          if (reachable.size >= 256) {
            truncated = true;
            break;
          }
          reachable.set(normalized, String(current));
          if (!objectExists("Effect", current)) {
            missingTargets.add(String(current));
            continue;
          }
          for (const reference of projectedEffectTargets(current)) {
            if (!objectExists("Effect", reference.objectId)) {
              missingTargets.add(reference.objectId);
            } else if (!reachable.has(reference.objectId.toLowerCase())) {
              queue.push(reference.objectId);
            }
          }
        }
        const requiredEffects = [
          postcondition.rootEffectId,
          ...(postcondition.requiredEffectIds ?? []),
        ];
        evidence.reachableEffectIds = [...reachable.values()].sort(stableCompare);
        evidence.missingEffectIds = [...missingTargets].sort(stableCompare);
        evidence.unreachableRequiredEffectIds = requiredEffects.filter((effectId) =>
          !reachable.has(effectId.toLowerCase()));
        evidence.truncated = truncated;
        if (missingTargets.size > 0) failures.push("effect-link-target-missing");
        if (requiredEffects.some((effectId) => !objectExists("Effect", effectId))) {
          failures.push("required-effect-missing");
        }
        if (evidence.unreachableRequiredEffectIds.length > 0) {
          failures.push("required-effect-unreachable");
        }
        if (truncated) failures.push("effect-chain-truncated");
      } else if (postcondition.kind === "localization.present") {
        evidence.entries = postcondition.entries.map((entry) => {
          const value = projectedLocalizedText(entry.locale, entry.key);
          const present = typeof value === "string" && value.trim().length > 0;
          const matches = !hasOwn(entry, "expected") || value === entry.expected;
          return {
            ...entry,
            value: value ?? null,
            present,
            matches,
          };
        });
        if (evidence.entries.some((entry) => !entry.present)) failures.push("localization-missing");
        if (evidence.entries.some((entry) => entry.present && !entry.matches)) {
          failures.push("localization-mismatch");
        }
      } else {
        const state = projectedUnitState(postcondition.unitId);
        const abilityIds = new Set([...state.abilities.values()].map(String));
        const commands = [...state.commands.values()];
        evidence.unitExists = objectExists("Unit", postcondition.unitId);
        evidence.abilityAttached = postcondition.abilityId
          ? abilityIds.has(postcondition.abilityId)
          : null;
        if (!evidence.unitExists) failures.push("unit-missing");

        if (["unit.ability", "unit.command", "unit.autocast"].includes(postcondition.kind)) {
          evidence.abilityExists = objectExists("Abil", postcondition.abilityId);
          if (!evidence.abilityExists) failures.push("ability-missing");
          if (!evidence.abilityAttached) failures.push("ability-not-attached");
        }

        if (["unit.command", "unit.autocast", "unit.passive"].includes(postcondition.kind)) {
          const expectedAbilCmd = postcondition.abilityId
            ? `${postcondition.abilityId},${postcondition.command}`
            : null;
          const matchingCommands = commands.filter((entry) => {
            const attributes = entry.attributes;
            if (postcondition.kind === "unit.passive") {
              if (String(attributes.Type ?? "").toLowerCase() !== "passive") return false;
            } else {
              if (String(attributes.Type ?? "").toLowerCase() !== "abilcmd") return false;
              if (String(attributes.AbilCmd ?? "") !== expectedAbilCmd) return false;
            }
            if (String(attributes.Face ?? "") !== postcondition.buttonId) return false;
            if (
              postcondition.cardIndex !== undefined &&
              comparableArrayIndex(entry.cardIndex) !== postcondition.cardIndex
            ) return false;
            if (postcondition.row !== undefined && Number(attributes.Row) !== postcondition.row) return false;
            if (postcondition.column !== undefined && Number(attributes.Column) !== postcondition.column) return false;
            if (hasOwn(postcondition, "requirementId")) {
              const cardRequirement = normalizeRequirement(attributes.Requirements);
              const abilityRequirement = postcondition.abilityId
                ? normalizeRequirement(projectedField(
                    "Abil",
                    postcondition.abilityId,
                    `CmdButtonArray[${postcondition.command}].@Requirements`,
                  ))
                : null;
              if (postcondition.requirementId === null) {
                if (cardRequirement !== null || abilityRequirement !== null) return false;
              } else if (
                cardRequirement !== postcondition.requirementId &&
                abilityRequirement !== postcondition.requirementId
              ) {
                return false;
              }
            }
            return true;
          });
          evidence.matchingCommandCount = matchingCommands.length;
          evidence.buttonExists = objectExists("Button", postcondition.buttonId);
          if (matchingCommands.length === 0) failures.push(
            postcondition.kind === "unit.passive" ? "passive-command-missing" : "visible-command-missing",
          );
          if (!evidence.buttonExists) failures.push("button-missing");
          if (typeof postcondition.requirementId === "string") {
            evidence.requirementExists = objectExists("Requirement", postcondition.requirementId);
            if (!evidence.requirementExists) {
              failures.push("requirement-missing");
            } else {
              evidence.requirementStatic = requirementStaticEvidence(postcondition.requirementId);
              if (evidence.requirementStatic.missingNodeIds.length > 0) {
                failures.push("requirement-node-missing");
              }
              if (evidence.requirementStatic.permanentlyLocked) {
                failures.push("requirement-permanently-locked");
              }
            }
          }
        }

        if (postcondition.kind === "unit.autocast") {
          evidence.autocastSupported = truthyCatalogValue(
            projectedField("Abil", postcondition.abilityId, "Flags[AutoCast]"),
          );
          evidence.autocastDefaultOn = truthyCatalogValue(
            projectedField("Abil", postcondition.abilityId, "Flags[AutoCastOn]"),
          );
          if (!evidence.autocastSupported) failures.push("autocast-not-supported");
          if (
            postcondition.defaultOn !== undefined &&
            evidence.autocastDefaultOn !== postcondition.defaultOn
          ) {
            failures.push("autocast-default-mismatch");
          }
        }
      }

      const status = failures.length === 0 ? "passed" : "failed";
      postconditionResults.push({ ...postcondition, status, evidence, failures });
      if (status === "failed") {
        diagnostics.push(diagnostic({
          severity: "error",
          code: "POSTCONDITION_NOT_SATISFIED",
          target: postTarget,
          message: `${postcondition.kind} '${postcondition.postId}' is not satisfied by the projected effective Catalog state.`,
          details: { postcondition, evidence, failures },
        }));
      }
    }

    const commanderScope = plan.scope?.kind === "commander" ? plan.scope : null;
    const isolationStrategy = plan.isolation?.strategy ?? null;
    const scopeEvidence = (catalog, objectId, operation) => {
      if(catalog==='Upgrade'&&operation?.kind==='catalog.set'&&/^EffectArray\[\d+\]\.@Value$/.test(operation.path)) {
        const evidence=upgradeOperandScope(database,objectId,commanderScope?.commanderId);
        if(evidence&&!evidence.truncated)return evidence;
      }
      const metadata=masteryMetadataScope(database,catalog,objectId,operation?.path,commanderScope?.commanderId);
      if(metadata)return metadata;
      const membershipIds = readMemberships
        ? readMemberships.all(catalog, objectId).map((row) => row.commanderId)
        : [];
      const consumers = [
        ...(readIncomingConsumers ? readIncomingConsumers.all(catalog, objectId) : []),
        ...(readChildren ? readChildren.all(catalog, objectId) : []),
      ];
      const outsideCommanders = new Set(membershipIds.filter(
        (commanderId) => commanderId !== commanderScope?.commanderId,
      ));
      const unownedConsumers = [];
      for (const consumer of consumers) {
        const consumerMemberships = readMemberships
          ? readMemberships.all(consumer.catalog, consumer.objectId).map((row) => row.commanderId)
          : [];
        for (const commanderId of consumerMemberships) {
          if (commanderId !== commanderScope?.commanderId) outsideCommanders.add(commanderId);
        }
        if (consumerMemberships.length === 0) unownedConsumers.push({ ...consumer });
      }
      return {
        membershipIds,
        outsideCommanders: [...outsideCommanders].sort(stableCompare),
        unownedConsumers,
        consumers,
      };
    };

    const objectName = (catalog, objectId) => {
      const key = `${catalog}/${objectId}`.toLowerCase();
      if (names.has(key)) return names.get(key);
      let display = objectId;
      if (readNameField && readLocalizedName) {
        const nameField = readNameField.get(catalog, objectId);
        if (nameField?.value) {
          const textKey = String(nameField.value).replaceAll("##id##", objectId);
          const localized = readLocalizedName.get(textKey);
          if (localized?.value) display = cleanLocalizedName(localized.value) || display;
        }
      }
      names.set(key, display);
      return display;
    };
    for (const operation of plan.operations ?? []) {
      if (operation.catalog === "Unit" && operation.object) objectName("Unit", operation.object);
      if (operation.kind === "catalog.clone" && operation.catalog === "Unit") {
        objectName("Unit", operation.source);
      }
      if (operation.kind === "commander.unit.clone") {
        objectName("Unit", operation.sourceUnit);
        objectName("Unit", operation.unitId);
      }
      if (operation.attributes?.Face) objectName("Button", operation.attributes.Face);
    }

    const { known: knownAbilities, parents: unitParents } = readCoreUnitAbilities(coreRoot);
    if (hasFieldValues) {
      const unitIds = new Set();
      for (const operation of plan.operations ?? []) {
        if (operation.catalog === "Unit" && operation.object) unitIds.add(operation.object);
        if (operation.kind === "catalog.clone" && operation.catalog === "Unit") unitIds.add(operation.source);
        if (operation.kind === "commander.unit.clone") {
          unitIds.add(operation.sourceUnit);
          unitIds.add(operation.unitId);
        }
      }
      for (const button of planButtonCommands(plan)) unitIds.add(button.unitId);
      const abilityRows = database.prepare(`
        SELECT path, value FROM catalog_fields
        WHERE catalog='Unit' AND object_id=?
          AND lower(path) LIKE 'abilarray%'
        ORDER BY path
      `);
      for (const unitId of unitIds) {
        for (const row of abilityRows.all(unitId)) {
          if (/^AbilArray(?:\[(?:#?\d+)\])?\.\@?Link$/i.test(row.path)) {
            addKnownAbility(knownAbilities, unitId, row.value);
          }
        }
      }
    }
    if (!actual) applyPlanAbilityAttachments(plan, knownAbilities, unitParents);

    for (const button of planButtonCommands(plan)) {
      const [abilityId] = button.abilityCommand.split(",");
      if (!abilityId || /^\d+$/.test(abilityId)) continue;
      if (options.phase === "pre") continue;
      if (actual ? [...projectedUnitState(button.unitId).abilities.values()].includes(abilityId)
        : knownAbilities.get(button.unitId)?.has(abilityId)) continue;
      diagnostics.push(diagnostic({
        severity: "error",
        code: "BUTTON_ABILITY_NOT_ATTACHED",
        operation: button.operation,
        target: patchOperationTarget(button.operation),
        message: `${objectName("Unit", button.unitId)} has a command-card button for ${abilityId}, but the effective Unit ability slots do not contain that Ability.`,
        details: { unitId: button.unitId, abilityId },
      }));
    }

    for (const operation of plan.operations ?? []) {
      const target = patchOperationTarget(operation);
      if (["commander.stat.set", "commander.unit.clone"].includes(operation.kind)) {
        if (!commanderExists.get(operation.commanderId)) {
          diagnostics.push(diagnostic({
            severity: "error",
            code: "UNKNOWN_COMMANDER",
            operation,
            target,
            message: `Commander '${operation.commanderId}' does not exist in the current co-op database.`,
          }));
        }
      }
      if (operation.kind === "commander.unit.clone") {
        const incomingReferences = readIncomingUnitReferences
          ? readIncomingUnitReferences.all(operation.sourceUnit)
          : [];
        const creationEntrypoints = incomingReferences.filter(isUnitCreationReference).map(entry => ({
          ...entry, fieldPath: canonicalEditPath(entry.sourceClass, entry.fieldPath),
        }));
        const patchableCreationEntrypoints = creationEntrypoints.filter(
          (entry) => !/\[#\d+\]/.test(entry.fieldPath),
        );
        for (const redirect of operation.redirects ?? []) {
          if (!/\[#\d+\]/.test(redirect.path)) continue;
          diagnostics.push(diagnostic({
            severity: "error",
            code: "NON_PATCHABLE_ORDINAL_REDIRECT",
            operation,
            target,
            message: `${redirect.catalog}/${redirect.object}/${redirect.path} is ordinal query evidence, not a writable PatchPlan redirect. Resolve an explicit array index first.`,
          }));
        }
        const normalizedRedirects = new Set((operation.redirects ?? []).map((redirect) =>
          `${redirect.catalog}/${redirect.object}/${redirect.path}`.toLowerCase()));
        const redirectedEntrypoints = patchableCreationEntrypoints.filter((entry) =>
          normalizedRedirects.has(`${entry.catalog}/${entry.objectId}/${entry.fieldPath}`.toLowerCase()));
        const runtimeEntrypoint = (plan.operations ?? []).some((candidate) =>
          candidate.kind === "galaxy.source" &&
          String(candidate.source ?? "").includes(`\"${operation.unitId}\"`));
        const details = {
          sourceUnit: operation.sourceUnit,
          unitId: operation.unitId,
          knownCreationEntrypoints: creationEntrypoints.slice(0, 24).map((entry) => ({
            catalog: entry.catalog,
            object: entry.objectId,
            path: entry.fieldPath,
            confidence: entry.confidence,
          })),
          redirectedCreationEntrypoints: redirectedEntrypoints.length,
          runtimeEntrypoint,
        };
        if (creationEntrypoints.length > 0 && redirectedEntrypoints.length === 0 && !runtimeEntrypoint) {
          diagnostics.push(diagnostic({
            severity: "error",
            code: "UNIT_CLONE_MISSING_CREATION_REDIRECT",
            operation,
            target,
            message: `${operation.unitId} clones ${operation.sourceUnit}, but none of its redirects is a proven training, creation, starting-unit, or revival entrypoint.`,
            details,
          }));
        } else if (creationEntrypoints.length === 0 && !runtimeEntrypoint) {
          diagnostics.push(diagnostic({
            code: "UNIT_CLONE_CREATION_ENTRYPOINT_UNPROVEN",
            operation,
            target,
            message: `No Catalog or generated Galaxy creation entrypoint was proven for ${operation.unitId}; verify how the private Unit becomes reachable.`,
            details,
          }));
        }
      }
      if (
        commanderScope &&
        DIRECT_CATALOG_WRITE_KINDS.has(operation.kind) &&
        !createdObjects.has(`${operation.catalog}/${operation.object}`.toLowerCase())
      ) {
        const object = objectRecord(operation.catalog, operation.object);
        if (object) {
          const evidence = scopeEvidence(object.catalog, object.objectId, operation);
          if (["private-clone", "player-upgrade", "player-runtime"].includes(isolationStrategy)) {
            diagnostics.push(diagnostic({
              severity: "error",
              code: "COMMANDER_SCOPE_WRITES_BASE_OBJECT",
              operation,
              target,
              message: `${object.catalog}/${object.objectId} is an official database object, but the plan promises ${isolationStrategy} isolation. Clone or player-scope the write instead of changing the shared base object.`,
              details: evidence,
            }));
          } else if (isolationStrategy === "direct-private") {
            if (evidence.outsideCommanders.length > 0) {
              diagnostics.push(diagnostic({
                severity: "error",
                code: "DIRECT_PRIVATE_HAS_OUTSIDE_COMMANDERS",
                operation,
                target,
                message: `${object.catalog}/${object.objectId} is associated with commanders outside '${commanderScope.commanderId}', so it is not proven private.`,
                details: evidence,
              }));
            } else if (
              !evidence.membershipIds.includes(commanderScope.commanderId) ||
              evidence.unownedConsumers.length > 0
            ) {
              diagnostics.push(diagnostic({
                code: "DIRECT_PRIVATE_NOT_PROVEN",
                operation,
                target,
                message: `${object.catalog}/${object.objectId} has not been proven exclusive to '${commanderScope.commanderId}'; inspect the unowned consumers before relying on direct-private isolation.`,
                details: evidence,
              }));
            } else {
              diagnostics.push(diagnostic({
                code: "DIRECT_PRIVATE_BOUNDED_EVIDENCE",
                operation,
                target,
                message: `${object.catalog}/${object.objectId} is private only within the parsed Catalog evidence; enemy compositions, Galaxy strings, and engine defaults remain outside this proof.`,
                details: evidence,
              }));
            }
          }
        }
      }
      if (operation.kind === "catalog.insert" && operation.catalog === "Unit") {
        const object = objectRecord(operation.catalog, operation.object);
        const index = nonNegativeIntegerIndex(operation.index);
        if (object && index !== null) {
          const paths = fieldPaths.all(object.catalog, object.objectId).map((row) => row.path);
          const occupied = implicitOrdinalOccupancy(paths, operation.path);
          if (occupied > 0 && index < occupied) {
            diagnostics.push(diagnostic({
              severity: "error",
              code: "ARRAY_INDEX_COLLIDES_WITH_EFFECTIVE_ENTRY",
              operation,
              target,
              message: `Array index ${index} collides with inherited unindexed entries on ${object.catalog}/${object.objectId}; use an index of at least ${occupied}.`,
              details: { occupiedImplicitSlots: occupied, minimumFreeIndex: occupied },
            }));
          }
        }
      }
      if (!["catalog.set", "catalog.remove", "commander.stat.set"].includes(operation.kind)) continue;
      if (createdObjects.has(`${operation.catalog}/${operation.object}`.toLowerCase())) continue;
      const object = objectRecord(operation.catalog, operation.object);
      if (!object || fieldExists.get(object.catalog, object.objectId, operation.path)) continue;

      const requestedLeaf = pathLeaf(operation.path);
      const requestedPrefix = String(operation.path).slice(0, Math.max(0, String(operation.path).length - requestedLeaf.length));
      const candidates = fieldPaths.all(object.catalog, object.objectId)
        .map((row) => row.path)
        .filter((candidate) => {
          const candidateLeaf = pathLeaf(candidate);
          const candidatePrefix = candidate.slice(0, Math.max(0, candidate.length - candidateLeaf.length));
          return candidatePrefix.toLowerCase() === requestedPrefix.toLowerCase();
        })
        .map((candidate) => ({
          path: candidate,
          distance: damerauLevenshtein(
            requestedLeaf.toLowerCase(),
            pathLeaf(candidate).toLowerCase(),
          ),
        }))
        .filter((candidate) => candidate.distance <= 2)
        .sort((left, right) => left.distance - right.distance || stableCompare(left.path, right.path));
      if (candidates.length === 0) continue;
      diagnostics.push(diagnostic({
        severity: "error",
        code: "UNKNOWN_FIELD_POSSIBLE_TYPO",
        operation,
        target,
        message: `Catalog field '${operation.path}' is absent; '${candidates[0].path}' is the nearest effective field on ${object.catalog}/${object.objectId}.`,
        details: { suggestions: candidates.slice(0, 3).map((candidate) => candidate.path) },
      }));
    }
    return {
      evidence: { checked: true, databaseFile },
      names,
      postconditions: postconditionResults,
    };
  } finally {
    database.close();
  }
}

const actualPhase = (options) => options.artifacts ? "staged-artifacts" : options.phase === "pre" ? "pre-execution" : "plan-preview";

export function reviewPatchPlan(plan, options = {}) {
  const operations = Array.isArray(plan?.operations) ? plan.operations : [];
  const changes = operations.map((operation, index) => projectPatchOperation(operation, index));
  const diagnostics = [];
  const vitalWrites = new Set();
  const scalarWrites = new Map();
  const declaredScope = plan?.scope ?? null;
  const isolation = plan?.isolation ?? null;

  if (declaredScope && !isolation) {
    diagnostics.push(diagnostic({
      severity: "error",
      code: "MISSING_ISOLATION_CONTRACT",
      message: "A scoped PatchPlan must declare the isolation strategy that keeps the requested blast radius explicit.",
      details: { scope: declaredScope },
    }));
  }
  if (!declaredScope && isolation) {
    diagnostics.push(diagnostic({
      severity: "error",
      code: "ISOLATION_WITHOUT_SCOPE",
      message: "An isolation strategy is meaningful only when the PatchPlan declares its intended scope.",
    }));
  }
  if (declaredScope?.kind === "commander" && isolation?.strategy === "global") {
    diagnostics.push(diagnostic({
      severity: "error",
      code: "SCOPE_ISOLATION_MISMATCH",
      message: "A commander-scoped PatchPlan cannot declare global isolation.",
    }));
  }
  if (declaredScope?.kind === "global" && isolation && isolation.strategy !== "global") {
    diagnostics.push(diagnostic({
      severity: "error",
      code: "SCOPE_ISOLATION_MISMATCH",
      message: "A global PatchPlan must declare the global isolation strategy.",
    }));
  }

  for (const operation of operations) {
    const target = patchOperationTarget(operation);

    if (
      declaredScope?.kind === "commander" &&
      ["commander.stat.set", "commander.unit.clone"].includes(operation.kind) &&
      operation.commanderId !== declaredScope.commanderId
    ) {
      diagnostics.push(diagnostic({
        severity: "error",
        code: "COMMANDER_SCOPE_MISMATCH",
        operation,
        target,
        message: `${operation.kind} targets '${operation.commanderId}', but the plan scope is '${declaredScope.commanderId}'.`,
      }));
    }
    if (
      declaredScope?.kind === "global" &&
      ["commander.stat.set", "commander.unit.clone"].includes(operation.kind)
    ) {
      diagnostics.push(diagnostic({
        severity: "error",
        code: "GLOBAL_SCOPE_HAS_COMMANDER_OPERATION",
        operation,
        target,
        message: `${operation.kind} is player-scoped and cannot satisfy a global PatchPlan scope.`,
      }));
    }
    if (
      declaredScope?.kind === "commander" &&
      isolation?.strategy === "player-upgrade" &&
      operation.kind !== "commander.stat.set"
    ) {
      diagnostics.push(diagnostic({
        severity: "error",
        code: "PLAYER_UPGRADE_HAS_STRUCTURAL_OPERATION",
        operation,
        target,
        message: "player-upgrade isolation may contain only commander.stat.set operations; structural Catalog writes need a private clone or proven private owner.",
      }));
    }

    if (
      operation.kind === "catalog.insert" &&
      operation.catalog === "Unit" &&
      (
        operation.path === "AbilArray" ||
        /^CardLayouts\[[^\]]+\]\.LayoutButtons$/.test(operation.path)
      ) &&
      nonNegativeIntegerIndex(operation.index) === null
    ) {
      diagnostics.push(diagnostic({
        severity: "error",
        code: "INVALID_UNIT_ARRAY_INDEX",
        operation,
        target,
        message: `${operation.path} requires a real non-negative numeric SC2 array slot; the linked Ability or Button ID belongs in the entry attributes, not in index.`,
      }));
    }

    if (GUARDED_OPERATION_KINDS.has(operation.kind) && !hasOwn(operation, "expect")) {
      diagnostics.push(diagnostic({
        code: "MISSING_EXPECT",
        operation,
        target,
        message: `${operation.kind} does not declare an expect precondition, so the intended source value is not explicit.`,
      }));
    }

    if (operation.kind === "catalog.clear") {
      diagnostics.push(diagnostic({
        code: "CLEAR_WITHOUT_PRECONDITION",
        operation,
        target,
        message: "catalog.clear removes the complete target collection without a value precondition; verify that the broad removal is intentional.",
      }));
    }

    if (operation.kind === "catalog.clone" && operation.catalog === "Unit") {
      diagnostics.push(diagnostic({
        code: "RAW_UNIT_CLONE_REQUIRES_COMPANIONS",
        operation,
        target,
        message: "A raw Unit catalog clone does not itself clone or redirect companion Actor, localization, production, upgrade, or command-card links.",
      }));
    }

    const leaf = pathLeaf(operation.path);
    const correction = SAFE_PATH_CORRECTIONS.get(leaf);
    if (operation.catalog === "Unit" && correction) {
      diagnostics.push(diagnostic({
        code: "LIKELY_CATALOG_PATH_TYPO",
        operation,
        target,
        message: `Unit field '${leaf}' is likely a typo; the SC2 vital field is '${correction}'.`,
        details: { suggestedPath: operation.path.replace(new RegExp(`${leaf}$`), correction) },
      }));
    }

    const scope = vitalScope(operation);
    if (scope && operation.path) {
      vitalWrites.add(`${scope}/${pathLeaf(operation.path)}`);
    }

    if (["catalog.set", "catalog.remove", "commander.stat.set", "locale.set"].includes(operation.kind)) {
      const prior = scalarWrites.get(target);
      if (prior) {
        const nextHasExpectedPrior = hasOwn(operation, "expect") &&
          semanticScalarEquals(prior.result, operation.expect);
        if (!nextHasExpectedPrior) {
          diagnostics.push(diagnostic({
            severity: "error",
            code: "AMBIGUOUS_REWRITE",
            operation,
            target,
            message: `The target is written more than once; the later operation must expect the earlier operation's result.`,
            details: {
              previousOpId: prior.opId,
              previousResult: prior.result,
              declaredExpect: hasOwn(operation, "expect") ? operation.expect : null,
            },
          }));
        }
      }
      scalarWrites.set(target, {
        opId: operation.opId,
        result: operation.kind === "catalog.remove" ? null : operation.value,
      });
    }
  }

  if (declaredScope?.kind === "commander" && isolation?.strategy === "private-clone") {
    const owner = isolation.owner;
    const ownerClone = operations.find((operation) => (
      owner?.catalog === "Unit" &&
      operation.kind === "commander.unit.clone" &&
      operation.commanderId === declaredScope.commanderId &&
      operation.sourceUnit === owner.object
    ) || (
      operation.kind === "catalog.clone" &&
      operation.catalog === owner?.catalog &&
      operation.source === owner?.object
    ));
    if (!ownerClone) {
      diagnostics.push(diagnostic({
        severity: "error",
        code: "ISOLATION_OWNER_NOT_CLONED",
        message: `private-clone isolation requires a clone of ${owner?.catalog ?? "?"}/${owner?.object ?? "?"} and an explicit player-scoped rewire.`,
        details: { owner: owner ?? null, commanderId: declaredScope.commanderId },
      }));
    }

    const planReferencesObject = (catalog, objectId, sourceOpId) => operations.some((operation) => {
      if (operation.opId === sourceOpId) return false;
      if (operation.kind === "catalog.set" && operation.value === objectId) return true;
      if (operation.kind === "catalog.insert") {
        if (operation.value === objectId) return true;
        if (Object.values(operation.attributes ?? {}).includes(objectId)) return true;
      }
      if (operation.kind === "catalog.create" && operation.parent === objectId && operation.catalog === catalog) {
        return true;
      }
      return operation.kind === "galaxy.source" && String(operation.source ?? "").includes(`\"${objectId}\"`);
    });
    for (const clone of operations.filter((operation) => operation.kind === "catalog.clone")) {
      if (planReferencesObject(clone.catalog, clone.object, clone.opId)) continue;
      diagnostics.push(diagnostic({
        severity: clone === ownerClone ? "error" : "warning",
        code: clone === ownerClone ? "ISOLATION_OWNER_NOT_REWIRED" : "ISOLATED_CLONE_NOT_REWIRED",
        operation: clone,
        target: patchOperationTarget(clone),
        message: `${clone.catalog}/${clone.object} is cloned for isolation but no explicit plan operation points an owner or private dependency at it.`,
        details: { source: `${clone.catalog}/${clone.source}` },
      }));
    }
  }

  const databaseContext = addDatabaseDiagnostics(
    plan,
    diagnostics,
    options.databaseFile,
    options.coreRoot,
    options,
  );

  for (const operation of operations) {
    const scope = vitalScope(operation);
    const maxPath = pathLeaf(operation.path);
    const startPath = VITAL_START_PATHS.get(maxPath);
    if (!scope || !startPath || vitalWrites.has(`${scope}/${startPath}`)) continue;

    const target = patchOperationTarget(operation);
    diagnostics.push(diagnostic({
      code: "VITAL_START_NOT_UPDATED",
      operation,
      target,
      message: `${maxPath} changes without a matching ${startPath} change in the same target scope; newly created units may start with the old current value.`,
      details: { requiredPath: startPath, scope },
    }));
  }

  const systemCounts = new Map();
  for (const change of changes) {
    systemCounts.set(change.system, (systemCounts.get(change.system) ?? 0) + 1);
  }
  const affectedSystems = [...systemCounts.entries()]
    .sort(([left], [right]) => stableCompare(left, right))
    .map(([system, operationCount]) => ({ system, operationCount }));

  const errorCount = diagnostics.filter((item) => item.severity === "error").length;
  const warningCount = diagnostics.length - errorCount;
  return {
    reviewVersion: 2,
    validationPhase: actualPhase(options),
    status: errorCount > 0 ? "errors" : warningCount > 0 ? "warnings" : "passed",
    plan: {
      id: plan?.id ?? null,
      title: plan?.title ?? null,
      target: plan?.target ?? null,
      formatVersion: plan?.formatVersion ?? null,
      scope: plan?.scope ?? null,
      isolation: plan?.isolation ?? null,
    },
    summary: {
      operationCount: changes.length,
      postconditionCount: databaseContext.postconditions.length,
      affectedSystemCount: affectedSystems.length,
      errorCount,
      warningCount,
    },
    evidence: { catalogDatabase: databaseContext.evidence },
    postconditions: databaseContext.postconditions,
    affectedSystems,
    changes,
    diagnostics,
    userSummary: buildUserSummary(plan, databaseContext.names),
  };
}

export function attachPatchExecution(review, reportOperations = [], options = {}) {
  const stage = options.stage ?? "static-checked";
  const applied = stage === "applied";
  const failed = review.status === "errors";
  const operationsById = new Map(
    (Array.isArray(reportOperations) ? reportOperations : []).map((operation) => [operation.opId, operation]),
  );
  const counts = {};
  const changes = review.changes.map((change) => {
    const execution = operationsById.get(change.opId) ?? null;
    const status = execution?.status ?? "not-reported";
    counts[status] = (counts[status] ?? 0) + 1;
    return {
      ...change,
      execution: execution ? {
        status,
        verified: Boolean(execution.verified),
        target: execution.target ?? change.target,
        targets: execution.targets ?? change.targets,
        outcome: status === "already"
          ? applied
            ? "The installed Map Runtime core already had the requested result."
            : "The rehearsed core already has the requested result."
          : status === "changed"
            ? applied
              ? "The requested result was written to the Map Runtime core."
              : "The rehearsal produced the requested result."
            : `Executor reported ${status}.`,
      } : {
        status,
        verified: false,
        target: change.target,
        targets: change.targets,
        outcome: "The executor did not return an operation result.",
      },
    };
  });
  return {
    ...review,
    userSummary: {
      ...review.userSummary,
      verificationLevel: failed
        ? "static-review-failed"
        : applied
          ? "applied-to-source"
          : "static-preflight",
      verificationLabel: failed
        ? "静态语义审查未通过；计划未进入沙盒预演，也未写入地图运行层。"
        : applied
          ? "已写入地图运行层并生成 Receipt；尚未启动游戏，未完成试玩验证。"
          : "静态语义检查与沙盒预演通过；尚未写入地图运行层，也未完成试玩验证。",
      runtimeVerified: false,
    },
    summary: {
      ...review.summary,
      executionStatusCounts: Object.fromEntries(
        Object.entries(counts).sort(([left], [right]) => stableCompare(left, right)),
      ),
    },
    changes,
  };
}
