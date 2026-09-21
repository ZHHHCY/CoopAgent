import { resolveSc2DataReferences } from "./sc2-data-reference.mjs";

const BASIC_ABILITY_IDS = new Set([
  "attack",
  "battlecruiserattack",
  "battlecruisermove",
  "battlecruiserstop",
  "move",
  "stop",
]);

const BASIC_BUTTON_FACES = new Set([
  "acquiremove",
  "attack",
  "cancel",
  "cancelslot",
  "move",
  "moveholdposition",
  "movepatrol",
  "stop",
]);

const commanderContextCache = new WeakMap();
const upgradeEffectCache = new WeakMap();

function tableExists(database, tableName) {
  return Boolean(database
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(tableName));
}

function catalogObject(database, catalog, objectId) {
  if (!objectId) return null;
  return database
    .prepare(`
      SELECT class, parent_id AS parentId, source_file AS sourceFile
      FROM catalog_objects
      WHERE catalog=? AND object_id=?
    `)
    .get(catalog, objectId) ?? null;
}

function catalogField(database, catalog, objectId, fieldPath) {
  if (!objectId || !fieldPath) return null;
  const exact = database
    .prepare(`
      SELECT value
      FROM catalog_fields
      WHERE catalog=? AND object_id=? AND lower(path)=?
    `)
    .get(catalog, objectId, fieldPath.toLowerCase());
  if (exact) return exact.value;
  const canonical = fieldPath.replaceAll('.@', '.').replaceAll('[#', '[').toLowerCase();
  const candidates = database.prepare(`SELECT value FROM catalog_fields WHERE catalog=? AND object_id=?
    AND lower(replace(replace(path,'.@','.'),'[#','['))=?`).all(catalog, objectId, canonical);
  return candidates.length === 1 ? candidates[0].value : null;
}

function numericCatalogField(database, catalog, objectId, fieldPath) {
  const rawValue = catalogField(database, catalog, objectId, fieldPath);
  if (rawValue === null) return null;
  const value = Number(rawValue);
  return Number.isFinite(value) ? value : null;
}

function firstCatalogField(database, catalog, objectId, fieldPaths) {
  for (const fieldPath of fieldPaths) {
    const value = catalogField(database, catalog, objectId, fieldPath);
    if (value !== null) return value;
  }
  return null;
}

function firstNumericCatalogField(database, catalog, objectId, fieldPaths) {
  for (const fieldPath of fieldPaths) {
    const value = numericCatalogField(database, catalog, objectId, fieldPath);
    if (value !== null) return value;
  }
  return null;
}

function localizedText(database, locale, textKey) {
  if (!textKey) return null;
  return database
    .prepare("SELECT value FROM localized_text WHERE lower(locale)=? AND text_key=?")
    .get(locale.toLowerCase(), textKey)?.value ?? null;
}

function primaryLocalizedText(value) {
  return value?.split(" /// ")[0]?.trim() || null;
}

function localizedCatalogField(database, catalog, objectId, fieldName, fallbackKey) {
  const rawKey = catalogField(database, catalog, objectId, fieldName);
  const textKey = (rawKey ?? fallbackKey)?.replaceAll("##id##", objectId);
  return primaryLocalizedText(localizedText(database, "zhcn", textKey));
}

function localizedButton(database, buttonId) {
  return {
    name: localizedCatalogField(
      database,
      "Button",
      buttonId,
      "Name",
      `Button/Name/${buttonId}`,
    ) ?? buttonId,
    description: localizedCatalogField(
      database,
      "Button",
      buttonId,
      "Tooltip",
      `Button/Tooltip/${buttonId}`,
    ) ?? "暂无官方说明。",
  };
}

function formatNumber(value) {
  return String(Number(value.toFixed(2)));
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function naturalCompare(left, right) {
  return left.localeCompare(right, "en", { numeric: true, sensitivity: "base" });
}

function readProfile(database, commanderId) {
  const raw = database
    .prepare("SELECT profile_json AS profileJson FROM commander_profiles WHERE commander_id=?")
    .get(commanderId)?.profileJson;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function arrayLinks(database, catalog, objectId, arrayName, fieldName = "Link") {
  const rows = database
    .prepare(`
      SELECT path, value
      FROM catalog_fields
      WHERE catalog=? AND object_id=? AND lower(path) LIKE ?
      ORDER BY path
    `)
    .all(catalog, objectId, `${arrayName.toLowerCase()}%`);
  const pattern = new RegExp(
    `^${arrayName}(?:\\[(#?)(\\d+)\\])?\\.\\@?${fieldName}$`,
    "i",
  );
  const appended = new Map();
  const overrides = new Map();
  let unindexed = null;
  for (const row of rows) {
    const match = pattern.exec(row.path);
    if (!match) continue;
    if (match[2] === undefined) {
      unindexed = row.value;
    } else if (match[1] === "#") {
      appended.set(Number(match[2]), row.value);
    } else {
      overrides.set(Number(match[2]), row.value);
    }
  }
  if (unindexed !== null && appended.size === 0) appended.set(0, unindexed);
  for (const [index, value] of overrides) appended.set(index, value);
  return [...appended.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, value]) => value)
    .filter(Boolean);
}

function morphAbilityIsAvailable(database, commanderContext, unitId, abilityId) {
  const button = unitCardButtons(database, [unitId]).find((candidate) =>
    candidate.type?.toLowerCase() === "abilcmd"
    && candidate.abilityCommand?.split(",")[0] === abilityId);
  if (!button) return false;
  const [, command = "Execute"] = button.abilityCommand.split(",");
  const requirementId = abilityCommandRequirement(database, abilityId, command)
    ?? button.requirementId;
  const evidence = requirementId ? requirementEvidence(database, requirementId) : null;
  if (requirementId && !requirementAllowed(database, commanderContext, evidence)) return false;
  const restricted = abilityCommandState(database, abilityId, command)?.toLowerCase()
    === "restricted";
  return !restricted
    || commanderContext.explicitAbilityLevels.has(abilityId)
    || requirementAllowed(database, commanderContext, evidence)
    || commanderModifiesObject(database, commanderContext, "Abil", abilityId);
}

function collectUnitForms(database, commanderContext, unitId) {
  const forms = [];
  const seen = new Set();
  const pending = [unitId];
  while (pending.length > 0 && seen.size < 12) {
    const candidate = pending.shift();
    if (seen.has(candidate) || !catalogObject(database, "Unit", candidate)) continue;
    seen.add(candidate);
    forms.push(candidate);
    for (const abilityId of arrayLinks(database, "Unit", candidate, "AbilArray")) {
      if (catalogObject(database, "Abil", abilityId)?.class !== "CAbilMorph"
        || !morphAbilityIsAvailable(database, commanderContext, candidate, abilityId)) continue;
      const targets = database
        .prepare(`
          SELECT value
          FROM catalog_fields
          WHERE catalog='Abil' AND object_id=?
            AND (lower(path) LIKE 'infoarray%.unit'
              OR lower(path) LIKE 'infoarray%.@unit')
          ORDER BY path
        `)
        .all(abilityId);
      for (const target of targets) {
        if (!seen.has(target.value) && catalogObject(database, "Unit", target.value)) {
          pending.push(target.value);
        }
      }
    }
  }
  return forms;
}

function fieldsWithLoadOrder(database, unitId) {
  if (!tableExists(database, "catalog_definitions")) {
    return database
      .prepare(`
        SELECT path, value, inheritance_depth AS inheritanceDepth, 0 AS loadOrder
        FROM catalog_fields
        WHERE catalog='Unit' AND object_id=?
          AND lower(path) LIKE 'cardlayouts%layoutbuttons%'
        ORDER BY path
      `)
      .all(unitId);
  }
  return database
    .prepare(`
      SELECT f.path, f.value, f.inheritance_depth AS inheritanceDepth,
             COALESCE((
               SELECT MAX(d.load_order)
               FROM catalog_definitions d
               WHERE d.catalog=f.catalog
                 AND d.object_id=f.origin_object_id
                 AND d.source_file=f.source_file
             ), -1) AS loadOrder
      FROM catalog_fields f
      WHERE f.catalog='Unit' AND f.object_id=?
        AND lower(f.path) LIKE 'cardlayouts%layoutbuttons%'
      ORDER BY loadOrder, f.path
    `)
    .all(unitId);
}

function unitCardButtons(database, forms) {
  const buttons = [];
  const propertyPattern = /^(CardLayouts.*?\.LayoutButtons(?:\[[^\]]+\])?)\.(?:@)?(AbilCmd|Face|Type|Requirements|Row|Column)$/i;
  for (let formIndex = 0; formIndex < forms.length; formIndex += 1) {
    const formId = forms[formIndex];
    const groups = new Map();
    for (const field of fieldsWithLoadOrder(database, formId)) {
      const match = propertyPattern.exec(field.path);
      if (!match) continue;
      const group = groups.get(match[1]) ?? { formId, formIndex, properties: new Map() };
      const property = match[2].toLowerCase();
      const priority = {
        loadOrder: Number(field.loadOrder),
        directness: -Number(field.inheritanceDepth),
        attribute: /\.@[^.]+$/i.test(field.path) ? 1 : 0,
      };
      const previous = group.properties.get(property);
      if (!previous
        || priority.loadOrder > previous.priority.loadOrder
        || (priority.loadOrder === previous.priority.loadOrder
          && priority.directness > previous.priority.directness)
        || (priority.loadOrder === previous.priority.loadOrder
          && priority.directness === previous.priority.directness
          && priority.attribute > previous.priority.attribute)) {
        group.properties.set(property, { value: field.value, priority });
      }
      groups.set(match[1], group);
    }
    for (const group of groups.values()) {
      const value = (name) => group.properties.get(name)?.value ?? null;
      buttons.push({
        formId,
        formIndex,
        type: value("type"),
        abilityCommand: value("abilcmd"),
        face: value("face"),
        requirementId: value("requirements"),
        row: Number(value("row") ?? 99),
        column: Number(value("column") ?? 99),
        loadOrder: Math.max(...[...group.properties.values()].map((item) => item.priority.loadOrder)),
      });
    }
  }
  const deduplicated = new Map();
  for (const button of buttons) {
    if (!button.face && !button.abilityCommand) continue;
    const key = [
      button.type ?? "",
      button.abilityCommand ?? "",
      button.face ?? "",
      button.requirementId ?? "",
    ].join("|").toLowerCase();
    const previous = deduplicated.get(key);
    if (!previous || button.loadOrder > previous.loadOrder) deduplicated.set(key, button);
  }
  return [...deduplicated.values()].sort((left, right) =>
    left.formIndex - right.formIndex
    || left.row - right.row
    || left.column - right.column
    || naturalCompare(left.face ?? left.abilityCommand ?? "", right.face ?? right.abilityCommand ?? ""));
}

function requirementEvidence(database, requirementId) {
  const upgrades = new Set();
  const tokens = new Set();
  const requirements = new Set();
  const pending = requirementId ? [requirementId] : [];
  while (pending.length > 0 && requirements.size < 96) {
    const candidate = pending.shift();
    if (requirements.has(candidate) || !catalogObject(database, "Requirement", candidate)) continue;
    requirements.add(candidate);
    tokens.add(candidate);
    const fields = database
      .prepare(`
        SELECT value
        FROM catalog_fields
        WHERE catalog='Requirement' AND object_id=?
        ORDER BY path
      `)
      .all(candidate);
    for (const field of fields) tokens.add(field.value);
    const references = database
      .prepare(`
        SELECT target_catalog AS targetCatalog, target_object_id AS targetObjectId
        FROM object_references
        WHERE source_catalog='Requirement' AND source_object_id=?
        ORDER BY field_path, target_catalog, target_object_id
      `)
      .all(candidate);
    for (const reference of references) {
      tokens.add(reference.targetObjectId);
      if (reference.targetCatalog === "Requirement") pending.push(reference.targetObjectId);
      if (reference.targetCatalog === "Upgrade") upgrades.add(reference.targetObjectId);
    }
  }
  for (const token of tokens) {
    if (catalogObject(database, "Upgrade", token)) upgrades.add(token);
  }
  return { upgrades, tokens, requirements };
}

function readResearchEntry(database, abilityId, researchIndex) {
  const prefix = `InfoArray[Research${researchIndex}]`;
  const upgradeId = firstCatalogField(database, "Abil", abilityId, [
    `${prefix}.@Upgrade`,
    `${prefix}.Upgrade`,
  ]);
  if (!upgradeId) return null;
  const buttonId = firstCatalogField(database, "Abil", abilityId, [
    `${prefix}.Button.@DefaultButtonFace`,
    `${prefix}.Button.DefaultButtonFace`,
  ]);
  const requirementId = firstCatalogField(database, "Abil", abilityId, [
    `${prefix}.Button.@Requirements`,
    `${prefix}.Button.Requirements`,
  ]);
  return {
    abilityId,
    researchIndex,
    prefix,
    upgradeId,
    buttonId,
    requirementId,
    state: firstCatalogField(database, "Abil", abilityId, [
      `${prefix}.Button.@State`,
      `${prefix}.Button.State`,
    ]),
    time: firstNumericCatalogField(database, "Abil", abilityId, [
      `${prefix}.@Time`,
      `${prefix}.Time`,
    ]),
    minerals: firstNumericCatalogField(database, "Abil", abilityId, [
      `${prefix}.Resource[Minerals]`,
      `${prefix}.@Resource[Minerals]`,
    ]),
    vespene: firstNumericCatalogField(database, "Abil", abilityId, [
      `${prefix}.Resource[Vespene]`,
      `${prefix}.@Resource[Vespene]`,
    ]),
  };
}

function allResearchEntries(database, abilityId) {
  const rows = database
    .prepare(`
      SELECT path
      FROM catalog_fields
      WHERE catalog='Abil' AND object_id=?
        AND (lower(path) LIKE 'infoarray[research%].@upgrade'
          OR lower(path) LIKE 'infoarray[research%].upgrade')
      ORDER BY path
    `)
    .all(abilityId);
  const indices = uniqueStrings(rows
    .map((row) => /^InfoArray\[Research(\d+)\]/i.exec(row.path)?.[1]))
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  return indices.map((index) => readResearchEntry(database, abilityId, index)).filter(Boolean);
}

function cachedUpgradeEffects(database, upgradeId) {
  let databaseCache = upgradeEffectCache.get(database);
  if (!databaseCache) {
    databaseCache = new Map();
    upgradeEffectCache.set(database, databaseCache);
  }
  if (databaseCache.has(upgradeId)) return databaseCache.get(upgradeId);
  const referenceFields = database
    .prepare(`
      SELECT path, value
      FROM catalog_fields
      WHERE catalog='Upgrade' AND object_id=?
        AND (lower(path) LIKE 'effectarray%.@reference' OR lower(path) LIKE 'effectarray%.reference')
      ORDER BY path
    `)
    .all(upgradeId);
  const effects = referenceFields.map((field) => {
    const basePath = field.path.replace(/\.@?Reference$/i, "");
    return {
      path: basePath,
      reference: field.value,
      operation: catalogField(database, "Upgrade", upgradeId, `${basePath}.@Operation`) ?? "Add",
      value: catalogField(database, "Upgrade", upgradeId, `${basePath}.Value`) ?? catalogField(database, "Upgrade", upgradeId, basePath),
    };
  });
  databaseCache.set(upgradeId, effects);
  return effects;
}

function parseDataReference(reference) {
  const [catalog, objectId, ...fieldParts] = reference.split(",");
  if (!catalog || !objectId || fieldParts.length === 0) return null;
  return { catalog, objectId, fieldPath: fieldParts.join(",") };
}

function buildCommanderContext(database, commanderId) {
  let contexts = commanderContextCache.get(database);
  if (!contexts) {
    contexts = new Map();
    commanderContextCache.set(database, contexts);
  }
  if (contexts.has(commanderId)) return contexts.get(commanderId);
  const profile = readProfile(database, commanderId) ?? {
    levelPerks: [],
    panel: { defaultUpgrades: [] },
  };
  const defaultUpgrades = uniqueStrings(profile.panel?.defaultUpgrades ?? []);
  const directUpgradeLevels = new Map();
  const explicitAbilityLevels = new Map();
  const researchAbilityIds = new Set();
  const linkedResearchEntries = [];
  const currentGateTokens = new Set([commanderId, ...defaultUpgrades]);
  for (const perk of profile.levelPerks ?? []) {
    currentGateTokens.add(perk.id);
    if (perk.levelId) currentGateTokens.add(perk.levelId);
    const links = perk.links ?? [];
    const implicitUpgrade = catalogObject(database, "Upgrade", perk.id) ? [perk.id] : [];
    for (const upgradeId of links
      .filter((link) => link.catalog === "Upgrade")
      .map((link) => link.objectId)
      .concat(implicitUpgrade)) {
      if (!directUpgradeLevels.has(upgradeId)) directUpgradeLevels.set(upgradeId, perk.level);
    }
    for (const link of links.filter((candidate) => candidate.catalog === "Abil")) {
      if (!explicitAbilityLevels.has(link.objectId)) {
        explicitAbilityLevels.set(link.objectId, perk.level);
      }
      if (catalogObject(database, "Abil", link.objectId)?.class === "CAbilResearch"
        && Number.isInteger(Number(link.commandIndex))) {
        researchAbilityIds.add(link.objectId);
        const entry = readResearchEntry(database, link.objectId, Number(link.commandIndex) + 1);
        if (entry) linkedResearchEntries.push({ ...entry, level: perk.level, source: "level-perk" });
      }
    }
  }
  for (const upgradeId of [...defaultUpgrades, ...directUpgradeLevels.keys()]) {
    for (const effect of cachedUpgradeEffects(database, upgradeId)) {
      const reference = parseDataReference(effect.reference);
      if (reference?.catalog === "Abil" && /\.Upgrade$/i.test(reference.fieldPath)
        && catalogObject(database, "Abil", reference.objectId)?.class === "CAbilResearch") {
        researchAbilityIds.add(reference.objectId);
      }
    }
  }
  const sharedResearchUpgradeIds = new Set();
  const researchCandidates = new Map();
  for (const entry of linkedResearchEntries) {
    const requirementUpgrades = entry.requirementId
      ? requirementEvidence(database, entry.requirementId).upgrades
      : new Set();
    if (entry.requirementId && requirementUpgrades.size > 0
      && !requirementUpgrades.has(entry.upgradeId)) continue;
    researchCandidates.set(entry.upgradeId, entry);
  }
  for (const abilityId of researchAbilityIds) {
    for (const entry of allResearchEntries(database, abilityId)) {
      sharedResearchUpgradeIds.add(entry.upgradeId);
      if (entry.state?.toLowerCase() === "restricted" || researchCandidates.has(entry.upgradeId)) {
        continue;
      }
      const requirementUpgrades = entry.requirementId
        ? requirementEvidence(database, entry.requirementId).upgrades
        : new Set();
      if (entry.requirementId && requirementUpgrades.size > 0
        && !requirementUpgrades.has(entry.upgradeId)) continue;
      researchCandidates.set(entry.upgradeId, { ...entry, level: null, source: "baseline" });
    }
  }
  const context = {
    commanderId,
    profile,
    defaultUpgrades,
    directUpgradeLevels,
    explicitAbilityLevels,
    researchCandidates,
    sharedResearchUpgradeIds,
    currentGateTokens,
  };
  contexts.set(commanderId, context);
  return context;
}

function commanderOwnsUpgrade(database, commanderContext, upgradeId) {
  if (commanderContext.defaultUpgrades.includes(upgradeId)
    || commanderContext.directUpgradeLevels.has(upgradeId)
    || commanderContext.researchCandidates.get(upgradeId)?.source === "level-perk") return true;
  const current = database
    .prepare(`
      SELECT MIN(depth) AS depth
      FROM commander_membership
      WHERE commander_id=? AND catalog='Upgrade' AND object_id=?
    `)
    .get(commanderContext.commanderId, upgradeId)?.depth;
  if (current === 0) return true;
  const foreign = database
    .prepare(`
      SELECT 1
      FROM commander_membership
      WHERE commander_id<>? AND catalog='Upgrade' AND object_id=? AND depth=0
      LIMIT 1
    `)
    .get(commanderContext.commanderId, upgradeId);
  return !foreign && current === 0;
}

function upgradeHasExclusiveForeignOwner(database, commanderContext, upgradeId) {
  if (commanderContext.defaultUpgrades.includes(upgradeId)
    || commanderContext.directUpgradeLevels.has(upgradeId)
    || commanderContext.researchCandidates.get(upgradeId)?.source === "level-perk") return false;
  const current = database
    .prepare(`
      SELECT 1
      FROM commander_membership
      WHERE commander_id=? AND catalog='Upgrade' AND object_id=? AND depth=0
      LIMIT 1
    `)
    .get(commanderContext.commanderId, upgradeId);
  if (current) return false;
  return Boolean(database
    .prepare(`
      SELECT 1
      FROM commander_membership
      WHERE commander_id<>? AND catalog='Upgrade' AND object_id=? AND depth=0
      LIMIT 1
    `)
    .get(commanderContext.commanderId, upgradeId));
}

function commanderModifiesObject(database, commanderContext, catalog, objectId) {
  return [...commanderContext.defaultUpgrades, ...commanderContext.directUpgradeLevels.keys()]
    .some((upgradeId) => cachedUpgradeEffects(database, upgradeId).some((effect) => {
      const reference = parseDataReference(effect.reference);
      return reference?.catalog === catalog && reference.objectId === objectId;
    }));
}

function requirementAllowed(database, commanderContext, evidence) {
  if (!evidence || (evidence.upgrades.size === 0 && evidence.tokens.size === 0)) return false;
  if ([...evidence.upgrades].some((upgradeId) =>
    commanderOwnsUpgrade(database, commanderContext, upgradeId))) return true;
  return [...evidence.tokens].some((token) => commanderContext.currentGateTokens.has(token));
}

function weaponField(database, weaponId, fieldPath) {
  const direct = catalogField(database, "Weapon", weaponId, fieldPath);
  if (direct !== null) return direct;
  const className = catalogObject(database, "Weapon", weaponId)?.class;
  return (className ? catalogField(database, "Weapon", `@default:${className}`, fieldPath) : null)
    ?? catalogField(database, "Weapon", "@default:CWeapon", fieldPath);
}

function numericWeaponField(database, weaponId, fieldPath) {
  const raw = weaponField(database, weaponId, fieldPath);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function effectChildren(database, effectId) {
  return database
    .prepare(`
      SELECT field_path AS fieldPath, target_object_id AS targetId
      FROM object_references
      WHERE source_catalog='Effect' AND source_object_id=? AND target_catalog='Effect'
      ORDER BY field_path, target_object_id
    `)
    .all(effectId)
    .filter((reference) => reference.fieldPath !== "@parent"
      && /(effect|casedefault|impact|periodic|initial|final)/i.test(reference.fieldPath)
      && catalogObject(database, "Effect", reference.targetId));
}

function analyzeEffectGraph(database, roots) {
  const effectIds = new Set();
  const classes = new Set();
  const damageEffects = new Map();
  const pending = uniqueStrings(roots);
  while (pending.length > 0 && effectIds.size < 160) {
    const effectId = pending.shift();
    if (effectIds.has(effectId)) continue;
    const object = catalogObject(database, "Effect", effectId);
    if (!object) continue;
    effectIds.add(effectId);
    classes.add(object.class);
    if (object.class === "CEffectDamage") {
      const amount = numericCatalogField(database, "Effect", effectId, "Amount");
      if (amount !== null) {
        const bonuses = database
          .prepare(`
            SELECT path, value
            FROM catalog_fields
            WHERE catalog='Effect' AND object_id=?
              AND lower(path) LIKE 'attributebonus[%'
            ORDER BY path
          `)
          .all(effectId)
          .map((field) => {
            const attribute = /^AttributeBonus\[([^\]]+)\]$/i.exec(field.path)?.[1];
            const value = Number(field.value);
            return attribute && Number.isFinite(value) && value !== 0
              ? { attribute, value }
              : null;
          })
          .filter(Boolean);
        damageEffects.set(effectId, { id: effectId, amount, bonuses });
      }
    }
    for (const child of effectChildren(database, effectId)) pending.push(child.targetId);
  }
  return { effectIds, classes, damageEffects };
}

function targetTypes(targetFilters) {
  const [includedRaw = "", excludedRaw = ""] = (targetFilters ?? "").split(";", 2);
  const included = new Set(includedRaw.split(",").map((value) => value.trim().toLowerCase()));
  const excluded = new Set(excludedRaw.split(",").map((value) => value.trim().toLowerCase()));
  const hasExplicitPlane = included.has("ground") || included.has("air");
  const planes = hasExplicitPlane
    ? [included.has("ground") ? "ground" : null, included.has("air") ? "air" : null]
    : ["ground", "air"];
  return planes
    .filter((plane) => plane && !excluded.has(plane))
    .map((plane) => plane === "ground" ? "对地" : "对空");
}

function applyNumericOperation(current, operation, operand) {
  if (!Number.isFinite(current) || !Number.isFinite(operand)) return null;
  switch (operation.toLowerCase()) {
    case "add": return current + operand;
    case "subtract": return current - operand;
    case "multiply": return current * operand;
    case "divide": return operand === 0 ? null : current / operand;
    case "set": return operand;
    default: return null;
  }
}

function upgradeRoot(database, upgradeId) {
  let current = upgradeId;
  const seen = new Set();
  while (!seen.has(current)) {
    seen.add(current);
    const parent = catalogObject(database, "Upgrade", current)?.parentId;
    if (!parent || !catalogObject(database, "Upgrade", parent)) return current;
    current = parent;
  }
  return current;
}

function upgradeDamageOperation(database, upgradeId, damageEffectId) {
  const signatures = uniqueStrings(cachedUpgradeEffects(database, upgradeId)
    .filter((effect) => effect.reference === `Effect,${damageEffectId},Amount`)
    .map((effect) => {
      const value = Number(effect.value);
      return Number.isFinite(value) ? `${effect.operation}|${value}` : null;
    }));
  if (signatures.length !== 1) return null;
  const [operation, rawValue] = signatures[0].split("|");
  return { operation, value: Number(rawValue) };
}

function weaponUpgradeProgression(database, commanderContext, damageEffectId, baseDamage) {
  const incoming = database
    .prepare(`
      SELECT DISTINCT source_object_id AS upgradeId
      FROM object_references
      WHERE source_catalog='Upgrade' AND target_catalog='Effect' AND target_object_id=?
      ORDER BY source_object_id
    `)
    .all(damageEffectId)
    .map((row) => row.upgradeId)
    .filter((upgradeId) => upgradeDamageOperation(database, upgradeId, damageEffectId));
  const groups = new Map();
  for (const upgradeId of incoming) {
    const root = upgradeRoot(database, upgradeId);
    const items = groups.get(root) ?? [];
    items.push(upgradeId);
    groups.set(root, items);
  }
  const knownRoots = new Set([...commanderContext.sharedResearchUpgradeIds]
    .map((upgradeId) => upgradeRoot(database, upgradeId)));
  const candidates = [];
  for (const [root, upgradeIds] of groups) {
    const rootCategories = catalogField(database, "Upgrade", root, "EditorCategories") ?? "";
    if (!/UpgradeType:AttackBonus/i.test(rootCategories)
      && !upgradeIds.some((id) => /Weapons?(?:Level\d+)?$/i.test(id))) continue;
    let current = baseDamage;
    const progression = [current];
    let valid = true;
    for (let level = 1; level <= 3; level += 1) {
      const levelId = upgradeIds.find((id) => new RegExp(`Level0?${level}$`, "i").test(id));
      const operation = levelId
        ? upgradeDamageOperation(database, levelId, damageEffectId)
        : upgradeDamageOperation(database, root, damageEffectId);
      if (!operation) {
        valid = false;
        break;
      }
      current = applyNumericOperation(current, operation.operation, operation.value);
      if (current === null) {
        valid = false;
        break;
      }
      progression.push(current);
    }
    if (valid) {
      candidates.push({
        root,
        score: (knownRoots.has(root) ? 100 : 0)
          + (commanderContext.directUpgradeLevels.has(root) ? 10 : 0),
        progression,
      });
    }
  }
  candidates.sort((left, right) => right.score - left.score || naturalCompare(left.root, right.root));
  if (!candidates[0] || candidates[0].score === 0 && candidates.length > 1) return null;
  return candidates[0].progression
    .map((value, level) => `${level}级 ${formatNumber(value)}`)
    .join(" / ");
}

function defaultWeaponState(database, commanderContext, weaponId) {
  let disabled = numericWeaponField(database, weaponId, "Options[Disabled]") ?? 0;
  let explicitEnable = false;
  for (const upgradeId of commanderContext.defaultUpgrades) {
    for (const effect of cachedUpgradeEffects(database, upgradeId)) {
      if (effect.reference !== `Weapon,${weaponId},Options[Disabled]`) continue;
      const operand = Number(effect.value);
      const next = applyNumericOperation(disabled, effect.operation, operand);
      if (next !== null) disabled = next;
      if (effect.operation.toLowerCase() === "set" && operand === 0) explicitEnable = true;
    }
  }
  return { disabled: disabled !== 0, explicitEnable };
}

function analyzeWeapon(database, commanderContext, weaponId, formId) {
  const state = defaultWeaponState(database, commanderContext, weaponId);
  if (state.disabled) return null;
  let resolvedWeaponId = weaponId;
  let displayEffectId = weaponField(database, resolvedWeaponId, "DisplayEffect");
  let rootEffectId = weaponField(database, resolvedWeaponId, "Effect")
    ?.replaceAll("##id##", resolvedWeaponId);
  let graph = analyzeEffectGraph(database, [rootEffectId, displayEffectId]);
  if (graph.damageEffects.size === 0 && /LookAt$/i.test(resolvedWeaponId)) {
    const fallbackId = resolvedWeaponId.replace(/LookAt$/i, "");
    if (catalogObject(database, "Weapon", fallbackId)) {
      resolvedWeaponId = fallbackId;
      displayEffectId = weaponField(database, resolvedWeaponId, "DisplayEffect");
      rootEffectId = weaponField(database, resolvedWeaponId, "Effect")
        ?.replaceAll("##id##", resolvedWeaponId);
      graph = analyzeEffectGraph(database, [rootEffectId, displayEffectId]);
    }
  }
  const displayDamage = graph.damageEffects.get(displayEffectId);
  const graphHasConditionalDamage = graph.classes.has("CEffectSwitch");
  const damageItems = displayDamage && !graphHasConditionalDamage
    ? [displayDamage]
    : [...graph.damageEffects.values()];
  const damageValues = uniqueStrings(damageItems.map((damage) => formatNumber(damage.amount)));
  const period = numericWeaponField(database, resolvedWeaponId, "Period");
  const range = numericWeaponField(database, resolvedWeaponId, "Range");
  const damagePoint = numericWeaponField(database, resolvedWeaponId, "DamagePoint");
  const targets = targetTypes(weaponField(database, resolvedWeaponId, "TargetFilters"));
  const safeDps = damageValues.length === 1
    && period !== null && period !== 0
    && !graph.classes.has("CEffectPersistent")
    && !graph.classes.has("CEffectSwitch")
    ? Number(damageValues[0]) / period
    : null;
  const facts = [
    damageValues.length > 0 ? { label: "基础伤害", value: damageValues.join(" / ") } : null,
    period === null ? null : { label: "攻击间隔", value: `${formatNumber(period)} 秒` },
    range === null ? null : { label: "攻击范围", value: formatNumber(range) },
    targets.length === 0 ? null : { label: "可攻击目标", value: targets.join("、") },
    damagePoint === null ? null : { label: "攻击前摇", value: `${formatNumber(damagePoint)} 秒` },
    safeDps === null ? null : { label: "基础DPS", value: formatNumber(safeDps) },
  ];
  const bonuses = new Map();
  for (const damage of damageItems) {
    for (const bonus of damage.bonuses) {
      const values = bonuses.get(bonus.attribute) ?? new Set();
      values.add(formatNumber(bonus.value));
      bonuses.set(bonus.attribute, values);
    }
  }
  const attributeNames = { Armored: "重甲", Light: "轻甲", Massive: "巨型", Mechanical: "机械" };
  for (const [attribute, values] of bonuses) {
    facts.push({
      label: `对${attributeNames[attribute] ?? attribute}加成`,
      value: [...values].join(" / "),
    });
  }
  if (damageItems.length === 1) {
    const progression = weaponUpgradeProgression(
      database,
      commanderContext,
      damageItems[0].id,
      damageItems[0].amount,
    );
    if (progression) facts.push({ label: "武器升级", value: progression });
  }
  const name = localizedCatalogField(
    database,
    "Weapon",
    resolvedWeaponId,
    "Name",
    `Weapon/Name/${resolvedWeaponId}`,
  ) ?? resolvedWeaponId;
  return {
    ids: uniqueStrings([weaponId, resolvedWeaponId]),
    nameZhCN: name,
    descriptionZhCN: "该单位命令卡所使用的武器。",
    facts: facts.filter(Boolean),
    internal: {
      formId,
      effectIds: graph.effectIds,
      damageValues,
      period,
      range,
      targets,
      explicitEnable: state.explicitEnable,
    },
  };
}

function buildWeapons(database, commanderContext, forms) {
  const candidates = [];
  for (const formId of forms) {
    for (const weaponId of arrayLinks(database, "Unit", formId, "WeaponArray")) {
      const candidate = analyzeWeapon(database, commanderContext, weaponId, formId);
      if (candidate) candidates.push(candidate);
    }
  }
  const deduplicated = new Map();
  for (const candidate of candidates) {
    const signature = [
      [...candidate.internal.damageValues].sort(naturalCompare).join(","),
      candidate.internal.period ?? "",
      candidate.internal.range ?? "",
      candidate.internal.targets.join(","),
    ].join("|");
    const previous = deduplicated.get(signature);
    if (!previous) {
      deduplicated.set(signature, candidate);
      continue;
    }
    const preferred = candidate.internal.explicitEnable && !previous.internal.explicitEnable
      ? candidate
      : previous;
    preferred.ids = preferred === candidate
      ? uniqueStrings([...candidate.ids, ...previous.ids])
      : uniqueStrings([...previous.ids, ...candidate.ids]);
    preferred.internal.effectIds = new Set([
      ...previous.internal.effectIds,
      ...candidate.internal.effectIds,
    ]);
    deduplicated.set(signature, preferred);
  }
  return [...deduplicated.values()].map(({ internal, ...item }) => item);
}

function isSharedStatUpgrade(database, upgradeId) {
  const categories = catalogField(database, "Upgrade", upgradeId, "EditorCategories") ?? "";
  const leaderAlias = catalogField(database, "Upgrade", upgradeId, "LeaderAlias") ?? "";
  return /UpgradeType:(?:AttackBonus|ArmorBonus)/i.test(categories) || /^Tech/i.test(leaderAlias);
}

function abilityCommandState(database, abilityId, command) {
  return firstCatalogField(database, "Abil", abilityId, [
    `CmdButtonArray[${command}].@State`,
    `CmdButtonArray[${command}].State`,
  ]);
}

function abilityCommandRequirement(database, abilityId, command) {
  return firstCatalogField(database, "Abil", abilityId, [
    `CmdButtonArray[${command}].@Requirements`,
    `CmdButtonArray[${command}].Requirements`,
  ]);
}

function researchFacts(entry) {
  if (!entry) return [];
  return [
    entry.minerals === null && entry.vespene === null ? null : {
      label: "研究费用",
      value: `${formatNumber(entry.minerals ?? 0)} 矿 / ${formatNumber(entry.vespene ?? 0)} 气`,
    },
    entry.time === null ? null : { label: "研究时间", value: `${formatNumber(entry.time)} 秒` },
  ].filter(Boolean);
}

function buildSkills(database, commanderContext, forms) {
  const formAbilities = new Set(forms.flatMap((formId) =>
    arrayLinks(database, "Unit", formId, "AbilArray")));
  const skills = [];
  for (const button of unitCardButtons(database, forms)) {
    const face = button.face ?? "";
    if (!face || BASIC_BUTTON_FACES.has(face.toLowerCase()) || /Locked$/i.test(face)) continue;
    const type = (button.type ?? "").toLowerCase();
    const cardRequirement = button.requirementId
      ? requirementEvidence(database, button.requirementId)
      : null;
    if (type === "passive" || /^255(?:,255|,0)?$/.test(button.abilityCommand ?? "")) {
      const researchEntry = cardRequirement
        ? [...cardRequirement.upgrades]
          .map((upgradeId) => commanderContext.researchCandidates.get(upgradeId))
          .find((entry) => entry && !isSharedStatUpgrade(database, entry.upgradeId))
        : null;
      if (researchEntry?.source === "baseline"
        && upgradeHasExclusiveForeignOwner(
          database,
          commanderContext,
          researchEntry.upgradeId,
        )) continue;
      if (!researchEntry && !requirementAllowed(database, commanderContext, cardRequirement)) {
        continue;
      }
      const detail = localizedButton(database, face);
      const researchDetail = researchEntry?.buttonId
        ? localizedButton(database, researchEntry.buttonId)
        : null;
      const relevantUpgrades = cardRequirement
        ? [...cardRequirement.upgrades].filter((upgradeId) =>
          researchEntry?.upgradeId === upgradeId
          || commanderOwnsUpgrade(database, commanderContext, upgradeId))
        : [];
      skills.push({
        ids: uniqueStrings([
          face,
          researchEntry?.buttonId,
          researchEntry?.abilityId,
          researchEntry?.upgradeId,
          ...relevantUpgrades,
        ]),
        nameZhCN: detail.name === face && researchDetail ? researchDetail.name : detail.name,
        descriptionZhCN: detail.description === "暂无官方说明。" && researchDetail
          ? researchDetail.description
          : detail.description,
        ...(researchEntry?.level ? { level: researchEntry.level } : {}),
        facts: researchFacts(researchEntry),
        internal: {
          order: [button.formIndex, button.row, button.column],
          dedupeKey: `passive:${researchEntry?.upgradeId ?? face}`,
        },
      });
      continue;
    }
    if (type !== "abilcmd" || !button.abilityCommand) continue;
    const [abilityId, command = "Execute"] = button.abilityCommand.split(",");
    if (!abilityId || BASIC_ABILITY_IDS.has(abilityId.toLowerCase())
      || !formAbilities.has(abilityId)) continue;
    const ability = catalogObject(database, "Abil", abilityId);
    if (!ability || ability.class === "CAbilQueue") continue;
    const commandRequirementId = abilityCommandRequirement(database, abilityId, command);
    const commandEvidence = commandRequirementId
      ? requirementEvidence(database, commandRequirementId)
      : cardRequirement;
    const restricted = abilityCommandState(database, abilityId, command)?.toLowerCase() === "restricted";
    if (restricted
      && !commanderContext.explicitAbilityLevels.has(abilityId)
      && !requirementAllowed(database, commanderContext, commandEvidence)
      && !commanderModifiesObject(database, commanderContext, "Abil", abilityId)) continue;
    const detail = localizedButton(database, face);
    const level = commanderContext.explicitAbilityLevels.get(abilityId)
      ?? (commandEvidence
        && !/^Not/i.test(commandRequirementId ?? "")
        ? [...commandEvidence.upgrades]
          .map((upgradeId) => commanderContext.directUpgradeLevels.get(upgradeId)
            ?? commanderContext.researchCandidates.get(upgradeId)?.level)
          .find(Boolean)
        : null);
    skills.push({
      ids: uniqueStrings([abilityId, face]),
      nameZhCN: detail.name,
      descriptionZhCN: detail.description,
      ...(level ? { level } : {}),
      facts: [],
      internal: {
        order: [button.formIndex, button.row, button.column],
        dedupeKey: `ability:${abilityId}`,
      },
    });
  }
  const deduplicated = new Map();
  for (const skill of skills) {
    const key = skill.internal.dedupeKey;
    const previous = deduplicated.get(key);
    if (!previous) {
      deduplicated.set(key, skill);
      continue;
    }
    previous.ids = uniqueStrings([...previous.ids, ...skill.ids]);
    if (previous.descriptionZhCN === "暂无官方说明。"
      && skill.descriptionZhCN !== "暂无官方说明。") {
      previous.descriptionZhCN = skill.descriptionZhCN;
    }
    previous.facts = previous.facts.length > 0 ? previous.facts : skill.facts;
  }
  return [...deduplicated.values()]
    .sort((left, right) =>
      left.internal.order[0] - right.internal.order[0]
      || left.internal.order[1] - right.internal.order[1]
      || left.internal.order[2] - right.internal.order[2]
      || naturalCompare(left.nameZhCN, right.nameZhCN))
    .map(({ internal, ...item }) => item);
}

function productionContext(database, forms) {
  const slots = new Map();
  for (const formId of forms) {
    const rows = database
      .prepare(`
        SELECT source_object_id AS abilityId, field_path AS fieldPath
        FROM object_references
        WHERE source_catalog='Abil' AND target_catalog='Unit' AND target_object_id=?
          AND (lower(field_path) LIKE 'infoarray%.unit'
            OR lower(field_path) LIKE 'infoarray%.@unit')
        ORDER BY source_object_id, field_path
      `)
      .all(formId);
    for (const row of rows) {
      const prefixes = slots.get(row.abilityId) ?? new Set();
      prefixes.add(row.fieldPath.replace(/\.@?Unit$/i, ""));
      slots.set(row.abilityId, prefixes);
    }
  }
  return slots;
}

function buildComponentContext(database, forms, weapons, skills) {
  const objects = new Map([
    ["Unit", new Set(forms)],
    ["Weapon", new Set(weapons.flatMap((weapon) => weapon.ids))],
    ["Abil", new Set(skills.flatMap((skill) =>
      skill.ids.filter((id) => catalogObject(database, "Abil", id))))],
    ["Effect", new Set()],
    ["Behavior", new Set()],
  ]);
  for (const formId of forms) {
    for (const abilityId of arrayLinks(database, "Unit", formId, "AbilArray")) {
      if (catalogObject(database, "Abil", abilityId)) objects.get("Abil").add(abilityId);
    }
  }
  const pending = [];
  for (const abilityId of objects.get("Abil")) pending.push(["Abil", abilityId]);
  for (const weaponId of objects.get("Weapon")) pending.push(["Weapon", weaponId]);
  const seen = new Set();
  while (pending.length > 0 && seen.size < 512) {
    const [catalog, objectId] = pending.shift();
    const key = `${catalog}/${objectId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const references = database
      .prepare(`
        SELECT target_catalog AS targetCatalog, target_object_id AS targetObjectId
        FROM object_references
        WHERE source_catalog=? AND source_object_id=?
          AND target_catalog IN ('Effect', 'Behavior')
        ORDER BY field_path, target_catalog, target_object_id
      `)
      .all(catalog, objectId);
    for (const reference of references) {
      if (!catalogObject(database, reference.targetCatalog, reference.targetObjectId)) continue;
      objects.get(reference.targetCatalog).add(reference.targetObjectId);
      pending.push([reference.targetCatalog, reference.targetObjectId]);
    }
    if (catalog === "Abil") {
      for (const fallbackCatalog of ["Effect", "Behavior"]) {
        if (catalogObject(database, fallbackCatalog, objectId)) {
          objects.get(fallbackCatalog).add(objectId);
          pending.push([fallbackCatalog, objectId]);
        }
      }
    }
  }
  return { objects, productionSlots: productionContext(database, forms) };
}

function upgradeTouchesContext(database, upgradeId, componentContext, requirementUpgrades, seen = new Set()) {
  if (seen.has(upgradeId)) return false;
  seen.add(upgradeId);
  if (requirementUpgrades.has(upgradeId)) return true;
  const affectedUnits = database
    .prepare(`
      SELECT value
      FROM catalog_fields
      WHERE catalog='Upgrade' AND object_id=?
        AND lower(path) LIKE 'affectedunitarray%'
      ORDER BY path
    `)
    .all(upgradeId)
    .map((field) => field.value);
  if (affectedUnits.some((unitId) => componentContext.objects.get("Unit").has(unitId))) return true;
  for (const effect of cachedUpgradeEffects(database, upgradeId)) {
    const reference = parseDataReference(effect.reference);
    if (!reference) continue;
    if (componentContext.objects.get(reference.catalog)?.has(reference.objectId)) return true;
    if (reference.catalog === "Abil" && componentContext.productionSlots.has(reference.objectId)) {
      const prefixes = componentContext.productionSlots.get(reference.objectId);
      if ([...prefixes].some((prefix) =>
        reference.fieldPath.toLowerCase().startsWith(prefix.toLowerCase()))) return true;
    }
    if (reference.catalog === "Abil" && /\.Upgrade$/i.test(reference.fieldPath)
      && effect.value && catalogObject(database, "Upgrade", effect.value)
      && upgradeTouchesContext(
        database,
        effect.value,
        componentContext,
        requirementUpgrades,
        seen,
      )) return true;
  }
  return false;
}

function armyCategoryMatches(database, armyCategoryId, forms) {
  const unitId = catalogField(database, "ArmyCategory", armyCategoryId, "Unit");
  return unitId ? forms.includes(unitId) : forms.includes(armyCategoryId);
}

function perkDisplay(database, perk) {
  const buttonId = (perk.links ?? [])
    .find((link) => link.catalog === "Button")?.objectId ?? perk.id;
  const button = localizedButton(database, buttonId);
  return {
    buttonId,
    name: primaryLocalizedText(perk.nameZhCN) ?? button.name ?? perk.id,
    description: button.description,
  };
}

function buildCommanderUpgrades(
  database,
  commanderContext,
  forms,
  componentContext,
  requirementUpgrades,
) {
  const items = [];
  for (const perk of commanderContext.profile.levelPerks ?? []) {
    const links = perk.links ?? [];
    const upgradeIds = links
      .filter((link) => link.catalog === "Upgrade")
      .map((link) => link.objectId);
    if (catalogObject(database, "Upgrade", perk.id)) upgradeIds.push(perk.id);
    const relevantIds = uniqueStrings(upgradeIds.filter((upgradeId) =>
      upgradeTouchesContext(
        database,
        upgradeId,
        componentContext,
        requirementUpgrades,
      )));
    const armyCategories = links
      .filter((link) => link.catalog === "ArmyCategory")
      .map((link) => link.objectId)
      .filter((categoryId) => armyCategoryMatches(database, categoryId, forms));
    if (perk.level === 1) {
      for (const defaultUpgrade of commanderContext.defaultUpgrades) {
        if (upgradeTouchesContext(
          database,
          defaultUpgrade,
          componentContext,
          requirementUpgrades,
        )) relevantIds.push(defaultUpgrade);
      }
    }
    const evidenceIds = uniqueStrings([...relevantIds, ...armyCategories]);
    if (evidenceIds.length === 0) continue;
    const display = perkDisplay(database, perk);
    items.push({
      ids: uniqueStrings([perk.id, display.buttonId, ...evidenceIds]),
      nameZhCN: display.name,
      descriptionZhCN: display.description,
      level: perk.level,
    });
  }
  return items.sort((left, right) =>
    (left.level ?? 0) - (right.level ?? 0)
    || naturalCompare(left.nameZhCN, right.nameZhCN));
}

function rosterUnitId(database, unit) {
  if (catalogObject(database, "Unit", unit.unitId)) return unit.unitId;
  for (const categoryId of uniqueStrings([unit.unitId, unit.techId])) {
    const mappedUnitId = catalogField(database, "ArmyCategory", categoryId, "Unit");
    if (mappedUnitId && catalogObject(database, "Unit", mappedUnitId)) {
      return mappedUnitId;
    }
  }
  return unit.unitId;
}

function unitBuildTime(database, commanderId, unitId) {
  const productionCommands = database
    .prepare(`
      SELECT reference.source_object_id AS abilityId,
             reference.field_path AS fieldPath,
             MIN(membership.depth) AS commanderDepth
      FROM object_references reference
      LEFT JOIN commander_membership membership
        ON membership.commander_id=?
       AND membership.catalog='Abil'
       AND membership.object_id=reference.source_object_id
      WHERE reference.source_catalog='Abil'
        AND reference.target_catalog='Unit'
        AND reference.target_object_id=?
        AND (lower(reference.field_path) LIKE 'infoarray%.unit'
          OR lower(reference.field_path) LIKE 'infoarray%.@unit')
      GROUP BY reference.source_object_id, reference.field_path
      ORDER BY (MIN(membership.depth) IS NULL), MIN(membership.depth),
               reference.source_object_id, reference.field_path
    `)
    .all(commanderId, unitId);
  for (const command of productionCommands) {
    const prefix = command.fieldPath.replace(/\.@?Unit$/i, "");
    const rawValue = catalogField(database, "Abil", command.abilityId, `${prefix}.@Time`)
      ?? catalogField(database, "Abil", command.abilityId, `${prefix}.Time`);
    if (rawValue === null) continue;
    const value = Number(rawValue);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Canonical basic-stat projection shared by the UI bridge and Agent search.
 * Values are effective Catalog values from the same local co-op database.
 */
export function buildUnitStats(database, { commanderId, unit }) {
  const unitId = rosterUnitId(database, unit);
  const rawFood = numericCatalogField(database, "Unit", unitId, "Food");
  const attributes = database
    .prepare(`
      SELECT path
      FROM catalog_fields
      WHERE catalog='Unit' AND object_id=?
        AND lower(path) LIKE 'attributes[%'
        AND value NOT IN ('0', 'false')
      ORDER BY path
    `)
    .all(unitId)
    .map((field) => /^Attributes\[([^\]]+)\]$/i.exec(field.path)?.[1] ?? null)
    .filter(Boolean);
  return {
    unitId,
    lifeMax: numericCatalogField(database, "Unit", unitId, "LifeMax"),
    shieldMax: numericCatalogField(database, "Unit", unitId, "ShieldsMax"),
    lifeArmor: numericCatalogField(database, "Unit", unitId, "LifeArmor") ?? 0,
    mineralCost: numericCatalogField(database, "Unit", unitId, "CostResource[Minerals]"),
    vespeneCost: numericCatalogField(database, "Unit", unitId, "CostResource[Vespene]"),
    supplyCost: rawFood === null ? null : Math.abs(rawFood),
    movementSpeed: numericCatalogField(database, "Unit", unitId, "Speed"),
    sight: numericCatalogField(database, "Unit", unitId, "Sight"),
    cargoSize: numericCatalogField(database, "Unit", unitId, "CargoSize"),
    attributes,
    buildTime: unitBuildTime(database, commanderId, unitId),
  };
}

/**
 * Shared commander-roster unit contract. Presentation layers may append icon
 * URLs, but must not reimplement stats, weapons, skills, or upgrade filtering.
 */
export function buildUnitProjection(
  database,
  { commanderId, unit, includeDetails = true },
) {
  const stats = buildUnitStats(database, { commanderId, unit });
  return {
    ...unit,
    stats,
    ...(includeDetails
      ? { details: buildUnitDetails(database, { commanderId, unitId: stats.unitId }) }
      : {}),
  };
}

/**
 * Build the database-backed detail payload consumed by the commander UI.
 * The resolver is deliberately conservative: cards that only have a weak
 * merged-catalog reference, without commander/profile evidence, are omitted.
 */
export function buildUnitDetails(database, { commanderId, unitId }) {
  const commanderContext = buildCommanderContext(database, commanderId);
  const forms = collectUnitForms(database, commanderContext, unitId);
  const weapons = buildWeapons(database, commanderContext, forms);
  const skills = buildSkills(database, commanderContext, forms);
  const acceptedRequirementUpgrades = new Set();
  for (const button of unitCardButtons(database, forms)) {
    if (!button.requirementId) continue;
    const evidence = requirementEvidence(database, button.requirementId);
    if (requirementAllowed(database, commanderContext, evidence)) {
      for (const upgradeId of evidence.upgrades) acceptedRequirementUpgrades.add(upgradeId);
    }
  }
  const componentContext = buildComponentContext(database, forms, weapons, skills);
  const commanderUpgrades = buildCommanderUpgrades(
    database,
    commanderContext,
    forms,
    componentContext,
    acceptedRequirementUpgrades,
  );
  const activeUpgradeIds = uniqueStrings([
    ...commanderContext.defaultUpgrades,
    ...[...commanderContext.directUpgradeLevels.entries()]
      .sort((left, right) => (left[1] ?? 0) - (right[1] ?? 0)
        || naturalCompare(left[0], right[0]))
      .map(([upgradeId]) => upgradeId),
  ]);
  const resolveDescriptions = (items) => items.map((item) => ({
    ...item,
    descriptionZhCN: resolveSc2DataReferences(database, item.descriptionZhCN, {
      upgradeIds: activeUpgradeIds,
    }),
  }));
  return {
    weapons: resolveDescriptions(weapons),
    skills: resolveDescriptions(skills),
    commanderUpgrades: resolveDescriptions(commanderUpgrades),
  };
}
