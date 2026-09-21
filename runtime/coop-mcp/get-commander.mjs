#!/usr/bin/env node

import { createReadStream, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { createGunzip } from "node:zlib";
import { DOMParser } from "@xmldom/xmldom";

import { createCoopSearch } from "./lib/coop-search.mjs";
import { buildUnitProjection } from "./lib/unit-details.mjs";

const [commanderId] = process.argv.slice(2);

if (!commanderId || !/^[A-Za-z0-9_-]{1,80}$/.test(commanderId)) {
  console.error("A valid commander ID is required.");
  process.exit(2);
}

async function resolveCascPaths(build, assets) {
  const indexPath = path.join(
    process.env.LOCALAPPDATA ??
      process.env.XDG_DATA_HOME ??
      (process.platform === "win32"
        ? path.join(os.homedir(), "AppData", "Local")
        : path.join(os.homedir(), ".local", "share")),
    "CoopAgent",
    "casc",
    build,
    "known-files.tsv.gz",
  );
  const wanted = new Map();
  const expectedAssets = new Set(assets).size;
  for (const asset of assets) {
    const suffix = `\\base.sc2assets\\${asset.toLowerCase().replaceAll("/", "\\")}`;
    const variants = wanted.get(suffix) ?? [];
    variants.push(asset);
    wanted.set(suffix, variants);
  }
  const resolved = new Map();
  const lines = readline.createInterface({
    input: createReadStream(indexPath).pipe(createGunzip()),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    const [logicalPath, , available] = line.split("\t");
    if (available !== "1") continue;
    const normalized = logicalPath.toLowerCase().replaceAll("/", "\\");
    for (const [suffix, variants] of wanted) {
      if (normalized.endsWith(suffix)) {
        for (const asset of variants) resolved.set(asset, logicalPath);
      }
    }
    if (resolved.size === expectedAssets) break;
  }
  return resolved;
}

function localizedText(database, locale, textKey) {
  if (!textKey) return null;
  return database
    .prepare("SELECT value FROM localized_text WHERE locale=? AND text_key=?")
    .get(locale, textKey)?.value ?? null;
}

function attribute(element, name) {
  for (let index = 0; index < element.attributes.length; index += 1) {
    const candidate = element.attributes.item(index);
    if (candidate.name.toLowerCase() === name.toLowerCase()) return candidate.value;
  }
  return null;
}

function elementChildren(element) {
  const result = [];
  for (let child = element.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) result.push(child);
  }
  return result;
}

function firstFieldValue(instance, fieldId) {
  const pending = [instance];
  while (pending.length > 0) {
    const candidate = pending.pop();
    const field = elementChildren(candidate).find(
      (child) => child.tagName === "Field" && attribute(child, "Id") === fieldId,
    );
    if (field) {
      for (let index = 0; index < candidate.attributes.length; index += 1) {
        const value = candidate.attributes.item(index);
        if (!["id", "index"].includes(value.name.toLowerCase())) return value.value;
      }
    }
    pending.push(...elementChildren(candidate));
  }
  return null;
}

function masteryPointIncrements(databaseFile, masteries) {
  const userDataPath = path.join(
    path.dirname(databaseFile),
    "merged",
    "GameData",
    "UserData.xml",
  );
  const document = new DOMParser().parseFromString(readFileSync(userDataPath, "utf8"), "text/xml");
  const wanted = new Set(masteries.map((mastery) => mastery.id));
  const increments = new Map();
  for (const instance of Array.from(document.getElementsByTagName("Instances"))) {
    const id = attribute(instance, "Id");
    if (!wanted.has(id)) continue;
    const rawValue = firstFieldValue(instance, "PointIncrement");
    const value = rawValue === null ? null : Number(rawValue);
    increments.set(id, Number.isFinite(value) ? value : null);
  }
  return increments;
}

function catalogField(database, catalog, objectId, fieldPath) {
  if (!objectId) return null;
  return database
    .prepare(`
      SELECT value
      FROM catalog_fields
      WHERE catalog=? AND object_id=? AND lower(path)=?
    `)
    .get(catalog, objectId, fieldPath.toLowerCase())?.value ?? null;
}

function catalogIcon(database, catalog, objectId) {
  return catalogField(database, catalog, objectId, "icon");
}

function primaryText(value) {
  return value?.split(" /// ")[0]?.trim() || null;
}

function localizedObjectName(database, catalog, objectId) {
  const key = catalogField(database, catalog, objectId, "Name")
    ?? `${catalog}/Name/${objectId}`;
  return primaryText(localizedText(database, "zhcn", key.replaceAll("##id##", objectId)))
    ?? primaryText(localizedText(database, "enus", key.replaceAll("##id##", objectId)))
    ?? null;
}

function localizedButtonDetail(database, buttonId) {
  const nameKey = (catalogField(database, "Button", buttonId, "Name")
    ?? `Button/Name/${buttonId}`).replaceAll("##id##", buttonId);
  const tooltipKey = (catalogField(database, "Button", buttonId, "Tooltip")
    ?? `Button/Tooltip/${buttonId}`).replaceAll("##id##", buttonId);
  return {
    name: primaryText(localizedText(database, "zhcn", nameKey))
      ?? primaryText(localizedText(database, "enus", nameKey))
      ?? buttonId,
    description: primaryText(localizedText(database, "zhcn", tooltipKey))
      ?? primaryText(localizedText(database, "enus", tooltipKey))
      ?? "数据库记录了该关联效果，但没有单独的文本说明。",
  };
}

function researchEntry(database, abilityId, researchIndex) {
  const prefix = `InfoArray[Research${researchIndex}]`;
  const upgradeId = catalogField(database, "Abil", abilityId, `${prefix}.@Upgrade`)
    ?? catalogField(database, "Abil", abilityId, `${prefix}.Upgrade`);
  if (!upgradeId) return null;
  const buttonId = catalogField(database, "Abil", abilityId, `${prefix}.Button.@DefaultButtonFace`)
    ?? catalogField(database, "Abil", abilityId, `${prefix}.Button.DefaultButtonFace`);
  const numeric = (path) => {
    const raw = catalogField(database, "Abil", abilityId, path);
    return raw !== null && Number.isFinite(Number(raw)) ? Number(raw) : null;
  };
  return {
    abilityId,
    upgradeId,
    buttonId,
    minerals: numeric(`${prefix}.Resource[Minerals]`),
    vespene: numeric(`${prefix}.Resource[Vespene]`),
    time: numeric(`${prefix}.@Time`) ?? numeric(`${prefix}.Time`),
  };
}

function researchEffect(database, entry) {
  const detail = entry.buttonId
    ? localizedButtonDetail(database, entry.buttonId)
    : { name: entry.upgradeId, description: "解锁一项可研究的升级。" };
  const facts = [];
  if (entry.minerals !== null || entry.vespene !== null) {
    facts.push({
      label: "研究费用",
      value: `${entry.minerals ?? 0} 矿 / ${entry.vespene ?? 0} 气`,
    });
  }
  if (entry.time !== null) facts.push({ label: "研究时间", value: `${entry.time} 秒` });
  return {
    ids: [...new Set([entry.abilityId, entry.buttonId, entry.upgradeId].filter(Boolean))],
    nameZhCN: detail.name,
    descriptionZhCN: detail.description,
    facts,
  };
}

const EFFECT_FIELD_NAMES = new Map([
  ["lifemax", "生命值上限"],
  ["lifearmor", "护甲"],
  ["range", "射程"],
  ["period", "攻击间隔"],
  ["amount", "数值"],
  ["speed", "移动速度"],
  ["timescale", "时间倍率"],
  ["costresource[minerals]", "矿物费用"],
  ["costresource[vespene]", "瓦斯费用"],
  ["costtime", "生产时间"],
  ["cost[0].vital[life]", "生命消耗"],
  ["modification.attackspeedmultiplier", "攻击速度倍率"],
  ["ratemultiplier", "攻击速度倍率"],
  ["upgrade", "关联研究"],
  ["tooltip", "说明文本"],
]);

function upgradeEffectFacts(database, upgradeId) {
  const rows = database.prepare(`
    SELECT path, value
    FROM catalog_fields
    WHERE catalog='Upgrade' AND object_id=?
      AND lower(path) LIKE 'effectarray%.@reference'
    ORDER BY path
  `).all(upgradeId);
  return rows.slice(0, 6).map((row) => {
    const basePath = row.path.replace(/\.@Reference$/i, "");
    const operation = catalogField(database, "Upgrade", upgradeId, `${basePath}.@Operation`) ?? "Add";
    const value = catalogField(database, "Upgrade", upgradeId, basePath) ?? "—";
    const [catalog, objectId, ...fieldParts] = row.value.split(",");
    const fieldPath = fieldParts.join(",");
    const fieldKey = [...EFFECT_FIELD_NAMES.keys()].find((key) => fieldPath.toLowerCase().endsWith(key));
    const targetName = localizedObjectName(database, catalog, objectId) ?? objectId;
    const operationName = { add: "增加", set: "设为", multiply: "乘以", subtract: "减少" }[operation.toLowerCase()]
      ?? operation;
    return {
      label: `${targetName} · ${fieldKey ? EFFECT_FIELD_NAMES.get(fieldKey) : fieldPath}`,
      value: `${operationName} ${value}`,
    };
  });
}

function incomingResearchEntry(database, upgradeId) {
  const row = database.prepare(`
    SELECT source_object_id AS abilityId, field_path AS fieldPath
    FROM object_references
    WHERE source_catalog='Abil' AND target_catalog='Upgrade' AND target_object_id=?
      AND (lower(field_path) LIKE 'infoarray[research%].@upgrade'
        OR lower(field_path) LIKE 'infoarray[research%].upgrade')
    ORDER BY source_object_id, field_path
    LIMIT 1
  `).get(upgradeId);
  const index = row ? /^InfoArray\[Research(\d+)\]/i.exec(row.fieldPath)?.[1] : null;
  return index ? researchEntry(database, row.abilityId, Number(index)) : null;
}

function levelPerkRelatedEffects(database, profilePerk) {
  const effects = [];
  const representedUpgrades = new Set();
  for (const link of profilePerk?.links ?? []) {
    if (link.catalog === "Button") continue;
    if (link.catalog === "Abil" && link.commandIndex !== null) {
      const entry = researchEntry(database, link.objectId, Number(link.commandIndex) + 1);
      if (entry) {
        representedUpgrades.add(entry.upgradeId);
        effects.push(researchEffect(database, entry));
        continue;
      }
      const face = catalogField(database, "Abil", link.objectId, "CmdButtonArray[Execute].@DefaultButtonFace")
        ?? link.objectId;
      const detail = localizedButtonDetail(database, face);
      effects.push({
        ids: [link.objectId, face].filter((id, index, all) => all.indexOf(id) === index),
        nameZhCN: detail.name,
        descriptionZhCN: detail.description,
      });
      continue;
    }
    if (link.catalog === "ArmyCategory") {
      const unitId = catalogField(database, "ArmyCategory", link.objectId, "Unit") ?? link.objectId;
      const unitName = localizedObjectName(database, "Unit", unitId) ?? unitId;
      effects.push({
        ids: [link.objectId, unitId].filter((id, index, all) => all.indexOf(id) === index),
        nameZhCN: `解锁单位：${unitName}`,
        descriptionZhCN: "达到该指挥官等级后，这个单位会加入可用阵容。",
      });
      continue;
    }
    if (link.catalog === "Upgrade" && !representedUpgrades.has(link.objectId)) {
      const research = incomingResearchEntry(database, link.objectId);
      if (research) {
        representedUpgrades.add(link.objectId);
        effects.push(researchEffect(database, research));
        continue;
      }
      const facts = upgradeEffectFacts(database, link.objectId);
      const localizedName = localizedObjectName(database, "Upgrade", link.objectId);
      const firstTarget = facts[0]?.label.split(" · ")[0];
      effects.push({
        ids: [link.objectId],
        nameZhCN: localizedName && /[\u3400-\u9fff]/.test(localizedName)
          ? localizedName
          : firstTarget ? `${firstTarget}相关强化` : "等级关联强化",
        descriptionZhCN: facts.length
          ? "该等级直接应用以下数据库变更。"
          : "该等级会启用一项内部升级规则；具体结果会反映在相关单位和能力上。",
        facts,
      });
    }
  }
  const deduplicated = new Map();
  for (const effect of effects) {
    const key = effect.ids.join("|");
    if (!deduplicated.has(key)) deduplicated.set(key, effect);
  }
  return [...deduplicated.values()];
}

function unitIcon(database, commanderId, unit) {
  const directActorIcon = catalogField(database, "Actor", unit.unitId, "UnitIcon");
  const techActorIcon = catalogField(database, "Actor", unit.techId, "UnitIcon");
  const relatedActorIcon = database
    .prepare(`
      SELECT icon.value
      FROM catalog_fields unit
      JOIN catalog_fields icon
        ON icon.catalog='Actor'
       AND icon.object_id=unit.object_id
       AND lower(icon.path)='uniticon'
      WHERE unit.catalog='Actor'
        AND lower(unit.path)='@unitname'
        AND unit.value=?
      ORDER BY unit.object_id
      LIMIT 1
    `)
    .get(unit.unitId)?.value;
  const completedActorIcon = unit.unitId.startsWith("Unfinished")
    ? catalogField(database, "Actor", unit.unitId.slice("Unfinished".length), "UnitIcon")
    : null;
  const directArmyIcon = catalogIcon(database, "ArmyCategory", unit.unitId);
  const relatedArmyIcon = database
    .prepare(`
      SELECT icon.value
      FROM catalog_fields unit
      JOIN catalog_fields icon
        ON icon.catalog='ArmyCategory'
       AND icon.object_id=unit.object_id
       AND lower(icon.path)='icon'
      LEFT JOIN commander_membership membership
        ON membership.commander_id=?
       AND membership.catalog='ArmyCategory'
       AND membership.object_id=unit.object_id
      WHERE unit.catalog='ArmyCategory'
        AND lower(unit.path)='unit'
        AND unit.value=?
      ORDER BY (membership.commander_id IS NOT NULL) DESC, unit.object_id
      LIMIT 1
    `)
    .get(commanderId, unit.unitId)?.value;
  const icon = directActorIcon
    ?? techActorIcon
    ?? relatedActorIcon
    ?? completedActorIcon
    ?? directArmyIcon
    ?? relatedArmyIcon
    ?? catalogIcon(database, "Button", unit.unitId)
    ?? catalogIcon(database, "ArmyCategory", unit.techId)
    ?? catalogIcon(database, "Button", unit.techId);
  return icon
    ?.replaceAll("##unitName##", unit.unitId)
    .replaceAll("##id##", unit.unitId) ?? null;
}

function panelAbilityStats(database, abilityId, commandIndex) {
  const fields = database
    .prepare(`
      SELECT path, value
      FROM catalog_fields
      WHERE catalog='Abil' AND object_id=?
        AND (lower(path) LIKE '%cooldown%'
          OR lower(path) LIKE '%charge.timeuse'
          OR lower(path) LIKE '%resource[%'
          OR lower(path) LIKE '%vital[%')
      ORDER BY path
    `)
    .all(abilityId);
  const commandPrefix = commandIndex ? `InfoArray[${commandIndex}]` : null;
  const commandCooldown = commandPrefix
    ? fields.find((field) => field.path.toLowerCase() === `${commandPrefix}.Cooldown.@TimeUse`.toLowerCase())
      ?? fields.find((field) => field.path.toLowerCase() === `${commandPrefix}.Cooldown.TimeUse`.toLowerCase())
      ?? fields.find((field) => field.path.toLowerCase() === `${commandPrefix}.Charge.TimeUse`.toLowerCase())
    : null;
  const globalCooldown = fields.find((field) =>
    /^Cost(?:\[[^\]]+\])?\.Cooldown\.@?TimeUse$/i.test(field.path));
  const rawCooldown = commandCooldown?.value ?? globalCooldown?.value ?? null;
  const cooldown = rawCooldown === null || !Number.isFinite(Number(rawCooldown))
    ? null
    : Number(rawCooldown);

  const commandCostPattern = commandPrefix
    ? new RegExp(`^${commandPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(Resource|Vital)\\[([^\\]]+)\\]$`, "i")
    : null;
  const commandResourceFields = commandCostPattern
    ? fields.filter((field) => commandCostPattern.test(field.path))
    : [];
  const resourceFields = commandResourceFields.length > 0
    ? commandResourceFields
    : fields.filter((field) =>
      /^Cost(?:\[[^\]]+\])?\.(?:Resource|Vital)\[[^\]]+\]$/i.test(field.path));
  const resources = [];
  for (const field of resourceFields) {
    const match = commandCostPattern?.exec(field.path)
      ?? /^Cost(?:\[[^\]]+\])?\.(Resource|Vital)\[([^\]]+)\]$/i.exec(field.path);
    if (!match) continue;
    const amount = Number(field.value);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const key = `${match[1].toLowerCase()}:${match[2].toLowerCase()}`;
    if (resources.some((resource) => resource.key === key)) continue;
    resources.push({
      key,
      kind: match[1].toLowerCase(),
      id: match[2],
      amount,
    });
  }
  return { cooldown, resources };
}

function commanderPanelAbilities(database, casterUnit) {
  if (!casterUnit) return [];
  const fields = database
    .prepare(`
      SELECT path, value
      FROM catalog_fields
      WHERE catalog='Unit' AND object_id=? AND lower(path) LIKE 'cardlayouts%layoutbuttons%'
      ORDER BY path
    `)
    .all(casterUnit);
  const buttons = new Map();
  for (const field of fields) {
    const match = /^(CardLayouts(?:\[[^\]]+\])?\.LayoutButtons(?:\[[^\]]+\])?)\.@?(.+)$/.exec(field.path);
    if (!match) continue;
    if (!buttons.has(match[1])) buttons.set(match[1], { sourcePath: match[1] });
    buttons.get(match[1])[match[2]] = field.value;
  }

  const slots = new Map();
  for (const button of buttons.values()) {
    if (button.Type !== "AbilCmd" || !button.Face || !button.AbilCmd) continue;
    if (button.AbilCmd.toLowerCase() === "buildinprogress,cancel") continue;
    if (Number(button.Row ?? 0) !== 0) continue;
    const slot = `${button.sourcePath.split(".LayoutButtons")[0]}:${button.Row ?? 0}:${button.Column ?? 0}`;
    if (!slots.has(slot)) slots.set(slot, button);
  }

  return [...slots.values()]
    .sort((left, right) =>
      Number(left.Row ?? 0) - Number(right.Row ?? 0)
      || Number(left.Column ?? 0) - Number(right.Column ?? 0)
      || left.sourcePath.localeCompare(right.sourcePath))
    .map((button) => {
      const [abilityId, commandIndex] = button.AbilCmd.split(",", 2);
      const iconAsset = catalogIcon(database, "Button", button.Face)
        ?.replaceAll("##id##", button.Face)
        .replaceAll("##unitName##", casterUnit)
        .replaceAll("\\", "/") ?? null;
      const tooltipKey = (catalogField(database, "Button", button.Face, "Tooltip")
        ?? `Button/Tooltip/${button.Face}`).replaceAll("##id##", button.Face);
      return {
        id: button.Face,
        abilityId,
        commandIndex: commandIndex ?? null,
        row: Number(button.Row ?? 0),
        column: Number(button.Column ?? 0),
        nameZhCN: localizedText(database, "zhcn", `Button/Name/${button.Face}`),
        nameEnUS: localizedText(database, "enus", `Button/Name/${button.Face}`),
        tooltipZhCN: localizedText(database, "zhcn", tooltipKey),
        tooltipEnUS: localizedText(database, "enus", tooltipKey),
        stats: panelAbilityStats(database, abilityId, commandIndex ?? null),
        iconAsset,
      };
    });
}

function isSummonedUnitReference(fieldPath) {
  return /(?:spawnunit|producedunitarray|infoarray.*\.@?unit)$/i.test(fieldPath);
}

function panelSummonPresentationUnit(database, unitId) {
  const unitExists = database
    .prepare("SELECT 1 FROM catalog_objects WHERE catalog='Unit' AND object_id=?")
    .get(unitId);
  if (!unitExists) return null;
  const hasName = (candidateId) => Boolean(
    localizedText(database, "zhcn", `Unit/Name/${candidateId}`)
      ?? localizedText(database, "enus", `Unit/Name/${candidateId}`),
  );
  if (hasName(unitId)) return unitId;

  // Some calldowns first create an unnamed drop placeholder which immediately
  // morphs into the unit that the player actually sees (for example Mengsk's
  // Supply Bunker). Follow only the small creation/morph subgraph here.
  const references = database.prepare(`
    SELECT field_path AS fieldPath, target_catalog AS targetCatalog,
           target_object_id AS targetObjectId
    FROM object_references
    WHERE source_catalog=? AND source_object_id=? AND confidence>=0.9
    ORDER BY field_path, target_catalog, target_object_id
  `);
  const queue = [{ catalog: "Unit", objectId: unitId, depth: 0 }];
  const visited = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    const key = `${current.catalog}\u0000${current.objectId}`;
    if (visited.has(key) || current.depth >= 4) continue;
    visited.add(key);
    for (const reference of references.all(current.catalog, current.objectId)) {
      if (reference.targetCatalog === "Unit"
          && reference.targetObjectId !== unitId
          && isSummonedUnitReference(reference.fieldPath)
          && hasName(reference.targetObjectId)) {
        return reference.targetObjectId;
      }
      if (["Abil", "Behavior", "Effect"].includes(reference.targetCatalog)) {
        queue.push({
          catalog: reference.targetCatalog,
          objectId: reference.targetObjectId,
          depth: current.depth + 1,
        });
      }
    }
  }
  return null;
}

function commanderPanelSummonedUnits(database, commanderId, abilities) {
  const references = database.prepare(`
    SELECT field_path AS fieldPath, target_catalog AS targetCatalog,
           target_object_id AS targetObjectId
    FROM object_references
    WHERE source_catalog=? AND source_object_id=? AND confidence>=0.9
    ORDER BY field_path, target_catalog, target_object_id
  `);
  const abilityUnitFields = database.prepare(`
    SELECT path, value
    FROM catalog_fields
    WHERE catalog='Abil' AND object_id=? AND lower(path) LIKE '%unit%'
    ORDER BY path
  `);
  const prefixedCreateUnits = database.prepare(`
    SELECT object_id AS objectId, path, value
    FROM catalog_fields
    WHERE catalog='Effect'
      AND lower(object_id) LIKE lower(?)
      AND (lower(path) LIKE '%spawnunit%'
        OR lower(path) LIKE '%producedunitarray%'
        OR lower(path) LIKE '%infoarray%.unit'
        OR lower(path) LIKE '%infoarray%.@unit')
    ORDER BY object_id, path
  `);
  const allCandidates = new Map();
  const addCandidate = (rawUnitId, abilityId) => {
    if (!rawUnitId || /(?:prestige|missile|dummy|cursor|spawnerunit|prep$|strafer|transportunit$)/i.test(rawUnitId)) {
      return;
    }
    const unitId = panelSummonPresentationUnit(database, rawUnitId);
    if (!unitId) return;
    if (!allCandidates.has(unitId)) allCandidates.set(unitId, new Set());
    allCandidates.get(unitId).add(abilityId);
  };
  const traverseCreationGraph = (catalog, objectId, abilityId, maxDepth = 6) => {
    const queue = [{ catalog, objectId, depth: 0 }];
    const visited = new Set();
    while (queue.length > 0) {
      const current = queue.shift();
      const key = `${current.catalog}\u0000${current.objectId}`;
      if (visited.has(key) || current.depth >= maxDepth) continue;
      visited.add(key);
      for (const reference of references.all(current.catalog, current.objectId)) {
        if (reference.targetCatalog === "Unit" && isSummonedUnitReference(reference.fieldPath)) {
          addCandidate(reference.targetObjectId, abilityId);
        }
        if (["Effect", "Behavior"].includes(reference.targetCatalog)) {
          queue.push({
            catalog: reference.targetCatalog,
            objectId: reference.targetObjectId,
            depth: current.depth + 1,
          });
        }
      }
    }
  };

  for (const ability of abilities) {
    const fields = abilityUnitFields.all(ability.abilityId);
    const escapedCommand = ability.commandIndex
      ? ability.commandIndex.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      : null;
    const commandUnitPattern = escapedCommand
      ? new RegExp(`^InfoArray\\[${escapedCommand}\\]\\.@?Unit$`, "i")
      : null;
    const commandUnits = commandUnitPattern
      ? fields.filter((field) => commandUnitPattern.test(field.path))
      : [];
    const producedUnits = fields.filter((field) =>
      /^(?:ProducedUnitArray(?:\[[^\]]+\])?|SpawnUnit)$/i.test(field.path));
    for (const field of commandUnits) addCandidate(field.value, ability.id);
    for (const field of producedUnits) addCandidate(field.value, ability.id);

    // A command-specific train entry is authoritative. Traversing the whole
    // train ability would incorrectly include every other button on that card.
    if (commandUnits.length === 0) {
      traverseCreationGraph("Abil", ability.abilityId, ability.id);

      for (const rootId of new Set([ability.id, ability.abilityId])) {
        for (const field of prefixedCreateUnits.all(`${rootId}%`)) {
          const suffix = field.objectId.slice(rootId.length);
          if (/(?:expire|death|kill|weapon|damage|impact|launch|search)/i.test(suffix)) continue;
          addCandidate(field.value, ability.id);
        }
      }

      const tooltip = ability.tooltipZhCN ?? ability.tooltipEnUS ?? "";
      for (const match of tooltip.matchAll(/<d\s+ref="(Effect|Behavior),([^,\"]+)/gi)) {
        traverseCreationGraph(match[1], match[2], ability.id);
      }
    }
  }

  // Prefer the player-owned power-field unit over its otherwise identical ally copy.
  for (const unitId of [...allCandidates.keys()]) {
    if (unitId.endsWith("AllyUnit") && allCandidates.has(unitId.replace(/AllyUnit$/, "Unit"))) {
      allCandidates.delete(unitId);
    }
  }

  return [...allCandidates.entries()]
    .map(([unitId, summonedBy]) => ({
      ...buildUnitProjection(database, {
        commanderId,
        unit: {
          techId: unitId,
          unitId,
          nameZhCN: localizedText(database, "zhcn", `Unit/Name/${unitId}`),
          nameEnUS: localizedText(database, "enus", `Unit/Name/${unitId}`),
          unlockedAtLevel: null,
        },
        includeDetails: false,
      }),
      summonedByAbilityIds: [...summonedBy],
      iconAsset: unitIcon(database, commanderId, { unitId, techId: unitId })
        ?.replaceAll("\\", "/") ?? null,
    }))
    .filter((unit) => unit.iconAsset)
    .sort((left, right) => left.unitId.localeCompare(right.unitId));
}

try {
  const search = createCoopSearch();
  const result = search.withProjectDatabase({ commanderId }, (database) => {
    const result = search.execute({
      operation: "commander.get",
      commanderId,
      detailLevel: "full",
    });
    const databaseLocation = search.locateDatabase();
    const rawProfile = database
      .prepare("SELECT profile_json AS profileJson FROM commander_profiles WHERE commander_id=?")
      .get(result.commander.id)?.profileJson;
    const profile = rawProfile ? JSON.parse(rawProfile) : { levelPerks: [] };
    const profilePerks = new Map(
      (profile.levelPerks ?? []).map((perk) => [perk.id, perk]),
    );
    const roster = [...result.roster.units, ...result.roster.buildings];
    result.levelPerks = result.levelPerks.map((perk) => {
      const buttonId = (database
        .prepare(`
          SELECT value
          FROM catalog_fields
          WHERE catalog='Talent' AND object_id=? AND lower(path)='face'
        `)
        .get(perk.id)?.value ?? perk.id).replaceAll("##id##", perk.id);
      const fields = database
        .prepare(`
          SELECT lower(path) AS path, value
          FROM catalog_fields
          WHERE catalog='Button' AND object_id=? AND lower(path) IN ('icon', 'tooltip')
        `)
        .all(buttonId);
      const fieldMap = new Map(fields.map((field) => [field.path, field.value]));
      const iconAsset = fieldMap.get("icon")?.replaceAll("\\", "/") ?? null;
      const tooltipKey = (fieldMap.get("tooltip") ?? `Button/Tooltip/${buttonId}`)
        .replaceAll("##id##", buttonId);
      const profilePerk = profilePerks.get(perk.id);
      const linkedUpgradeIds = new Set((profilePerk?.links ?? [])
        .filter((link) => link.catalog === "Upgrade")
        .map((link) => link.objectId));
      const affectedUnits = roster.filter((unit) =>
        unit.details?.commanderUpgrades?.some((upgrade) =>
          upgrade.ids.includes(perk.id)
          || upgrade.ids.some((id) => linkedUpgradeIds.has(id))));
      return {
        ...perk,
        buttonId,
        tooltipZhCN: localizedText(database, "zhcn", tooltipKey),
        tooltipEnUS: localizedText(database, "enus", tooltipKey),
        iconAsset,
        relatedEffects: levelPerkRelatedEffects(database, profilePerk),
        affectedUnits: affectedUnits.map((unit) => ({
          unitId: unit.unitId,
          nameZhCN: unit.nameZhCN,
          nameEnUS: unit.nameEnUS,
        })),
      };
    });

    result.prestiges = result.prestiges.map((prestige) => ({
      ...prestige,
      tooltipZhCN: localizedText(database, "zhcn", `Button/Tooltip/${prestige.id}`),
      tooltipEnUS: localizedText(database, "enus", `Button/Tooltip/${prestige.id}`),
    }));

    const masteryIncrements = masteryPointIncrements(
      databaseLocation.databaseFile,
      result.masteries,
    );
    result.masteries = result.masteries.map((mastery) => ({
      ...mastery,
      pointIncrement: masteryIncrements.get(mastery.id) ?? null,
      valueFormatZhCN: localizedText(
        database,
        "zhcn",
        `UserData/MasteryUpgrades/${mastery.id}_ValueFormat`,
      ),
      valueFormatEnUS: localizedText(
        database,
        "enus",
        `UserData/MasteryUpgrades/${mastery.id}_ValueFormat`,
      ),
    }));

    result.panel.abilities = commanderPanelAbilities(database, result.panel.casterUnit);
    result.panel.summonedUnits = commanderPanelSummonedUnits(
      database,
      result.commander.id,
      result.panel.abilities,
    );

    result.roster.units = result.roster.units.map((unit) => ({
      ...unit,
      iconAsset: unitIcon(database, result.commander.id, unit)?.replaceAll("\\", "/") ?? null,
    }));
    result.roster.buildings = result.roster.buildings.map((building) => ({
      ...building,
      iconAsset: unitIcon(database, result.commander.id, building)?.replaceAll("\\", "/") ?? null,
    }));
    return result;
  });

  const iconAssets = result.levelPerks
    .map((perk) => perk.iconAsset)
    .concat(result.roster.units.map((unit) => unit.iconAsset))
    .concat(result.roster.buildings.map((building) => building.iconAsset))
    .concat(result.panel.abilities.map((ability) => ability.iconAsset))
    .concat(result.panel.summonedUnits.map((unit) => unit.iconAsset))
    .filter(Boolean);
  const cascPaths = await resolveCascPaths(result.database.sc2Build, iconAssets);
  result.levelPerks = result.levelPerks.map((perk) => ({
    ...perk,
    iconCascPath: perk.iconAsset ? cascPaths.get(perk.iconAsset) ?? null : null,
  }));
  result.roster.units = result.roster.units.map((unit) => ({
    ...unit,
    iconCascPath: unit.iconAsset ? cascPaths.get(unit.iconAsset) ?? null : null,
  }));
  result.roster.buildings = result.roster.buildings.map((building) => ({
    ...building,
    iconCascPath: building.iconAsset ? cascPaths.get(building.iconAsset) ?? null : null,
  }));
  result.panel.abilities = result.panel.abilities.map((ability) => ({
    ...ability,
    iconCascPath: ability.iconAsset ? cascPaths.get(ability.iconAsset) ?? null : null,
  }));
  result.panel.summonedUnits = result.panel.summonedUnits.map((unit) => ({
    ...unit,
    iconCascPath: unit.iconAsset ? cascPaths.get(unit.iconAsset) ?? null : null,
  }));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
