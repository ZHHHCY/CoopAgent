#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { workspaceRoot } from "../../scripts/lib/project-context.mjs";
import { DatabaseSync } from "node:sqlite";
import { attachEngineCatalog } from "../../scripts/lib/engine-catalog-store.mjs";

import { createCoopSearch } from "./lib/coop-search.mjs";
import {
  buildPlanSummaryRecord,
  parseHistoricalSummaryIndex,
} from "./lib/change-summary-record.mjs";
import { reviewPatchPlan } from "./lib/patch-plan-review.mjs";

const repoRoot = workspaceRoot();
const patchesRoot = path.join(repoRoot, "game-a", "patches");
const coreRoot = path.join(repoRoot, "game-a", "core", "GameA.SC2Mod");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function primaryText(value) {
  return value?.split(" /// ")[0]?.trim() || null;
}

function localizedUnitName(database, unitId) {
  return primaryText(database.prepare(`
    SELECT value FROM localized_text
    WHERE lower(locale)='zhcn' AND text_key=?
  `).get(`Unit/Name/${unitId}`)?.value) ?? unitId;
}

function addIndexEntry(index, key, target) {
  const normalized = key.toLowerCase();
  const entries = index.get(normalized) ?? [];
  if (!entries.some((entry) => entry.kind === target.kind
      && entry.id === target.id && entry.commanderId === target.commanderId)) {
    entries.push(target);
  }
  index.set(normalized, entries);
}

function buildProfileIndex(database) {
  const byObjectId = new Map();
  const byCatalogObject = new Map();
  for (const row of database.prepare(`
    SELECT commander_id AS commanderId, profile_json AS profileJson
    FROM commander_profiles ORDER BY commander_id
  `).all()) {
    const profile = JSON.parse(row.profileJson);
    for (const unit of [
      ...(profile.roster?.units ?? []),
      ...(profile.roster?.buildings ?? []),
    ]) {
      const target = {
        kind: "unit",
        id: unit.unitId,
        label: primaryText(unit.nameZhCN) ?? primaryText(unit.nameEnUS) ?? unit.unitId,
        commanderId: row.commanderId,
      };
      addIndexEntry(byObjectId, unit.unitId, target);
      addIndexEntry(byObjectId, unit.techId, { ...target, id: unit.techId });
    }
    const collections = [
      ["levelPerk", profile.levelPerks ?? []],
      ["prestige", profile.prestiges ?? []],
      ["mastery", profile.masteries ?? []],
    ];
    for (const [kind, entries] of collections) {
      for (const entry of entries) {
        const target = {
          kind,
          id: entry.id,
          label: primaryText(entry.nameZhCN) ?? primaryText(entry.nameEnUS) ?? entry.id,
          commanderId: row.commanderId,
          ...(kind === "levelPerk" ? { level: entry.level } : {}),
          ...(kind === "prestige" ? { index: entry.index } : {}),
          ...(kind === "mastery" ? { category: entry.category } : {}),
        };
        addIndexEntry(byObjectId, entry.id, target);
        for (const link of entry.links ?? []) {
          addIndexEntry(byCatalogObject, `${link.catalog}/${link.objectId}`, target);
        }
      }
    }
  }
  return { byObjectId, byCatalogObject };
}

function createUnitAssociationResolver(database) {
  const incoming = database.prepare(`
    SELECT source_catalog AS catalog, source_object_id AS objectId
    FROM object_references
    WHERE target_catalog=? AND target_object_id=? AND confidence>=0.9
    ORDER BY source_catalog, source_object_id
    LIMIT 80
  `);
  const outgoingUnits = database.prepare(`
    SELECT target_object_id AS unitId
    FROM object_references
    WHERE source_catalog=? AND source_object_id=? AND target_catalog='Unit' AND confidence>=0.9
    ORDER BY target_object_id
    LIMIT 40
  `);
  const traversable = new Set(["Abil", "Actor", "Behavior", "Button", "Effect", "Upgrade", "Weapon"]);
  const cache = new Map();
  return (catalog, objectId) => {
    const cacheKey = `${catalog}/${objectId}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    if (catalog === "Unit") return [objectId];
    const units = new Set();
    const queue = [{ catalog, objectId, depth: 0 }];
    const visited = new Set();
    while (queue.length > 0 && visited.size < 160 && units.size < 40) {
      const current = queue.shift();
      const key = `${current.catalog}/${current.objectId}`;
      if (visited.has(key)) continue;
      visited.add(key);
      for (const row of outgoingUnits.all(current.catalog, current.objectId)) units.add(row.unitId);
      if (current.depth >= 3) continue;
      for (const source of incoming.all(current.catalog, current.objectId)) {
        if (source.catalog === "Unit") units.add(source.objectId);
        else if (traversable.has(source.catalog)) {
          queue.push({ ...source, depth: current.depth + 1 });
        }
      }
    }
    const result = [...units].sort();
    cache.set(cacheKey, result);
    return result;
  };
}

function targetKey(target) {
  return `${target.kind}/${target.commanderId ?? ""}/${target.id}`;
}

function enrichTargets(database, profileIndex, unitAssociations, item, scopeUnitIds) {
  const targets = new Map();
  const add = (target) => targets.set(targetKey(target), target);
  if (item.commanderId) {
    add({ kind: "commander", id: item.commanderId, label: item.commanderId, commanderId: item.commanderId });
  }
  for (const catalogTarget of item.catalogTargets ?? []) {
    const { catalog, objectId } = catalogTarget;
    if (catalog === "Unit") {
      add({ kind: "unit", id: objectId, label: localizedUnitName(database, objectId), commanderId: item.commanderId });
    } else if (catalog === "Upgrade") {
      add({ kind: "upgrade", id: objectId, label: objectId, commanderId: item.commanderId });
    } else if (catalog === "Abil") {
      add({ kind: "ability", id: objectId, label: objectId, commanderId: item.commanderId });
    }
    for (const target of profileIndex.byObjectId.get(objectId.toLowerCase()) ?? []) add(target);
    for (const target of profileIndex.byCatalogObject.get(`${catalog}/${objectId}`.toLowerCase()) ?? []) add(target);
    const relatedUnits = scopeUnitIds.length > 0 ? scopeUnitIds : unitAssociations(catalog, objectId);
    for (const unitId of relatedUnits) {
      add({ kind: "unit", id: unitId, label: localizedUnitName(database, unitId), commanderId: item.commanderId });
    }
  }
  const values = [...targets.values()];
  return values.filter((target) => target.commanderId !== null
    || !values.some((candidate) => candidate.kind === target.kind
      && candidate.id === target.id && candidate.commanderId !== null))
    .sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.label.localeCompare(right.label));
}

try {
  const search = createCoopSearch();
  const databaseFile = search.locateDatabase().databaseFile;
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  database.exec('PRAGMA temp_store=MEMORY; BEGIN');
  attachEngineCatalog(database);
  database.exec("PRAGMA query_only = ON");
  try {
    const profileIndex = buildProfileIndex(database);
    const unitAssociations = createUnitAssociationResolver(database);
    const historicalSummaryPath = path.join(patchesRoot, "user-summaries.json");
    const historicalSummaries = existsSync(historicalSummaryPath)
      ? parseHistoricalSummaryIndex(readJson(historicalSummaryPath))
      : new Map();
    const summaries = [];
    if (existsSync(patchesRoot)) {
      for (const receiptName of readdirSync(patchesRoot)
        .filter((name) => name.endsWith(".receipt.json")).sort()) {
        const receiptPath = path.join(patchesRoot, receiptName);
        const receipt = readJson(receiptPath);
        const planPath = path.join(patchesRoot, `${receipt.planId}.patch-plan.json`);
        if (!existsSync(planPath)) continue;
        const plan = readJson(planPath);
        const review = reviewPatchPlan(plan, { databaseFile, coreRoot });
        const changeItems = review.userSummary.changeItems ?? [];
        const { item, scopeUnitIds } = buildPlanSummaryRecord({
          plan,
          receipt,
          changeItems,
          historicalSummaries,
        });
        const { commanderId, catalogTargets, ...publicItem } = item;
        summaries.push({
          ...publicItem,
          targets: enrichTargets(
            database,
            profileIndex,
            unitAssociations,
            { commanderId, catalogTargets },
            scopeUnitIds,
          ),
          plan: {
            id: plan.id,
            title: plan.title,
            path: path.posix.join("game-a", "patches", `${plan.id}.patch-plan.json`),
            receiptPath: path.posix.join("game-a", "patches", receiptName),
            appliedAt: receipt.appliedAt,
            sha256: receipt.planSha256,
          },
        });
      }
    }
    summaries.sort((left, right) =>
      String(right.plan.appliedAt).localeCompare(String(left.plan.appliedAt))
      || left.plan.id.localeCompare(right.plan.id)
      || left.id.localeCompare(right.id));
    process.stdout.write(`${JSON.stringify({
      operation: "change_summary.list",
      total: summaries.length,
      items: summaries,
    })}\n`);
  } finally {
    database.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
