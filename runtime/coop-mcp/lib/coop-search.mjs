import { workspaceRoot } from '../../../scripts/lib/project-context.mjs';
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  operationTargets,
  targetsConflict,
} from "../../../scripts/lib/patch-plan-executor.mjs";
import { buildUnitProjection } from "./unit-details.mjs";
import { commanderNavigation, findCommanderEntries } from './commander-navigation.mjs';
import { attachGameAProjection } from "./game-a-projection.mjs";
import { commanderEditRoute } from "../../../scripts/lib/commander-edit-policy.mjs";
import { canonicalEditPath } from "../../../scripts/lib/catalog-edit-contract.mjs";
import { masteryPointSelector } from '../../../scripts/lib/mastery-point-editor.mjs';
import { attachEngineCatalog } from "../../../scripts/lib/engine-catalog-store.mjs";
import { readUpgradeOperation } from './upgrade-operation.mjs';
import { isolationWorkflow } from './authoring-workflow.mjs';
import { projectUnitArrayFields } from "./unit-arrays.mjs";
import { readGameAConsistently } from "../../../scripts/lib/game-a-transaction.mjs";
import { extractGalaxySymbols, GALAXY_SYMBOL_VERSION } from "../../../scripts/lib/galaxy-symbols.mjs";
import { readCoopEntityFacts, readCoopCommanderFacts, COMMANDER_SECTIONS } from '../../../scripts/lib/coop-semantics.mjs';
import { describeField, readObjectFieldGuide } from '../../../scripts/lib/field-vocabulary.mjs';
import { readObjectParameters } from '../../../scripts/lib/object-parameters.mjs';
import { createFieldInfluenceReader, INFLUENCE_BOUNDARY } from './field-influences.mjs';
import { readMasteryEvidence } from './mastery-evidence.mjs';
import { createUnitIdentityReader } from './unit-identity.mjs';
import { readUpgradeEffects } from './upgrade-effects.mjs';
import { createProjectReadCache, projectReadRevision } from './project-read-cache.mjs';
import { createFieldUsageReader } from './field-usage.mjs';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = workspaceRoot();
const DEFAULT_COMMANDER_ALIASES_FILE = path.resolve(
  MODULE_DIRECTORY,
  "../data/commander-aliases.zh-CN.json",
);
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const DEFAULT_GALAXY_LIMIT = 8;
const MAX_GALAXY_LIMIT = 20;
const GALAXY_CONTEXT_RADIUS = 4;
const MAX_GALAXY_SNIPPET_CHARS = 4_000;
export const COOP_DATABASE_BUSY_TIMEOUT_MS = 2_000;

export const SEARCH_OPERATIONS = [
  "commander.resolve",
  "commander.get",
  "entity.resolve",
  "entity.get",
  "impact.analyze",
  "requirement.explain",
  "galaxy.context",
  "patches.for_target",
];

// These primitives remain available to repository diagnostics and compatibility
// scripts, but are deliberately omitted from the MCP schema shown to the Agent.
// The public surface above is organized by authoring intent rather than storage.
export const INTERNAL_SEARCH_OPERATIONS = [
  "status",
  "commander.list",
  "commanders_for_unit",
  "catalog.search",
  "catalog.object",
  "catalog.references",
  "relationships.trace",
  "catalog.effective",
  "graph.slice",
];

const ALL_SEARCH_OPERATIONS = [
  ...SEARCH_OPERATIONS,
  ...INTERNAL_SEARCH_OPERATIONS,
];

export const RELATIONSHIP_FAMILIES = [
  "all",
  "creation",
  "abilities",
  "combat",
  "behaviors",
  "upgrades",
  "visuals",
];

export class CoopSearchError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CoopSearchError";
    this.details = details;
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function clampLimit(value) {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new CoopSearchError(`limit must be an integer between 1 and ${MAX_LIMIT}.`);
  }
  return value;
}

function requireString(input, key) {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new CoopSearchError(`${key} is required for search.${input.operation}.`);
  }
  return value.trim();
}

function ftsQuery(value) {
  const tokens = value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12)
    .map((token) => `"${token.replaceAll('"', '""')}"*`);
  if (tokens.length === 0) throw new CoopSearchError("query must not be empty.");
  return tokens.join(" AND ");
}

function rowsToPlain(rows) {
  return rows.map((row) => ({ ...row }));
}

function galaxySnippet(contents, line, radius = GALAXY_CONTEXT_RADIUS) {
  const lines = String(contents ?? "").replaceAll("\r\n", "\n").split("\n");
  const targetIndex = Math.max(0, Math.min(lines.length - 1, Number(line) - 1));
  const startIndex = Math.max(0, targetIndex - radius);
  const endIndex = Math.min(lines.length - 1, targetIndex + radius);
  let text = lines
    .slice(startIndex, endIndex + 1)
    .map((value, offset) => `${startIndex + offset + 1}: ${value}`)
    .join("\n");
  const truncated = text.length > MAX_GALAXY_SNIPPET_CHARS;
  if (truncated) text = `${text.slice(0, MAX_GALAXY_SNIPPET_CHARS)}\n…`;
  return {
    startLine: startIndex + 1,
    endLine: endIndex + 1,
    text,
    truncated,
  };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function galaxyIdentifierPattern(identifier) {
  return new RegExp(`(^|[^A-Za-z0-9_])${escapeRegex(identifier)}([^A-Za-z0-9_]|$)`, "i");
}

function locateGalaxySymbolLine(contents, indexedLine, name, kind) {
  const lines = String(contents ?? "").replaceAll("\r\n", "\n").split("\n");
  const targetIndex = Math.max(0, Math.min(lines.length - 1, Number(indexedLine) - 1));
  const startIndex = Math.max(0, targetIndex - 8);
  const endIndex = Math.min(lines.length - 1, targetIndex + 8);
  const identifier = galaxyIdentifierPattern(name);
  const functionDeclaration = ["function", "native"].includes(kind)
    ? new RegExp(
        `^\\s*(?:(?:static|native)\\s+)*[A-Za-z_][A-Za-z0-9_]*(?:\\[[^\\]]+\\])?\\s+${escapeRegex(name)}\\s*\\(`,
        "i",
      )
    : null;
  const candidates = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    if (!identifier.test(lines[index])) continue;
    candidates.push({
      index,
      declaration: Boolean(functionDeclaration?.test(lines[index])),
      distance: Math.abs(index - targetIndex),
    });
  }
  candidates.sort((left, right) =>
    Number(right.declaration) - Number(left.declaration) ||
    left.distance - right.distance || left.index - right.index);
  return (candidates[0]?.index ?? targetIndex) + 1;
}

function orderedGalaxyTokens(texts, limit = 300) {
  const result = [];
  const seen = new Set();
  for (const text of texts) {
    for (const match of String(text ?? "").matchAll(/\b[A-Za-z][A-Za-z0-9_]{2,127}\b/g)) {
      if (seen.has(match[0])) continue;
      seen.add(match[0]);
      result.push(match[0]);
      if (result.length >= limit) return result;
    }
  }
  return result;
}

function catalogNodeKey(catalog, objectId) {
  return `${catalog}/${objectId}`.toLowerCase();
}

function normalizeImpactScope(input) {
  if (input.scope === undefined) return null;
  if (!input.scope || typeof input.scope !== "object") {
    throw new CoopSearchError("scope must be an object for search.impact.analyze.");
  }
  if (input.scope.kind === "global") return { kind: "global" };
  if (input.scope.kind !== "commander") {
    throw new CoopSearchError("scope.kind must be 'commander' or 'global'.");
  }
  const commanderId = typeof input.scope.commanderId === "string"
    ? input.scope.commanderId.trim()
    : "";
  if (!commanderId) {
    throw new CoopSearchError("scope.commanderId is required for commander-scoped impact analysis.");
  }
  return { kind: "commander", commanderId };
}

function normalizeImpactOwner(input) {
  if (input.owner === undefined) return null;
  if (!input.owner || typeof input.owner !== "object") {
    throw new CoopSearchError("owner must be an object for search.impact.analyze.");
  }
  const catalog = typeof input.owner.catalog === "string" ? input.owner.catalog.trim() : "";
  const objectId = typeof input.owner.objectId === "string" ? input.owner.objectId.trim() : "";
  if (!catalog || !objectId) {
    throw new CoopSearchError("owner.catalog and owner.objectId are required together.");
  }
  return { catalog, objectId };
}

function privateCatalogId(commanderId, objectId) {
  const compactCommander = String(commanderId).replace(/[^A-Za-z0-9_]/g, "");
  const compactObject = String(objectId).replace(/[^A-Za-z0-9_]/g, "");
  return `GameA${compactCommander}${compactObject}`.slice(0, 160);
}

function catalogPaths(edges, from, to, maxPaths = 8) {
  const fromKey = catalogNodeKey(from.catalog, from.objectId);
  const toKey = catalogNodeKey(to.catalog, to.objectId);
  const outgoing = new Map();
  for (const edge of edges) {
    const key = catalogNodeKey(edge.source.catalog, edge.source.objectId);
    const entries = outgoing.get(key) ?? [];
    entries.push(edge);
    outgoing.set(key, entries);
  }
  for (const entries of outgoing.values()) {
    entries.sort((left, right) =>
      left.relation.localeCompare(right.relation) ||
      left.fieldPath.localeCompare(right.fieldPath) ||
      left.target.catalog.localeCompare(right.target.catalog) ||
      left.target.objectId.localeCompare(right.target.objectId));
  }

  const result = [];
  const visit = (currentKey, steps, seen) => {
    if (result.length >= maxPaths) return;
    if (currentKey === toKey) {
      result.push(steps);
      return;
    }
    for (const edge of outgoing.get(currentKey) ?? []) {
      const nextKey = catalogNodeKey(edge.target.catalog, edge.target.objectId);
      if (seen.has(nextKey)) continue;
      visit(nextKey, [...steps, edge], new Set([...seen, nextKey]));
    }
  };
  visit(fromKey, [], new Set([fromKey]));
  return result.sort((left, right) =>
    left.length - right.length ||
    JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

const OWNER_ENTRYPOINT_ROLES = [
  "creation",
  "requirement",
  "progression",
  "visual",
  "profile",
  "other",
];

function ownerEntrypointRole(edge) {
  const family = relationshipFamily(edge.relation);
  const sourceCatalog = edge.source.catalog.toLowerCase();
  if (family === "creation") return "creation";
  if (sourceCatalog === "requirement") return "requirement";
  if (family === "upgrades") return "progression";
  if (family === "visuals" || ["actor", "skin", "skinpack"].includes(sourceCatalog)) return "visual";
  if (["user", "armycategory", "armyunit"].includes(sourceCatalog)) return "profile";
  return "other";
}

function ownerEntrypointAction(role) {
  switch (role) {
    case "creation": return "redirect-private-owner";
    case "requirement": return "preserve-or-remap-counting";
    case "progression": return "preserve-or-remap-upgrades";
    case "visual": return "bind-private-visuals";
    case "profile": return "preserve-or-remap-profile";
    default: return "inspect-reference";
  }
}

function analyzeOwnerEntrypoints({ owner, edges, nodeMemberships, requestedScope, suggestedOwnerId, truncated, inspectEdit }) {
  if (!owner) return null;
  const ownerKey = catalogNodeKey(owner.catalog, owner.objectId);
  const incoming = edges.filter((edge) =>
    catalogNodeKey(edge.target.catalog, edge.target.objectId) === ownerKey);
  const groups = new Map();
  for (const edge of incoming) {
    const role = ownerEntrypointRole(edge);
    const key = `${role}/${catalogNodeKey(edge.source.catalog, edge.source.objectId)}`;
    let group = groups.get(key);
    if (!group) {
      const memberships = nodeMemberships.get(
        catalogNodeKey(edge.source.catalog, edge.source.objectId),
      ) ?? [];
      const commanderIds = [...new Set(memberships.map((row) => row.commanderId))]
        .sort((left, right) => left.localeCompare(right));
      const outsideCommanderIds = requestedScope?.kind === "commander"
        ? commanderIds.filter((commanderId) => commanderId !== requestedScope.commanderId)
        : [];
      const scopeStatus = outsideCommanderIds.length > 0
        ? commanderIds.includes(requestedScope?.commanderId) ? "shared" : "outside"
        : commanderIds.includes(requestedScope?.commanderId)
          ? "requested-commander"
          : "unresolved";
      group = {
        role,
        action: ownerEntrypointAction(role),
        source: edge.source,
        commanderIds,
        outsideCommanderIds,
        scopeStatus,
        paths: [],
      };
      groups.set(key, group);
    }
    const edit = inspectEdit(edge.source.catalog, edge.source.objectId, edge.fieldPath).catalogEdit;
    const patchable = edit.available && edit.expect === owner.objectId;
    group.paths.push({
      path: edge.fieldPath,
      relation: edge.relation,
      confidence: edge.confidence,
      evidence: edge.evidence,
      patchable,
      edit,
      reviewRequired: edge.relation === "creates_or_targets_unit" || !patchable,
    });
  }

  const buckets = Object.fromEntries(OWNER_ENTRYPOINT_ROLES.map((role) => [role, []]));
  for (const group of groups.values()) {
    group.paths.sort((left, right) =>
      relationshipPriority(right.relation) - relationshipPriority(left.relation) ||
      left.path.localeCompare(right.path));
    buckets[group.role].push(group);
  }
  for (const role of OWNER_ENTRYPOINT_ROLES) {
    buckets[role].sort((left, right) =>
      relationshipPriority(right.paths[0]?.relation) - relationshipPriority(left.paths[0]?.relation) ||
      left.source.catalog.localeCompare(right.source.catalog) ||
      left.source.objectId.localeCompare(right.source.objectId));
  }

  const creationRewires = buckets.creation.flatMap((group) =>
    group.paths.filter((entry) => entry.patchable).map((entry) => ({
      catalog: group.source.catalog,
      objectId: group.source.objectId,
      path: entry.edit.operation.path,
      expect: entry.edit.expect,
      suggestedValue: suggestedOwnerId,
      relation: entry.relation,
      reviewRequired: entry.reviewRequired,
      mechanism: requestedScope?.kind === 'commander' && owner.catalog === 'Unit'
        ? 'commander.unit.clone.redirects' : 'inspect-scope-before-catalog.set',
    })));
  return {
    owner,
    completeness: truncated ? "bounded-truncated" : "bounded-complete",
    summary: Object.fromEntries(OWNER_ENTRYPOINT_ROLES.map((role) => [role, buckets[role].length])),
    ...buckets,
    creationRewires,
    guidance: [
      'For a commander Unit clone, use validated creationRewires as commander.unit.clone.redirects. Its generated player Upgrade can redirect a shared producer without cloning that producer.',
      'Clone only changed dependencies; preserve unchanged effects, abilities and behaviors. Parent inheritance does not retarget hard-coded Upgrade, Actor or Galaxy references: inspect progression and visual entries.',
      'An unavailable edit describes a specific resolver gap, not proof that isolation is impossible. Candidates are not a complete plan or an exclusivity proof.',
    ],
    warnings: [
      "Catalog entrypoints do not include dynamic Galaxy unit selection; use galaxy.context when creation or revival may be scripted.",
      ...(buckets.creation.some((group) => group.paths.some((entry) => !entry.patchable))
        ? ["Some creation paths have no matching executor edit descriptor; inspect their edit.reason before using them."]
        : []),
      ...(buckets.creation.length === 0
        ? ["No Catalog creation entrypoint was found for this owner; do not treat the clone as reachable until a Catalog or Galaxy entrypoint is proven."]
        : []),
    ],
  };
}

const SEMANTIC_CATALOG_KINDS = new Map([
  ["abil", "ability"],
  ["effect", "effect"],
  ["behavior", "behavior"],
  ["weapon", "weapon"],
  ["upgrade", "upgrade"],
]);

function sameCatalogObject(leftCatalog, leftObjectId, rightCatalog, rightObjectId) {
  return catalogNodeKey(leftCatalog, leftObjectId) === catalogNodeKey(rightCatalog, rightObjectId);
}

function profileBindingsForObject(database, object) {
  const bindings = [];
  const add = (commander, role, sourcePath) => {
    bindings.push({
      commanderId: commander.commanderId,
      commanderObjectId: commander.commanderObjectId,
      role,
      sourcePath,
    });
  };
  const matches = (catalog, objectId) =>
    sameCatalogObject(catalog, objectId, object.catalog, object.objectId);
  const addTypedLinks = (commander, items, collectionName, role) => {
    for (const [itemIndex, item] of (items ?? []).entries()) {
      for (const [linkIndex, link] of (item.links ?? []).entries()) {
        if (!matches(link.catalog, link.objectId)) continue;
        add(commander, role, `${collectionName}[${itemIndex}].links[${linkIndex}]`);
      }
    }
  };

  const rows = rowsToPlain(database.prepare(`
    SELECT p.commander_id AS commanderId, c.commander_object_id AS commanderObjectId,
           p.profile_json AS profileJson
    FROM commander_profiles p
    JOIN commanders c ON c.id=p.commander_id
    ORDER BY p.commander_id
  `).all());
  for (const commander of rows) {
    let profile;
    try {
      profile = JSON.parse(commander.profileJson);
    } catch {
      continue;
    }
    for (const [index, item] of (profile.roster?.buildings ?? []).entries()) {
      if (matches("Unit", item.unitId)) add(commander, "building", `roster.buildings[${index}]`);
    }
    for (const [index, item] of (profile.roster?.units ?? []).entries()) {
      if (matches("Unit", item.unitId)) add(commander, "roster-unit", `roster.units[${index}]`);
    }
    if (profile.panel?.casterUnit && matches("Unit", profile.panel.casterUnit)) {
      add(commander, "panel-caster", "panel.casterUnit");
    }
    for (const [index, command] of (profile.panel?.abilityCommands ?? []).entries()) {
      if (matches("Abil", command.abilityId)) {
        add(commander, "panel-ability-command", `panel.abilityCommands[${index}]`);
      }
    }
    for (const [index, upgradeId] of (profile.panel?.defaultUpgrades ?? []).entries()) {
      if (matches("Upgrade", upgradeId)) {
        add(commander, "panel-default-upgrade", `panel.defaultUpgrades[${index}]`);
      }
    }
    for (const [index, trait] of (profile.panel?.traits ?? []).entries()) {
      if (matches("Button", trait.buttonId)) {
        add(commander, "panel-trait", `panel.traits[${index}]`);
      }
    }
    for (const [index, prestige] of (profile.prestiges ?? []).entries()) {
      if (matches("Upgrade", prestige.id)) add(commander, "prestige", `prestiges[${index}]`);
    }
    addTypedLinks(commander, profile.levelPerks, "levelPerks", "level-perk");
    addTypedLinks(commander, profile.masteries, "masteries", "mastery");
  }
  return bindings.sort((left, right) =>
    left.commanderId.localeCompare(right.commanderId) ||
    left.role.localeCompare(right.role) ||
    left.sourcePath.localeCompare(right.sourcePath));
}

function semanticTargetKinds(database, object, profileBindings) {
  const catalog = object.catalog.toLowerCase();
  const kinds = [];
  if (catalog === "unit") {
    const structure = database.prepare(`
      SELECT value FROM catalog_fields
      WHERE catalog='Unit' AND object_id=? AND path='Attributes[Structure]'
      LIMIT 1
    `).get(object.objectId);
    const isBuilding = structure?.value === "1" ||
      profileBindings.some((binding) => binding.role === "building");
    kinds.push(isBuilding ? "building" : "unit");
  } else {
    kinds.push(SEMANTIC_CATALOG_KINDS.get(catalog) ?? catalog);
  }
  if (profileBindings.some((binding) => binding.role.startsWith("panel-"))) {
    kinds.push("panel");
  }
  return [...new Set(kinds)];
}

function scopeStatusForCommanderIds(commanderIds, requestedScope) {
  if (requestedScope?.kind === "global") return "global";
  if (requestedScope?.kind !== "commander") return "unscoped";
  if (commanderIds.length === 0) return "unresolved";
  const includesRequested = commanderIds.includes(requestedScope.commanderId);
  const includesOutside = commanderIds.some((id) => id !== requestedScope.commanderId);
  if (includesRequested && includesOutside) return "shared";
  if (includesOutside) return "outside";
  return "requested-commander";
}

function semanticIncomingRole(targetKinds, edge) {
  const sourceCatalog = edge.source.catalog.toLowerCase();
  const relation = edge.relation;
  const primaryKind = targetKinds[0];
  if (primaryKind === "ability") {
    if (sourceCatalog === "unit" && relation === "uses_ability") return "unit-holder";
    if (["commander", "user"].includes(sourceCatalog)) return "commander-entry";
    if (sourceCatalog === "requirement") return "requirement-gate";
    if (sourceCatalog === "button") return "command-ui";
  }
  if (primaryKind === "effect") {
    if (sourceCatalog === "abil") return "ability-entry";
    if (sourceCatalog === "weapon") return "weapon-entry";
    if (sourceCatalog === "behavior") return "behavior-trigger";
    if (sourceCatalog === "effect") return "effect-chain";
    if (sourceCatalog === "actor") return "visual-response";
  }
  if (primaryKind === "behavior") {
    if (sourceCatalog === "effect" && relation === "applies_behavior") return "effect-applier";
    if (sourceCatalog === "unit") return "unit-holder";
    if (sourceCatalog === "abil") return "ability-entry";
    if (sourceCatalog === "behavior") return "behavior-chain";
    if (sourceCatalog === "upgrade") return "upgrade-modifier";
  }
  if (primaryKind === "weapon") {
    if (sourceCatalog === "unit" && relation === "uses_weapon") return "unit-holder";
    if (sourceCatalog === "behavior") return "behavior-modifier";
    if (sourceCatalog === "upgrade") return "upgrade-modifier";
  }
  if (primaryKind === "upgrade") {
    if (relation === "researches_upgrade") return "research-entry";
    if (relation === "uses_upgrade" && sourceCatalog === "abil") return "ability-upgrade-reference";
    if (relation === "checks_upgrade" || sourceCatalog === "requirement") return "requirement-gate";
    if (["commander", "user"].includes(sourceCatalog)) return "commander-progression";
    if (sourceCatalog === "upgrade") return "upgrade-chain";
  }
  if (primaryKind === "building") {
    if (relationshipFamily(relation) === "creation") return "creation-entry";
    if (sourceCatalog === "requirement") return "requirement-gate";
    if (["actor", "skin", "skinpack"].includes(sourceCatalog)) return "visual-presentation";
    if (sourceCatalog === "upgrade") return "upgrade-modifier";
  }
  const family = relationshipFamily(relation);
  return family === "other" ? "other-consumer" : `${family}-consumer`;
}

function semanticDependencyRole(targetKinds, edge) {
  const targetCatalog = edge.target.catalog.toLowerCase();
  const relation = edge.relation;
  const primaryKind = targetKinds[0];
  if (primaryKind === "ability") {
    if (targetCatalog === "effect") return "effect-root";
    if (targetCatalog === "unit" && relationshipFamily(relation) === "creation") return "created-unit";
    if (targetCatalog === "upgrade") return relation === "researches_upgrade" ? "researched-upgrade" : "upgrade";
    if (targetCatalog === "requirement") return "requirement-gate";
    if (targetCatalog === "validator") return "validator-gate";
    if (targetCatalog === "button") return "command-ui";
    if (targetCatalog === "behavior") return "behavior";
  }
  if (primaryKind === "effect") {
    if (targetCatalog === "effect") return "child-effect";
    if (targetCatalog === "behavior") return "applied-behavior";
    if (targetCatalog === "validator") return "validator-gate";
    if (targetCatalog === "unit") {
      return relationshipFamily(relation) === "creation" ? "created-unit" : "target-unit";
    }
  }
  if (primaryKind === "behavior") {
    if (targetCatalog === "effect") return "trigger-effect";
    if (targetCatalog === "behavior") return "chained-behavior";
    if (targetCatalog === "validator") return "validator-gate";
    if (targetCatalog === "weapon") return "combat-dependency";
    if (targetCatalog === "unit") return "affected-unit";
  }
  if (primaryKind === "weapon") {
    if (targetCatalog === "effect") return "damage-effect";
    if (targetCatalog === "validator") return "target-validator";
    if (targetCatalog === "behavior") return "on-hit-behavior";
  }
  if (primaryKind === "upgrade") {
    if (["unit", "abil", "weapon", "effect", "behavior"].includes(targetCatalog)) {
      return `modified-${SEMANTIC_CATALOG_KINDS.get(targetCatalog) ?? targetCatalog}`;
    }
    if (targetCatalog === "requirement") return "requirement-gate";
    if (targetCatalog === "validator") return "validator-gate";
  }
  if (primaryKind === "building") {
    if (targetCatalog === "abil") return "unit-ability";
    if (targetCatalog === "weapon") return "unit-weapon";
    if (targetCatalog === "behavior") return "unit-behavior";
    if (targetCatalog === "requirement") return "requirement-gate";
    if (targetCatalog === "unit" && relationshipFamily(relation) === "creation") return "produced-unit";
  }
  return `${SEMANTIC_CATALOG_KINDS.get(targetCatalog) ?? targetCatalog}-dependency`;
}

function semanticEntrypointRole(targetKinds, role) {
  const primaryKind = targetKinds[0];
  const roles = {
    ability: new Set(["unit-holder", "commander-entry"]),
    effect: new Set(["ability-entry", "weapon-entry", "behavior-trigger", "effect-chain"]),
    behavior: new Set(["effect-applier", "unit-holder", "ability-entry", "behavior-chain"]),
    weapon: new Set(["unit-holder"]),
    upgrade: new Set(["research-entry", "commander-progression"]),
    building: new Set(["creation-entry"]),
  };
  return roles[primaryKind]?.has(role) ?? false;
}

function groupSemanticReferences(edges, { direction, targetKinds, nodeMemberships, requestedScope }) {
  const groups = new Map();
  for (const edge of edges) {
    const endpoint = direction === "incoming" ? edge.source : edge.target;
    const role = direction === "incoming"
      ? semanticIncomingRole(targetKinds, edge)
      : semanticDependencyRole(targetKinds, edge);
    const key = `${role}/${catalogNodeKey(endpoint.catalog, endpoint.objectId)}`;
    let item = groups.get(key);
    if (!item) {
      const memberships = nodeMemberships(endpoint.catalog, endpoint.objectId);
      const commanderIds = [...new Set(memberships.map((row) => row.commanderId))]
        .sort((left, right) => left.localeCompare(right));
      item = {
        role,
        [direction === "incoming" ? "source" : "target"]: endpoint,
        commanderIds,
        scopeStatus: scopeStatusForCommanderIds(commanderIds, requestedScope),
        paths: [],
      };
      groups.set(key, item);
    }
    item.paths.push({
      path: edge.fieldPath,
      relation: edge.relation,
      confidence: edge.confidence,
      evidence: edge.evidence,
      patchable: !/\[#\d+\]/.test(edge.fieldPath),
    });
  }
  const groupedByRole = new Map();
  for (const item of groups.values()) {
    item.paths.sort((left, right) =>
      relationshipPriority(right.relation) - relationshipPriority(left.relation) ||
      left.path.localeCompare(right.path));
    const roleItems = groupedByRole.get(item.role) ?? [];
    roleItems.push(item);
    groupedByRole.set(item.role, roleItems);
  }
  return [...groupedByRole.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([role, items]) => ({
      role,
      itemCount: items.length,
      items: items.sort((left, right) => {
        const leftEndpoint = left.source ?? left.target;
        const rightEndpoint = right.source ?? right.target;
        return leftEndpoint.catalog.localeCompare(rightEndpoint.catalog) ||
          leftEndpoint.objectId.localeCompare(rightEndpoint.objectId);
      }),
    }));
}

function profileBindingEntrypoints(profileBindings, requestedScope) {
  const byRole = new Map();
  for (const binding of profileBindings.filter((item) =>
    item.role === "building" || item.role.startsWith("panel-"))) {
    const role = binding.role === "building" ? "commander-roster" : binding.role;
    const items = byRole.get(role) ?? [];
    items.push({
      role,
      source: { catalog: "Commander", objectId: binding.commanderObjectId },
      commanderIds: [binding.commanderId],
      scopeStatus: scopeStatusForCommanderIds([binding.commanderId], requestedScope),
      paths: [{
        path: binding.sourcePath,
        relation: "profile_binding",
        confidence: 1,
        evidence: "commander-profile",
        patchable: false,
      }],
    });
    byRole.set(role, items);
  }
  return [...byRole.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([role, items]) => ({
      role,
      itemCount: items.length,
      items: items.sort((left, right) => left.source.objectId.localeCompare(right.source.objectId)),
    }));
}

function mergeSemanticGroups(...collections) {
  const groups = new Map();
  for (const collection of collections) {
    for (const group of collection) {
      const items = groups.get(group.role) ?? [];
      items.push(...group.items);
      groups.set(group.role, items);
    }
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([role, items]) => ({ role, itemCount: items.length, items }));
}

function semanticOwnerSummary(targetMemberships, profileBindings) {
  const commanderIds = [...new Set([
    ...targetMemberships.map((row) => row.commanderId),
    ...profileBindings.map((binding) => binding.commanderId),
  ])].sort((left, right) => left.localeCompare(right));
  let classification = "unresolved";
  if (commanderIds.length > 1) classification = "shared-across-commanders";
  else if (profileBindings.length > 0) classification = "profile-bound";
  else if (commanderIds.length === 1) classification = "commander-associated";
  return {
    classification,
    commanderIds,
    memberships: targetMemberships,
    profileBindings,
    note: "Commander membership and profile bindings are association evidence, not proof that enemy or Galaxy usage is absent.",
  };
}

function semanticSharingStatus(commanderIds, hasUnownedConsumers, requestedScope) {
  if (requestedScope?.kind === "global") return "global-shared";
  if (requestedScope?.kind === "commander") {
    if (commanderIds.some((id) => id !== requestedScope.commanderId)) return "outside-commander";
    if (hasUnownedConsumers) return "unresolved-consumers";
    return "requested-commander-only";
  }
  if (commanderIds.length > 1) return "cross-commander";
  if (hasUnownedConsumers) return "unresolved-consumers";
  return "shared-unscoped";
}

function analyzeSharedDependencies({
  database,
  start,
  directDependencies,
  membershipRowsFor,
  requestedScope,
  dependencyLimit = 16,
  perDependencyLimit = 4,
}) {
  const consumerCount = database.prepare(`
    SELECT count(*) AS count
    FROM object_references
    WHERE target_catalog=? AND target_object_id=?
      AND NOT (source_catalog=? AND source_object_id=?)
  `);
  const otherConsumers = database.prepare(`
    SELECT r.source_catalog AS sourceCatalog, r.source_object_id AS sourceObjectId,
           r.field_path AS fieldPath, r.confidence, r.evidence,
           o.class AS sourceClass
    FROM object_references r
    JOIN catalog_objects o
      ON o.catalog=r.source_catalog AND o.object_id=r.source_object_id
    WHERE r.target_catalog=? AND r.target_object_id=?
      AND NOT (r.source_catalog=? AND r.source_object_id=?)
    ORDER BY r.confidence DESC, r.source_catalog, r.source_object_id, r.field_path
    LIMIT ?
  `);
  const consumerCommanders = database.prepare(`
    SELECT DISTINCT m.commander_id AS commanderId
    FROM object_references r
    JOIN commander_membership m
      ON m.catalog=r.source_catalog AND m.object_id=r.source_object_id
    WHERE r.target_catalog=? AND r.target_object_id=?
      AND NOT (r.source_catalog=? AND r.source_object_id=?)
    ORDER BY m.commander_id
  `);
  const unownedConsumer = database.prepare(`
    SELECT 1 AS found
    FROM object_references r
    LEFT JOIN commander_membership m
      ON m.catalog=r.source_catalog AND m.object_id=r.source_object_id
    WHERE r.target_catalog=? AND r.target_object_id=?
      AND NOT (r.source_catalog=? AND r.source_object_id=?)
      AND m.commander_id IS NULL
    LIMIT 1
  `);
  const dependencyMap = new Map();
  for (const edge of directDependencies) {
    const key = catalogNodeKey(edge.target.catalog, edge.target.objectId);
    let dependency = dependencyMap.get(key);
    if (!dependency) {
      dependency = {
        dependency: edge.target,
        roles: new Set(),
        paths: [],
      };
      dependencyMap.set(key, dependency);
    }
    dependency.roles.add(edge.semanticRole);
    dependency.paths.push({ path: edge.fieldPath, relation: edge.relation });
  }

  const candidates = [];
  for (const dependency of dependencyMap.values()) {
    const total = Number(consumerCount.get(
      dependency.dependency.catalog,
      dependency.dependency.objectId,
      start.catalog,
      start.objectId,
    )?.count ?? 0);
    const dependencyMemberships = membershipRowsFor(
      dependency.dependency.catalog,
      dependency.dependency.objectId,
    );
    const dependencyCommanderIds = [...new Set(dependencyMemberships.map((row) => row.commanderId))]
      .sort((left, right) => left.localeCompare(right));
    if (total === 0 && dependencyCommanderIds.length < 2) continue;
    const consumerCommanderIds = rowsToPlain(consumerCommanders.all(
      dependency.dependency.catalog,
      dependency.dependency.objectId,
      start.catalog,
      start.objectId,
    )).map((row) => row.commanderId);
    const hasUnownedConsumers = Boolean(unownedConsumer.get(
      dependency.dependency.catalog,
      dependency.dependency.objectId,
      start.catalog,
      start.objectId,
    ));
    const allCommanderIds = [...new Set([...dependencyCommanderIds, ...consumerCommanderIds])]
      .sort((left, right) => left.localeCompare(right));
    candidates.push({
      ...dependency,
      dependencyCommanderIds,
      otherConsumerCount: total,
      sharingStatus: semanticSharingStatus(allCommanderIds, hasUnownedConsumers, requestedScope),
    });
  }
  const sharingPriority = {
    "outside-commander": 5,
    "cross-commander": 5,
    "unresolved-consumers": 4,
    "global-shared": 3,
    "requested-commander-only": 2,
    "shared-unscoped": 1,
  };
  candidates.sort((left, right) =>
    (sharingPriority[right.sharingStatus] ?? 0) - (sharingPriority[left.sharingStatus] ?? 0) ||
    right.otherConsumerCount - left.otherConsumerCount ||
    left.dependency.catalog.localeCompare(right.dependency.catalog) ||
    left.dependency.objectId.localeCompare(right.dependency.objectId));

  const shared = [];
  for (const dependency of candidates.slice(0, dependencyLimit)) {
    const rows = rowsToPlain(otherConsumers.all(
      dependency.dependency.catalog,
      dependency.dependency.objectId,
      start.catalog,
      start.objectId,
      perDependencyLimit + 1,
    ));
    const returnedRows = rows.slice(0, perDependencyLimit);
    const consumers = returnedRows.map((row) => {
      const memberships = membershipRowsFor(row.sourceCatalog, row.sourceObjectId);
      const commanderIds = [...new Set(memberships.map((item) => item.commanderId))]
        .sort((left, right) => left.localeCompare(right));
      return {
        source: { catalog: row.sourceCatalog, objectId: row.sourceObjectId },
        fieldPath: row.fieldPath,
        relation: relationshipKind({
          sourceCatalog: row.sourceCatalog,
          targetCatalog: dependency.dependency.catalog,
          sourceClass: row.sourceClass,
          fieldPath: row.fieldPath,
        }),
        confidence: row.confidence,
        evidence: row.evidence,
        commanderIds,
        scopeStatus: scopeStatusForCommanderIds(commanderIds, requestedScope),
      };
    });
    shared.push({
      dependency: dependency.dependency,
      roles: [...dependency.roles].sort((left, right) => left.localeCompare(right)),
      paths: dependency.paths.sort((left, right) => left.path.localeCompare(right.path)),
      dependencyCommanderIds: dependency.dependencyCommanderIds,
      otherConsumerCount: dependency.otherConsumerCount,
      sharingEvidence: {
        explicitOtherConsumers: dependency.otherConsumerCount > 0,
        sharedCommanderMembership: dependency.dependencyCommanderIds.length > 1,
      },
      consumers,
      consumersTruncated: rows.length > perDependencyLimit,
      sharingStatus: dependency.sharingStatus,
    });
  }
  return {
    totalCount: candidates.length,
    returnedCount: shared.length,
    items: shared,
    truncated: candidates.length > dependencyLimit || shared.some((item) => item.consumersTruncated),
  };
}

function isolationPlan({
  requestedScope,
  owner,
  changeType,
  start,
  edges,
  nodes,
  nodeMemberships,
  truncated,
  inspectEdit,
  targetEdit,
  targetPath,
  localObject,
}) {
  if (!requestedScope) {
    return {
      requestedScope: null,
      owner,
      changeType,
      evidenceStatus: "scope-not-declared",
      recommendedStrategy: "declare-scope",
      completeness: truncated ? "bounded-truncated" : "bounded-complete",
      warnings: ["Declare a commander or global scope before treating this result as an isolation plan."],
    };
  }
  if (requestedScope.kind === "global") {
    return {
      requestedScope,
      owner,
      changeType,
      evidenceStatus: "global-explicit",
      recommendedStrategy: "global",
      completeness: truncated ? "bounded-truncated" : "bounded-complete",
      ownerPaths: [],
      cloneCandidates: [],
      rewireCandidates: [],
      outsideScopeConsumers: [],
      warnings: ["Global scope intentionally permits every Catalog consumer to observe the change."],
    };
  }

  const authoringRoute = commanderEditRoute({ scope: requestedScope, catalog: start.catalog,
    objectId: start.objectId, className: start.class, path: targetPath,
    value: targetEdit?.coreCatalog?.value, changeType,
    existingScopedEdit: Boolean(targetEdit?.commanderPatch), localObject });
  const useUpgrade = authoringRoute.strategy === 'player-upgrade';
  const ownerKey = owner ? catalogNodeKey(owner.catalog, owner.objectId) : null;
  const existingLocalOwner = localObject && (!owner || ownerKey === catalogNodeKey(start.catalog, start.objectId));
  const outsideScopeConsumers = [];
  for (const node of nodes.values()) {
    if (node.distance === 0 || catalogNodeKey(node.catalog, node.objectId) === ownerKey) continue;
    const memberships = nodeMemberships.get(catalogNodeKey(node.catalog, node.objectId)) ?? [];
    const commanderIds = [...new Set(memberships.map((row) => row.commanderId))].sort();
    const outsideCommanders = commanderIds.filter((id) => id !== requestedScope.commanderId);
    if (outsideCommanders.length > 0) {
      outsideScopeConsumers.push({
        catalog: node.catalog,
        objectId: node.objectId,
        distance: node.distance,
        certainty: "proven",
        commanderIds: outsideCommanders,
      });
    } else if (commanderIds.length === 0) {
      outsideScopeConsumers.push({
        catalog: node.catalog,
        objectId: node.objectId,
        distance: node.distance,
        certainty: "possible",
        commanderIds: [],
      });
    }
  }
  outsideScopeConsumers.sort((left, right) =>
    left.distance - right.distance ||
    left.catalog.localeCompare(right.catalog) ||
    left.objectId.localeCompare(right.objectId));

  const provenLeak = outsideScopeConsumers.some((consumer) => consumer.certainty === "proven");
  const possibleLeak = outsideScopeConsumers.some((consumer) => consumer.certainty === "possible");
  const ownerPaths = owner ? catalogPaths(edges, owner, start) : [];
  const selectedPath = ownerPaths[0] ?? [];
  const pathNodes = selectedPath.length > 0
    ? [selectedPath[0].source, ...selectedPath.map((edge) => edge.target)]
    : owner && catalogNodeKey(owner.catalog, owner.objectId) === catalogNodeKey(start.catalog, start.objectId)
      ? [owner]
      : [];
  const cloneCandidates = [];
  const cloneByKey = new Map();
  if (!useUpgrade && !existingLocalOwner) {
    for (const node of pathNodes) {
      const key = catalogNodeKey(node.catalog, node.objectId);
      if (cloneByKey.has(key)) continue;
      const candidate = {
        catalog: node.catalog,
        sourceObjectId: node.objectId,
        suggestedObjectId: privateCatalogId(requestedScope.commanderId, node.objectId),
        reason: key === ownerKey ? "private-owner" : "private-dependency-chain",
      };
      cloneByKey.set(key, candidate);
      cloneCandidates.push(candidate);
    }
  }
  const dependencyRewires = (useUpgrade || existingLocalOwner ? [] : selectedPath).map((edge) => {
    const sourceClone = cloneByKey.get(catalogNodeKey(edge.source.catalog, edge.source.objectId));
    const targetClone = cloneByKey.get(catalogNodeKey(edge.target.catalog, edge.target.objectId));
    const edit = inspectEdit(edge.source.catalog, edge.source.objectId, edge.fieldPath).catalogEdit;
    const patchable = edit.available && edit.expect === edge.target.objectId;
    return {
      catalog: edge.source.catalog,
      objectId: sourceClone?.suggestedObjectId ?? edge.source.objectId,
      path: edit.operation.path,
      ...(patchable ? { expect: edit.expect } : {}),
      patchable,
      ...(!patchable ? { reason: edit.reason ?? 'reference-value-mismatch' } : {}),
      suggestedValue: targetClone?.suggestedObjectId ?? edge.target.objectId,
      relation: edge.relation,
    };
  });
  const ownerClone = owner ? cloneByKey.get(ownerKey) : null;
  const ownerEntrypoints = useUpgrade
    ? null
    : analyzeOwnerEntrypoints({
        owner,
        edges,
        nodeMemberships,
        requestedScope,
        suggestedOwnerId: ownerClone?.suggestedObjectId ?? owner?.objectId,
        truncated,
        inspectEdit,
      });
  const rewireCandidates = [];
  const seenRewires = new Set();
  for (const candidate of [
    ...dependencyRewires,
    ...(ownerEntrypoints?.creationRewires ?? []),
  ]) {
    const key = `${candidate.catalog}/${candidate.objectId}/${candidate.path}`.toLowerCase();
    if (seenRewires.has(key)) continue;
    seenRewires.add(key);
    rewireCandidates.push(candidate);
  }

  let recommendedStrategy;
  if (useUpgrade) recommendedStrategy = "player-upgrade";
  else if (existingLocalOwner) recommendedStrategy = "inspect-existing-private";
  else if (!owner) recommendedStrategy = "owner-required";
  else if (pathNodes.length === 0) recommendedStrategy = "inspect-owner-path";
  else recommendedStrategy = "private-clone";

  return {
    requestedScope,
    owner,
    changeType,
    evidenceStatus: provenLeak
      ? "proven-leak"
      : possibleLeak || truncated
        ? "possible-leak"
        : "bounded-no-proven-leak",
    recommendedStrategy,
    authoringRoute,
    completeness: truncated ? "bounded-truncated" : "bounded-complete",
    ownerPaths: ownerPaths.map((steps) => ({
      nodes: steps.length > 0
        ? [steps[0].source, ...steps.map((edge) => edge.target)]
        : [owner],
      steps: steps.map((edge) => ({
        source: edge.source,
        fieldPath: edge.fieldPath,
        relation: edge.relation,
        target: edge.target,
        confidence: edge.confidence,
      })),
    })),
    cloneCandidates,
    rewireCandidates,
    ...(ownerEntrypoints ? { ownerEntrypoints } : {}),
    outsideScopeConsumers,
    warnings: [
      "This is a bounded Catalog isolation plan, not proof about Galaxy, enemy compositions, or engine-default references.",
      ...(useUpgrade
        ? ["Upgrade shortcut applies to this exact scalar Set target, not to a larger mechanism change."]
        : []),
      ...(owner && pathNodes.length === 0
        ? ["No bounded reference path from the declared owner to the target was found; do not invent rewires."]
        : []),
    ],
  };
}

function relationshipKind(reference) {
  const sourceCatalog = reference.sourceCatalog.toLowerCase();
  const targetCatalog = reference.targetCatalog.toLowerCase();
  const sourceClass = (reference.sourceClass ?? "").toLowerCase();
  const fieldPath = reference.fieldPath.toLowerCase();

  if (sourceCatalog === "unit" && targetCatalog === "abil") return "uses_ability";
  if (sourceCatalog === "unit" && targetCatalog === "weapon") return "uses_weapon";
  if (sourceCatalog === "abil" && targetCatalog === "unit") {
    if (sourceClass.includes("train")) return "trains";
    if (sourceClass.includes("build")) return "builds";
    if (sourceClass.includes("morph")) return "morphs_into";
    if (sourceClass.includes("revive") || fieldPath.includes("revive")) return "revives";
    return "creates_unit";
  }
  if (sourceCatalog === "effect" && targetCatalog === "unit") {
    if (fieldPath.includes("spawnunit") || fieldPath.includes("createunit")) return "creates_unit";
    return "creates_or_targets_unit";
  }
  if (sourceCatalog === "unit" && targetCatalog === "unit" && fieldPath.includes("producedunit")) {
    return "produces_unit";
  }
  if (targetCatalog === "unit" && fieldPath.includes("startingunit")) return "starting_unit";
  if (sourceCatalog === "abil" && targetCatalog === "upgrade") {
    if (sourceClass.includes("research") || fieldPath.includes("upgrade")) return "researches_upgrade";
    return "uses_upgrade";
  }
  if (sourceCatalog === "requirement" && targetCatalog === "upgrade") return "checks_upgrade";
  if (["commander", "user"].includes(sourceCatalog) && targetCatalog === "upgrade") {
    return "grants_upgrade";
  }
  if (["abil", "weapon", "behavior"].includes(sourceCatalog) && targetCatalog === "effect") {
    return "runs_effect";
  }
  if (sourceCatalog === "effect" && targetCatalog === "effect") return "runs_effect";
  if (sourceCatalog === "effect" && targetCatalog === "behavior") return "applies_behavior";
  if (targetCatalog === "behavior") return "uses_behavior";
  if (targetCatalog === "validator") return "uses_validator";
  if (targetCatalog === "requirement") return "uses_requirement";
  if (targetCatalog === "button") return "uses_button";
  if (sourceCatalog === "upgrade") return "upgrade_affects";
  if (sourceCatalog === "actor" && targetCatalog === "model") return "uses_model";
  if (sourceCatalog === "actor" && targetCatalog === "unit") return "visualizes_unit";
  if (["skin", "skinpack"].includes(sourceCatalog) && targetCatalog === "unit") return "skins_unit";
  return "references";
}

function relationshipFamily(kind) {
  if ([
    "trains",
    "builds",
    "morphs_into",
    "revives",
    "creates_unit",
    "creates_or_targets_unit",
    "produces_unit",
    "starting_unit",
  ].includes(kind)) return "creation";
  if (["uses_ability", "runs_effect", "uses_button", "uses_requirement"].includes(kind)) return "abilities";
  if (kind === "uses_weapon") return "combat";
  if (["applies_behavior", "uses_behavior", "uses_validator"].includes(kind)) return "behaviors";
  if (["researches_upgrade", "uses_upgrade", "checks_upgrade", "grants_upgrade", "upgrade_affects"].includes(kind)) {
    return "upgrades";
  }
  if (["uses_model", "visualizes_unit", "skins_unit"].includes(kind)) return "visuals";
  return "other";
}

function relationshipAllowed(kind, requestedFamily) {
  if (requestedFamily === "all") return true;
  const family = relationshipFamily(kind);
  if (family === requestedFamily) return true;
  if (requestedFamily === "creation") {
    return ["uses_ability", "runs_effect", "applies_behavior"].includes(kind);
  }
  if (requestedFamily === "combat") {
    return ["runs_effect", "applies_behavior", "uses_behavior"].includes(kind);
  }
  if (requestedFamily === "abilities") {
    return ["applies_behavior", "uses_behavior", "uses_validator", "creates_or_targets_unit"].includes(kind);
  }
  return false;
}

function relationshipPriority(kind) {
  const order = {
    trains: 100,
    builds: 100,
    morphs_into: 100,
    revives: 100,
    creates_unit: 95,
    produces_unit: 92,
    starting_unit: 90,
    uses_ability: 88,
    uses_weapon: 88,
    runs_effect: 84,
    applies_behavior: 82,
    uses_behavior: 80,
    uses_validator: 76,
    uses_requirement: 76,
    researches_upgrade: 75,
    grants_upgrade: 74,
    checks_upgrade: 73,
    uses_upgrade: 72,
    upgrade_affects: 70,
    creates_or_targets_unit: 65,
    uses_button: 50,
    visualizes_unit: 45,
    uses_model: 45,
    skins_unit: 30,
    references: 10,
  };
  return order[kind] ?? 0;
}

function referenceContextPrefix(fieldPath) {
  const separator = fieldPath.lastIndexOf(".");
  return separator > 0 ? fieldPath.slice(0, separator) : fieldPath;
}

function escapeLike(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function canonicalCatalogPath(value) {
  return String(value)
    .trim()
    .replaceAll(".@", ".")
    .replace(/\[#(\d+)\]/g, "[$1]")
    .toLowerCase();
}

function scalarValue(value) {
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function projectUnitArrays(database, catalog, objectId) {
  if (String(catalog).toLowerCase() !== "unit") return null;
  const fields = rowsToPlain(database.prepare(`
    SELECT path, value, source_file AS sourceFile, origin_object_id AS originObjectId,
           inheritance_depth AS inheritanceDepth
    FROM catalog_fields
    WHERE catalog=? AND object_id=?
      AND (lower(path) LIKE 'abilarray%' OR lower(path) LIKE 'cardlayouts%layoutbuttons%')
    ORDER BY path
  `).all(catalog, objectId));
  return projectUnitArrayFields(fields);
}

function galaxyFunctionBody(contents, line, maxCharacters = 12_000) {
  const source=String(contents??'').replaceAll('\r\n','\n'), lines=source.split('\n');
  const start=Math.max(0,Number(line)-1); let depth=0,opened=false,inBlock=false,inString=false,end=start;
  if(!lines[start]?.includes('{'))return null;
  for(let row=start;row<lines.length;row++) {
    const value=lines[row]; let lineComment=false;
    for(let i=0;i<value.length;i++) {
      const c=value[i],n=value[i+1];
      if(lineComment)break;
      if(inBlock){if(c==='*'&&n==='/'){inBlock=false;i++;}continue;}
      if(inString){if(c==='\\'){i++;continue;}if(c==='"')inString=false;continue;}
      if(c==='/'&&n==='*'){inBlock=true;i++;continue;}
      if(c==='/'&&n==='/'){lineComment=true;continue;}
      if(c==='"'){inString=true;continue;}
      if(c==='{'){opened=true;depth++;}else if(c==='}'&&opened&&--depth===0){end=row;row=lines.length;break;}
    }
    if(row<lines.length)end=row;
  }
  let text=lines.slice(start,end+1).map((value,index)=>`${start+index+1}: ${value}`).join('\n');
  const truncated=!opened||depth!==0||text.length>maxCharacters;
  if(text.length>maxCharacters)text=`${text.slice(0,maxCharacters)}\n…`;
  return {startLine:start+1,endLine:end+1,text,truncated,complete:opened&&depth===0&&!truncated};
}

function localizedNameParts(value) {
  return String(value ?? "")
    .split(/\s*\/{3}\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function targetTouchesCatalogQuery(target, query) {
  const parts = target.split("/");
  let catalog;
  let objectId;
  let fieldPath;
  let targetCommanderId = null;
  if (parts[0]?.toLowerCase() === "catalog") {
    [, catalog, objectId] = parts;
    fieldPath = parts.slice(3).join("/");
  } else if (parts[0]?.toLowerCase() === "commander" && parts[2]?.toLowerCase() === "stat") {
    targetCommanderId = parts[1];
    catalog = parts[3];
    objectId = parts[4];
    fieldPath = parts.slice(5).join("/");
  } else {
    return false;
  }
  if (query.commanderId && String(targetCommanderId ?? "").toLowerCase() !== query.commanderId) return false;
  if (query.catalog && String(catalog).toLowerCase() !== query.catalog) return false;
  if (query.objectId && String(objectId).toLowerCase() !== query.objectId) return false;
  if (!query.path) return true;
  const canonicalPath = canonicalCatalogPath(fieldPath);
  return canonicalPath === query.path ||
    canonicalPath.startsWith(`${query.path}.`) ||
    query.path.startsWith(`${canonicalPath}.`);
}

function catalogCoordinatesForTarget(target) {
  const parts = String(target).split("/");
  if (parts[0]?.toLowerCase() === "catalog" && parts.length >= 3) {
    return { catalog: parts[1], objectId: parts[2], path: parts.slice(3).join("/") };
  }
  if (parts[0]?.toLowerCase() === "commander" && parts[2]?.toLowerCase() === "stat" && parts.length >= 5) {
    return { catalog: parts[3], objectId: parts[4], path: parts.slice(5).join("/") };
  }
  return null;
}

function targetsSemanticallyOverlap(left, right) {
  const leftCatalog = catalogCoordinatesForTarget(left);
  const rightCatalog = catalogCoordinatesForTarget(right);
  if (!leftCatalog || !rightCatalog) return false;
  const asCatalogTarget = (value) =>
    `catalog/${value.catalog}/${value.objectId}${value.path ? `/${value.path}` : ""}`;
  return targetsConflict(asCatalogTarget(leftCatalog), asCatalogTarget(rightCatalog));
}

function operationTouchesCatalogTarget(operation, query) {
  if (query.commanderId && String(operation.commanderId ?? "").toLowerCase() !== query.commanderId) {
    return false;
  }
  return operationTargets(operation).some((target) => targetTouchesCatalogQuery(target, {
    ...query,
    commanderId: null,
  }));
}

function unitOwnershipRelationship(source, rosterKind) {
  if (source === "PlayerCommanders.HeroUnit") return "hero";
  if (source === "PlayerCommanders.HeroReviveUnit") return "hero_revive";
  if (source === "PlayerCommanders.HeroStructure") return "hero_structure";
  return rosterKind === "buildings" ? "roster_building" : "roster_unit";
}

function normalizeCommanderName(value) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\p{P}\p{S}\s_]+/gu, "");
}

function levenshteinDistance(left, right) {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        substitution,
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function commanderMatchTerms(commander) {
  const terms = [
    { matchedBy: "commanderId", matchedText: commander.id, exactScore: 1 },
    { matchedBy: "commanderObjectId", matchedText: commander.commanderObjectId, exactScore: 0.99 },
  ];
  for (const [field, value] of [["nameZhCN", commander.nameZhCN], ["nameEnUS", commander.nameEnUS]]) {
    if (!value) continue;
    for (const part of value.split(/\s*\/{3}\s*/).filter(Boolean)) {
      terms.push({ matchedBy: field, matchedText: part, exactScore: 0.98 });
    }
  }
  for (const alias of commander.aliases) {
    terms.push({ matchedBy: "alias", matchedText: alias, exactScore: 0.97 });
  }
  return terms;
}

function scoreCommanderTerm(normalizedQuery, term) {
  const normalizedTerm = normalizeCommanderName(term.matchedText);
  if (!normalizedTerm) return null;
  if (normalizedQuery === normalizedTerm) {
    return { ...term, score: term.exactScore, matchType: "exact" };
  }
  const shorterLength = Math.min(normalizedQuery.length, normalizedTerm.length);
  const longerLength = Math.max(normalizedQuery.length, normalizedTerm.length);
  if (normalizedTerm.startsWith(normalizedQuery) || normalizedQuery.startsWith(normalizedTerm)) {
    return {
      ...term,
      score: 0.88 + (shorterLength / longerLength) * 0.04,
      matchType: "prefix",
    };
  }
  if (normalizedTerm.includes(normalizedQuery) || normalizedQuery.includes(normalizedTerm)) {
    return {
      ...term,
      score: 0.8 + (shorterLength / longerLength) * 0.04,
      matchType: "contains",
    };
  }
  if (shorterLength < 2) return null;
  const distance = levenshteinDistance(normalizedQuery, normalizedTerm);
  const isSingleHanTypo =
    distance === 1 &&
    shorterLength >= 3 &&
    /^\p{Script=Han}+$/u.test(normalizedQuery) &&
    /^\p{Script=Han}+$/u.test(normalizedTerm);
  if (isSingleHanTypo) {
    return { ...term, score: 0.9, matchType: "fuzzy" };
  }
  const similarity = 1 - distance / longerLength;
  if (similarity < 0.5) return null;
  return { ...term, score: 0.55 + similarity * 0.3, matchType: "fuzzy" };
}

function bestCommanderMatch(commander, normalizedQuery) {
  const matches = commanderMatchTerms(commander)
    .map((term) => scoreCommanderTerm(normalizedQuery, term))
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.matchedText.localeCompare(right.matchedText));
  if (matches.length === 0) return null;
  const best = matches[0];
  return {
    commanderId: commander.id,
    commanderObjectId: commander.commanderObjectId,
    nameZhCN: commander.nameZhCN,
    nameEnUS: commander.nameEnUS,
    aliases: commander.aliases,
    score: Number(best.score.toFixed(3)),
    matchedBy: best.matchedBy,
    matchedText: best.matchedText,
    matchType: best.matchType,
  };
}

function loadCommanderAliases(file) {
  let data;
  try {
    data = readJson(file);
  } catch (error) {
    throw new CoopSearchError("Unable to load the bundled commander alias data.", {
      file,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (data.schemaVersion !== 1 || !data.commanders || typeof data.commanders !== "object") {
    throw new CoopSearchError("Unsupported commander alias data format.", { file });
  }
  return new Map(
    Object.entries(data.commanders).map(([commanderId, entry]) => {
      if (!entry || !Array.isArray(entry.aliases) || entry.aliases.some((alias) => typeof alias !== "string")) {
        throw new CoopSearchError(`Invalid aliases for commander ${commanderId}.`, { file });
      }
      const aliases = [...new Set(entry.aliases.map((alias) => alias.trim()).filter(Boolean))];
      return [commanderId.toLowerCase(), aliases];
    }),
  );
}

export function createCoopSearch(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const commanderAliases = loadCommanderAliases(
    path.resolve(options.commanderAliasesFile ?? DEFAULT_COMMANDER_ALIASES_FILE),
  );
  const localAppDataDirectory =
    options.localAppDataDirectory ??
    process.env.LOCALAPPDATA ??
    process.env.XDG_DATA_HOME ??
    (process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Local")
      : path.join(os.homedir(), ".local", "share"));

  function locateDatabase() {
    const baseline = readJson(path.join(repoRoot, "game-a", "runtime-baseline.json"));
    const dataBuild = baseline.sc2.dataBuild;
    let databaseFile;
    let source;
    if (options.databaseFile) {
      databaseFile = path.resolve(options.databaseFile);
      source = "configured-database";
    } else if (process.env.COOPAGENT_DATABASE) {
      databaseFile = path.resolve(process.env.COOPAGENT_DATABASE);
      source = "environment-database";
    } else if (process.env.COOPAGENT_CATALOG_ROOT) {
      const catalogRoot = path.resolve(process.env.COOPAGENT_CATALOG_ROOT);
      databaseFile = path.join(path.dirname(path.dirname(catalogRoot)), "coop.sqlite");
      source = "environment-catalog";
    } else {
      databaseFile = path.join(
        localAppDataDirectory,
        "CoopAgent",
        "database",
        dataBuild,
        "coop.sqlite",
      );
      source = "local-database";
    }
    if (!existsSync(databaseFile)) {
      throw new CoopSearchError("The co-op database has not been built for the current Game A SC2 build.", {
        expectedBuild: dataBuild,
        expectedPath: databaseFile,
      });
    }
    return { dataBuild, databaseFile, source };
  }

  let activeProjection = null;
  const timing={};
  function measure(name,read) {
    const start=performance.now();
    try{return read();}finally{const ms=performance.now()-start;const item=timing[name]??={count:0,totalMs:0};item.count++;item.totalMs+=ms;options.onTiming?.({name,ms});}
  }
  const readCache=options.reuseSnapshots?createProjectReadCache({
    limit:options.maxReadSnapshots??3,measure,
    revision:()=>projectReadRevision(repoRoot,locateDatabase().databaseFile),
    open:input=>{
      const location=locateDatabase(),database=new DatabaseSync(location.databaseFile,{readOnly:true,timeout:COOP_DATABASE_BUSY_TIMEOUT_MS});
      try {
        database.exec('PRAGMA temp_store=MEMORY; BEGIN');
        const metadata=Object.fromEntries(database.prepare('SELECT key,value FROM meta').all().map(row=>[row.key,row.value]));
        if(metadata.sc2Build!==location.dataBuild)throw new CoopSearchError('The co-op database build does not match Game A.');
        metadata.engineCatalog=measure('engine-baseline',()=>attachEngineCatalog(database).status);
        const projection=measure('project-projection',()=>attachGameAProjection(database,{repoRoot,commanderId:input.commanderId,prestigeUpgrade:input.prestigeUpgrade}));
        const dataVersion=Number(database.prepare('PRAGMA data_version').get().data_version);
        database.exec('COMMIT');
        return {database,metadata,projection,dataVersion};
      }catch(error){database.close();throw error;}
    },
  }):null;

  function withProjectDatabase(input, handler) {
    if (activeProjection) {
      if (input.prestigeUpgrade !== undefined && input.prestigeUpgrade !== activeProjection.projection.metadata.prestigeUpgrade) {
        throw new CoopSearchError('Cannot change prestige scope inside a current-project snapshot.');
      }
      if (input.commanderId) {
        const commander = activeProjection.database.prepare(
          "SELECT id FROM commanders WHERE lower(id)=lower(?) OR lower(commander_object_id)=lower(?)",
        ).get(input.commanderId, input.commanderId);
        if (commander?.id !== activeProjection.projection.metadata.commanderId) {
          throw new CoopSearchError("Cannot change commander scope inside a current-project snapshot.");
        }
      }
      return handler(activeProjection.database);
    }
    if(readCache)return readGameAConsistently(repoRoot,()=>readCache.read({commanderId:input.commanderId??null,prestigeUpgrade:input.prestigeUpgrade??null},snapshot=>{
      activeProjection=snapshot;
      try{return handler(snapshot.database);}finally{activeProjection=null;}
    }));
    return readGameAConsistently(repoRoot, () => withDatabase((database, metadata) => {
      const projection = measure('project-projection',()=>attachGameAProjection(database, { repoRoot, commanderId: input.commanderId, prestigeUpgrade: input.prestigeUpgrade }));
      activeProjection = { database, metadata, projection };
      try { return measure('query',()=>handler(database)); }
      finally { activeProjection = null; }
    }));
  }

  function withDatabase(handler) {
    if (activeProjection) {
      const { database, metadata, projection } = activeProjection;
      return {
        database: { schemaVersion: Number(metadata.schemaVersion), sc2Build: metadata.sc2Build,
          sc2Version: metadata.sc2Version, source: locateDatabase().source, engineCatalog: metadata.engineCatalog },
        currentProject: projection.metadata,
        ...handler(database, metadata),
      };
    }
    const location = locateDatabase();
    const database = new DatabaseSync(location.databaseFile, { readOnly: true, timeout: COOP_DATABASE_BUSY_TIMEOUT_MS });
    try {
      database.exec("PRAGMA temp_store=MEMORY; PRAGMA query_only = ON");
      database.exec("BEGIN");
      const metadata = Object.fromEntries(
        database.prepare("SELECT key, value FROM meta").all().map((row) => [row.key, row.value]),
      );
      if (metadata.sc2Build !== location.dataBuild) {
        throw new CoopSearchError("The co-op database build does not match Game A.", {
          expectedBuild: location.dataBuild,
          databaseBuild: metadata.sc2Build ?? null,
          databaseFile: location.databaseFile,
        });
      }
      metadata.engineCatalog = attachEngineCatalog(database).status;
      const result = handler(database, metadata);
      return {
        database: {
          schemaVersion: Number(metadata.schemaVersion),
          sc2Build: metadata.sc2Build,
          sc2Version: metadata.sc2Version,
          source: location.source,
          engineCatalog: metadata.engineCatalog,
        },
        ...result,
      };
    } catch (error) {
      if (error.code === "ERR_SQLITE_ERROR" && [5, 6].includes(error.errcode & 0xff)) {
        throw new CoopSearchError("合作数据库暂时被占用（等待上限 2 秒），请稍后重试。", {
          code: "database-busy", databaseFile: location.databaseFile,
          sqliteCode: error.errcode, waitMs: COOP_DATABASE_BUSY_TIMEOUT_MS,
        });
      }
      throw error;
    } finally {
      database.close();
    }
  }

  function status() {
    return withDatabase((database) => ({
      operation: "status",
      counts: {
        catalogObjects: database.prepare("SELECT count(*) AS value FROM catalog_objects").get().value,
        effectiveFields: database.prepare("SELECT count(*) AS value FROM catalog_fields").get().value,
        references: database.prepare("SELECT count(*) AS value FROM object_references").get().value,
        localizedText: database.prepare("SELECT count(*) AS value FROM localized_text").get().value,
        galaxySymbols: database.prepare("SELECT count(*) AS value FROM galaxy_symbols").get().value,
        commanders: database.prepare("SELECT count(*) AS value FROM commanders").get().value,
      },
      integrity: database.prepare("PRAGMA quick_check").get().quick_check,
    }));
  }

  function commanderList(input) {
    const limit = clampLimit(input.limit);
    return withDatabase((database) => {
      const total = database.prepare("SELECT count(*) AS value FROM commanders").get().value;
      const items = rowsToPlain(
        database
          .prepare(`
            SELECT id, commander_object_id AS commanderObjectId, user_reference AS userReference,
                   name_zhcn AS nameZhCN, name_enus AS nameEnUS
            FROM commanders ORDER BY commander_object_id LIMIT ?
          `)
          .all(limit),
      ).map((commander) => ({
        ...commander,
        aliases: commanderAliases.get(commander.id.toLowerCase()) ?? [],
      }));
      return { operation: "commander.list", total, items, truncated: total > items.length };
    });
  }

  function commanderResolve(input) {
    const query = requireString(input, "query");
    const normalizedQuery = normalizeCommanderName(query);
    if (!normalizedQuery) throw new CoopSearchError("query must contain a commander name or identifier.");
    const limit = clampLimit(input.limit ?? 3);
    return withDatabase((database) => {
      const commanders = rowsToPlain(
        database
          .prepare(`
            SELECT id, commander_object_id AS commanderObjectId,
                   name_zhcn AS nameZhCN, name_enus AS nameEnUS
            FROM commanders ORDER BY commander_object_id
          `)
          .all(),
      ).map((commander) => ({
        ...commander,
        aliases: commanderAliases.get(commander.id.toLowerCase()) ?? [],
      }));
      const candidates = commanders
        .map((commander) => bestCommanderMatch(commander, normalizedQuery))
        .filter(Boolean)
        .sort((left, right) => right.score - left.score || left.commanderId.localeCompare(right.commanderId))
        .slice(0, limit);
      const best = candidates[0] ?? null;
      const runnerUp = candidates[1] ?? null;
      const resolved = Boolean(
        best &&
        best.score >= 0.84 &&
        (!runnerUp || best.score - runnerUp.score >= 0.08),
      );
      return {
        operation: "commander.resolve",
        query,
        resolved,
        commanderId: resolved ? best.commanderId : null,
        confidence: best?.score ?? 0,
        candidates,
      };
    });
  }

  function commanderGet(input) {
    const commanderId = requireString(input, "commanderId");
    if(input.topic!==undefined && !['overview',...COMMANDER_SECTIONS].includes(input.topic))throw new CoopSearchError('Unknown commander directory topic.');
    if(['path','fieldPrefix','include','group','commandIndex','direction','maxDepth','relationFamily','includeFields'].some(k=>input[k]!==undefined))throw new CoopSearchError('commander.get selects a directory topic; entity fields and graph options do not apply.');
    const detailLevel = input.detailLevel ?? "overview";
    if (!["overview", "full"].includes(detailLevel)) {
      throw new CoopSearchError("detailLevel must be overview or full.");
    }
    return withDatabase((database) => {
      const commander = database
        .prepare(`
          SELECT id, commander_object_id AS commanderObjectId, user_reference AS userReference,
                 name_key AS nameKey, name_zhcn AS nameZhCN, name_enus AS nameEnUS
          FROM commanders WHERE lower(id)=lower(?) OR lower(commander_object_id)=lower(?)
        `)
        .get(commanderId, commanderId);
      if (!commander) throw new CoopSearchError(`Unknown commander: ${commanderId}`);
      const profileRow = database
        .prepare("SELECT profile_json AS profileJson FROM commander_profiles WHERE commander_id=?")
        .get(commander.id);
      if (!profileRow) {
        throw new CoopSearchError("The commander semantic profile is missing; rebuild the local co-op database.", {
          commanderId: commander.id,
        });
      }
      const profile = JSON.parse(profileRow.profileJson);
      if(input.responseProfile==='scalar-card' && detailLevel!=='full') {
        const officialFacts=readCoopCommanderFacts(database,{commanderId:commander.id,topic:input.topic??'overview',limit:input.limit??15,offset:input.offset??0});
        // Keep old full/UI consumers intact; the agent receives one indexed
        // directory, never the entire profile alongside the same directory.
        if(['missing','stale','not-indexed'].includes(officialFacts.status)) {
          const navigation=commanderNavigation(database,commander.id,profile);
          const section=input.topic;
          return {operation:'commander.get',commander,officialFacts,
            ...(section && navigation[section]?{[section]:navigation[section]}:{}),
            action:'Rebuild the local semantic index for paginated commander navigation.'};
        }
        return {operation:'commander.get',commander,officialFacts};
      }
      const navigation = commanderNavigation(database, commander.id, profile);
      const compactRosterItem = (item) => ({
        catalog: 'Unit', objectId: item.unitId,
        techId: item.techId,
        unitId: item.unitId,
        nameZhCN: item.nameZhCN ?? null,
        nameEnUS: item.nameEnUS ?? null,
        unlockedAtLevel: item.unlockedAtLevel ?? null,
      });
      const result = {
        operation: "commander.get",
        officialFacts: readCoopCommanderFacts(database,{commanderId:commander.id}),
        projection: {
          id: "commander",
          version: 1,
          detailLevel,
        },
        commander: {
          ...commander,
          aliases: commanderAliases.get(commander.id.toLowerCase()) ?? [],
        },
        roster: {
          buildings: profile.roster.buildings
            .filter((item) => item.source === "Commander.UnitArray")
            .map(compactRosterItem),
          units: profile.roster.units.map(compactRosterItem),
        },
        levelPerks: profile.levelPerks.map((perk, index) => ({
          ...navigation.levelPerks[index],
          level: perk.level,
          id: perk.id,
          nameZhCN: perk.nameZhCN ?? null,
          nameEnUS: perk.nameEnUS ?? null,
        })),
        prestiges: profile.prestiges.map((prestige, index) => ({
          ...navigation.prestiges[index],
          index: prestige.index,
          id: prestige.id,
          nameZhCN: prestige.nameZhCN ?? null,
          nameEnUS: prestige.nameEnUS ?? null,
        })),
        masteries: profile.masteries.map((mastery, index) => ({
          ...navigation.masteries[index],
          category: mastery.category,
          id: mastery.id,
          nameZhCN: mastery.nameZhCN ?? null,
          nameEnUS: mastery.nameEnUS ?? null,
        })),
        panel: {
          traits: (profile.panel.traits ?? []).map(trait => ({ ...trait, catalog: 'Button', objectId: trait.buttonId })),
          casterUnit: profile.panel.casterUnit,
          abilityCommands: profile.panel.abilityCommands.map(command => ({ ...command, catalog: 'Abil', objectId: command.abilityId })),
          defaultUpgrades: profile.panel.defaultUpgrades,
        },
      };
      if (detailLevel === "full") {
        result.roster.units = result.roster.units.map((unit) => buildUnitProjection(database, {
          commanderId: commander.id,
          unit,
          includeDetails: true,
        }));
        result.roster.buildings = result.roster.buildings.map((unit) => buildUnitProjection(database, {
          commanderId: commander.id,
          unit,
          includeDetails: false,
        }));
      }
      return result;
    });
  }

  function commandersForUnit(input) {
    const unitId = requireString(input, "unitId");
    return withDatabase((database) => {
      const unit = database
        .prepare(`
          SELECT object_id AS unitId, class, parent_id AS parentId, source_file AS sourceFile
          FROM catalog_objects
          WHERE lower(catalog)='unit' AND lower(object_id)=lower(?)
        `)
        .get(unitId);
      if (!unit) throw new CoopSearchError(`Unknown Unit object: ${unitId}`);

      const localizedName = (locale) => database
        .prepare(`
          SELECT value FROM localized_text
          WHERE lower(locale)=lower(?) AND text_key=?
        `)
        .get(locale, `Unit/Name/${unit.unitId}`)?.value ?? null;

      const membershipRows = rowsToPlain(
        database
          .prepare(`
            SELECT commander_id AS commanderId, evidence, depth
            FROM commander_membership
            WHERE lower(catalog)='unit' AND lower(object_id)=lower(?)
            ORDER BY commander_id, depth, evidence
          `)
          .all(unit.unitId),
      );
      const membershipsByCommander = new Map();
      for (const row of membershipRows) {
        if (!membershipsByCommander.has(row.commanderId)) membershipsByCommander.set(row.commanderId, []);
        membershipsByCommander.get(row.commanderId).push(row);
      }

      const owners = [];
      const profileRows = database
        .prepare(`
          SELECT c.id, c.commander_object_id AS commanderObjectId,
                 c.name_zhcn AS nameZhCN, c.name_enus AS nameEnUS,
                 p.profile_json AS profileJson
          FROM commanders c
          JOIN commander_profiles p ON p.commander_id=c.id
          ORDER BY c.id
        `)
        .all();
      for (const row of profileRows) {
        const profile = JSON.parse(row.profileJson);
        const matches = [];
        for (const rosterKind of ["buildings", "units"]) {
          for (const item of profile.roster?.[rosterKind] ?? []) {
            if (String(item.unitId).toLowerCase() !== unit.unitId.toLowerCase()) continue;
            matches.push({ rosterKind, item });
          }
        }
        if (matches.length === 0) continue;

        const relationships = [...new Set(
          matches.map(({ rosterKind, item }) => unitOwnershipRelationship(item.source, rosterKind)),
        )];
        const evidence = matches.map(({ item }) => ({
          kind: "commander_profile",
          source: item.source ?? "unknown",
          techId: item.techId ?? null,
          unlockedAtLevel: item.unlockedAtLevel ?? null,
        }));
        for (const membership of membershipsByCommander.get(row.id) ?? []) {
          if (membership.depth !== 0) continue;
          evidence.push({
            kind: "commander_membership",
            source: membership.evidence,
            depth: membership.depth,
          });
        }
        owners.push({
          commanderId: row.id,
          commanderObjectId: row.commanderObjectId,
          nameZhCN: row.nameZhCN,
          nameEnUS: row.nameEnUS,
          aliases: commanderAliases.get(row.id.toLowerCase()) ?? [],
          relationships,
          evidence,
        });
      }

      const ownerIds = new Set(owners.map((owner) => owner.commanderId));
      const relatedCommanders = [];
      for (const row of membershipRows) {
        if (ownerIds.has(row.commanderId)) continue;
        let related = relatedCommanders.find((candidate) => candidate.commanderId === row.commanderId);
        if (!related) {
          related = { commanderId: row.commanderId, evidence: [] };
          relatedCommanders.push(related);
        }
        related.evidence.push({ source: row.evidence, depth: row.depth });
      }

      return {
        operation: "commanders_for_unit",
        unit: {
          ...unit,
          nameZhCN: localizedName("zhCN"),
          nameEnUS: localizedName("enUS"),
        },
        ownership: owners.length === 0 ? "unresolved" : owners.length === 1 ? "exclusive" : "shared",
        sharedAcrossCommanders: owners.length > 1,
        ownerCount: owners.length,
        owners,
        relatedCommanders,
      };
    });
  }

  function catalogSearch(input) {
    const query = requireString(input, "query");
    const limit = clampLimit(input.limit);
    return withDatabase((database) => {
      let rows = rowsToPlain(
        database
          .prepare(`
            SELECT kind, key, title, snippet(search_index, 3, '[', ']', '...', 16) AS context
            FROM search_index WHERE search_index MATCH ? LIMIT ?
          `)
          .all(ftsQuery(query), limit + 1),
      );
      if (input.catalog) {
        const prefix = `${input.catalog}/`.toLowerCase();
        rows = rows.filter((row) => row.kind !== "catalog" || row.key.toLowerCase().startsWith(prefix));
      }
      const truncated = rows.length > limit;
      return { operation: "catalog.search", query, items: rows.slice(0, limit), truncated };
    });
  }

  function entityResolve(input) {
    const query = requireString(input, "query");
    const qualified = /^([^/\\]+)[/\\]([^/\\]+)$/.exec(query);
    const catalogFilter = typeof input.catalog === "string" && input.catalog.trim()
      ? input.catalog.trim()
      : qualified?.[1]?.trim() ?? null;
    const objectQuery = qualified ? qualified[2].trim() : query;
    if (qualified && input.catalog && qualified[1].toLowerCase() !== input.catalog.trim().toLowerCase()) {
      throw new CoopSearchError("Qualified entity catalog does not match catalog filter.");
    }
    const normalizedQuery = normalizeCommanderName(objectQuery);
    if (!normalizedQuery) throw new CoopSearchError("query must contain an entity name or identifier.");
    const limit = clampLimit(input.limit ?? 5);
    const commanderId = typeof input.commanderId === "string" && input.commanderId.trim()
      ? input.commanderId.trim()
      : null;

    return withDatabase((database) => {
      let commander = null;
      if (commanderId) {
        commander = database
          .prepare(`
            SELECT id AS commanderId, commander_object_id AS commanderObjectId,
                   name_zhcn AS nameZhCN, name_enus AS nameEnUS
            FROM commanders WHERE lower(id)=lower(?) OR lower(commander_object_id)=lower(?)
          `)
          .get(commanderId, commanderId);
        if (!commander) throw new CoopSearchError(`Unknown commander: ${commanderId}`);
      }

      const candidates = new Map();
      const readObject = database.prepare(`
        SELECT catalog, object_id AS objectId, class, parent_id AS parentId,
               source_file AS sourceFile
        FROM catalog_objects
        WHERE catalog=? AND object_id=?
      `);
      const namesForObject = database.prepare(`
        SELECT t.locale, t.value
        FROM localized_text t
        WHERE t.text_key=(
          SELECT replace(f.value, '##id##', f.object_id)
          FROM catalog_fields f
          WHERE f.catalog=? AND f.object_id=? AND lower(f.path)='name'
          LIMIT 1
        ) AND t.locale IN ('zhCN', 'enUS', 'zhcn', 'enus')
        ORDER BY lower(t.locale)='zhcn' DESC, t.locale
      `);
      const membershipForObject = commander
        ? database.prepare(`
            SELECT evidence, depth FROM commander_membership
            WHERE commander_id=? AND catalog=? AND object_id=?
            ORDER BY depth, evidence
          `)
        : null;

      const addCandidate = (object, signal) => {
        if (!object) return;
        if (catalogFilter && object.catalog.toLowerCase() !== catalogFilter.toLowerCase()) return;
        const key = catalogNodeKey(object.catalog, object.objectId);
        let candidate = candidates.get(key);
        if (!candidate) {
          const memberships = membershipForObject
            ? rowsToPlain(membershipForObject.all(commander.commanderId, object.catalog, object.objectId))
            : [];
          const minimumDepth = memberships.length > 0
            ? Math.min(...memberships.map((item) => item.depth))
            : null;
          const minimumEvidence = memberships
            .filter((item) => item.depth === minimumDepth)
            .map((item) => item.evidence);
          const strongCommanderEvidence = minimumEvidence.some((evidence) =>
            /HeroUnit|HeroReviveUnit|HeroStructure|TechUnit/i.test(evidence));
          candidate = {
            catalog: object.catalog,
            objectId: object.objectId,
            class: object.class,
            parentId: object.parentId,
            sourceFile: object.sourceFile,
            commanderRelevance: commander
              ? {
                  relationship: minimumDepth === null ? "unresolved" : minimumDepth === 0 ? "direct" : "dependency",
                  depth: minimumDepth,
                  strong: strongCommanderEvidence,
                  evidence: minimumEvidence,
                }
              : null,
            signals: [],
          };
          candidates.set(key, candidate);
        }
        candidate.signals.push(signal);
      };

      for (const object of database
        .prepare(`
          SELECT catalog, object_id AS objectId, class, parent_id AS parentId,
                 source_file AS sourceFile
          FROM catalog_objects
          WHERE lower(object_id)=lower(?)
            AND (? IS NULL OR lower(catalog)=lower(?))
          ORDER BY catalog
        `)
        .all(objectQuery, catalogFilter, catalogFilter)) {
        addCandidate(object, { matchedBy: "objectId", matchedText: object.objectId, score: 1, matchType: "exact" });
      }

      let ftsRows = [];
      // The immutable official FTS index cannot contain locally authored IDs or
      // names. Search only the small overlay here; do not invent ownership from
      // a cloned object's parent or add fabricated official memberships.
      if (activeProjection) for (const object of database.prepare(`
        SELECT catalog, object_id AS objectId, class, parent_id AS parentId, source_file AS sourceFile
        FROM _gamea_catalog_objects WHERE (? IS NULL OR lower(catalog)=lower(?))
      `).all(catalogFilter, catalogFilter)) {
        const terms = [{ value: object.objectId, matchedBy: "localObjectId" },
          ...namesForObject.all(object.catalog, object.objectId).map((row) => ({ value: row.value, matchedBy: "localName" }))];
        for (const term of terms) {
          const normalized = normalizeCommanderName(term.value);
          if (normalized === normalizedQuery || normalized.includes(normalizedQuery)) {
            addCandidate(object, { matchedBy: term.matchedBy, matchedText: term.value,
              score: normalized === normalizedQuery ? 1 : 0.8,
              matchType: normalized === normalizedQuery ? "exact" : "substring" });
          }
        }
      }
      try {
        ftsRows = database
          .prepare(`
            SELECT key, title FROM search_index
            WHERE kind='catalog' AND search_index MATCH ?
              AND (? IS NULL OR lower(key) LIKE lower(?) ESCAPE '\\')
            ORDER BY rank, key
            LIMIT ?
          `)
          .all(
            ftsQuery(objectQuery),
            catalogFilter,
            catalogFilter ? `${escapeLike(catalogFilter)}/%` : null,
            Math.min(300, limit * 20),
          );
      } catch {
        ftsRows = [];
      }
      for (const row of ftsRows) {
        const separator = row.key.indexOf("/");
        if (separator <= 0) continue;
        const object = readObject.get(row.key.slice(0, separator), row.key.slice(separator + 1));
        if (!object) continue;
        const term = scoreCommanderTerm(normalizedQuery, {
          matchedBy: "objectId",
          matchedText: object.objectId,
          exactScore: 1,
        });
        addCandidate(object, term ?? {
          matchedBy: "catalogSearch",
          matchedText: row.title,
          score: 0.68,
          matchType: "full-text",
        });
      }

      const localizedRows = commander ? [] : database
        .prepare(`
          SELECT DISTINCT o.catalog, o.object_id AS objectId, o.class,
                 o.parent_id AS parentId, o.source_file AS sourceFile,
                 t.locale, t.value AS localizedName
          FROM catalog_objects o
          JOIN catalog_fields f
            ON f.catalog=o.catalog AND f.object_id=o.object_id AND lower(f.path)='name'
          JOIN localized_text t
            ON t.text_key=replace(f.value, '##id##', f.object_id)
          WHERE lower(t.locale) IN ('zhcn', 'enus')
            AND t.value LIKE ? ESCAPE '\\'
            AND (? IS NULL OR lower(o.catalog)=lower(?))
          ORDER BY lower(o.catalog), lower(o.object_id), lower(t.locale), t.value
          LIMIT 300
        `)
        .all(`%${escapeLike(objectQuery)}%`, catalogFilter, catalogFilter);
      for (const row of localizedRows) {
        for (const namePart of localizedNameParts(row.localizedName)) {
          const term = scoreCommanderTerm(normalizedQuery, {
            matchedBy: row.locale.toLowerCase() === "zhcn" ? "nameZhCN" : "nameEnUS",
            matchedText: namePart,
            exactScore: 0.98,
          });
          if (term) addCandidate(row, term);
        }
      }

      // Fuzzy localized-name recall is deliberately bounded to the selected commander's
      // membership projection. Without a commander, substring/FTS recall remains bounded
      // rather than scanning every localized string on every request.
      let fuzzyPoolTruncated = false;
      if (commander) {
        const fuzzyPool = rowsToPlain(database.prepare(`
          SELECT DISTINCT o.catalog, o.object_id AS objectId, o.class,
                 o.parent_id AS parentId, o.source_file AS sourceFile,
                 t.locale, t.value AS localizedName
          FROM main.commander_membership m
          JOIN main.catalog_objects o
            ON o.catalog=m.catalog AND o.object_id=m.object_id
          JOIN main.catalog_fields f
            ON f.catalog=o.catalog AND f.object_id=o.object_id AND lower(f.path)='name'
          JOIN main.localized_text t
            ON t.text_key=replace(f.value, '##id##', f.object_id)
          WHERE m.commander_id=? AND lower(t.locale) IN ('zhcn', 'enus')
            AND (? IS NULL OR lower(o.catalog)=lower(?))
          ORDER BY m.depth, lower(o.catalog), lower(o.object_id), lower(t.locale), t.value
          LIMIT 2001
        `).all(commander.commanderId, catalogFilter, catalogFilter));
        fuzzyPoolTruncated = fuzzyPool.length > 2000;
        for (const row of fuzzyPool.slice(0, 2000)) {
          for (const namePart of localizedNameParts(row.localizedName)) {
            const term = scoreCommanderTerm(normalizedQuery, {
              matchedBy: row.locale.toLowerCase() === "zhcn" ? "nameZhCN" : "nameEnUS",
              matchedText: namePart,
              exactScore: 0.98,
            });
            if (term && term.score >= 0.7) addCandidate(row, term);
          }
        }
      }

      const identityReader=commander?createUnitIdentityReader(database,{commanderId:commander.commanderId,prestigeUpgrade:input.prestigeUpgrade}):null;
      const ranked = [...candidates.values()].map((candidate) => {
        const bestSignal = candidate.signals
          .sort((left, right) => right.score - left.score || left.matchedText.localeCompare(right.matchedText))[0];
        const productionIdentity=identityReader&&candidate.catalog==='Unit'&&bestSignal.score>=0.9?identityReader.read(candidate.objectId,{summary:true}):null;
        const relevanceBonus = productionIdentity?.hasCommanderProductionRoute ? 0.08 : candidate.commanderRelevance?.strong
          ? 0.06
          : candidate.commanderRelevance?.relationship === "direct"
            ? 0.01
            : candidate.commanderRelevance?.relationship === "dependency" ? 0.005 : 0;
        return {
          ...candidate,
          ...(productionIdentity?{productionIdentity}:{}),
          score: Number(Math.min(1, bestSignal.score + relevanceBonus).toFixed(3)),
          matchedBy: bestSignal.matchedBy,
          matchedText: bestSignal.matchedText,
          matchType: bestSignal.matchType,
          signals: undefined,
        };
      }).sort((left, right) =>
        Number(right.matchType==='exact'&&right.matchedBy==='objectId')-Number(left.matchType==='exact'&&left.matchedBy==='objectId') ||
        right.score - left.score ||
        Number(Boolean(right.productionIdentity?.hasCommanderProductionRoute))-Number(Boolean(left.productionIdentity?.hasCommanderProductionRoute)) ||
        (left.commanderRelevance?.depth ?? 999) - (right.commanderRelevance?.depth ?? 999) ||
        left.catalog.localeCompare(right.catalog) ||
        left.objectId.localeCompare(right.objectId));

      const items = ranked.slice(0, limit).map((candidate) => {
        const names = rowsToPlain(namesForObject.all(candidate.catalog, candidate.objectId));
        return {
          ...candidate,
          nameZhCN: names.find((item) => item.locale.toLowerCase() === "zhcn")?.value ?? null,
          nameEnUS: names.find((item) => item.locale.toLowerCase() === "enus")?.value ?? null,
          nextQuery:{operation:'entity.get',...(commander?{commanderId:commander.commanderId}:{}),catalog:candidate.catalog,objectId:candidate.objectId},
        };
      });
      const best = items[0] ?? null;
      const runnerUp = items[1] ?? null;
      const resolved = Boolean(
        best && best.score >= 0.9 && (
          !runnerUp || Number((best.score - runnerUp.score).toFixed(3)) >= 0.05
        ),
      );
      return {
        operation: "entity.resolve",
        query,
        commander: commander ? { ...commander } : null,
        catalog: catalogFilter,
        resolved,
        entity: resolved ? {
          catalog: best.catalog,
          objectId: best.objectId,
          class: best.class,
        } : null,
        confidence: best?.score ?? 0,
        candidates: items,
        ...(!resolved && commander?{directoryQuery:{operation:'commander.get',commanderId:commander.commanderId,
          ...(catalogFilter?.toLowerCase()==='unit'?{topic:'units'}:{})}}:{}),
        recall: {
          objectIdAndFts: true,
          localizedSubstring: true,
          localizedFuzzy: commander ? "commander-bounded" : "not-scanned-without-commander",
        },
        warnings: fuzzyPoolTruncated
          ? ["Commander-localized fuzzy candidate pool reached its 2000-row bound."]
          : [],
        truncated: ranked.length > items.length || fuzzyPoolTruncated,
      };
    });
  }

  function catalogObject(input) {
    const catalog = requireString(input, "catalog");
    const objectId = requireString(input, "objectId");
    const limit = clampLimit(input.limit ?? 100);
    return withDatabase((database) => {
      const object = database
        .prepare(`
          SELECT catalog, object_id AS objectId, class, parent_id AS parentId,
                 is_default AS isDefault, source_file AS sourceFile
          FROM catalog_objects WHERE lower(catalog)=lower(?) AND lower(object_id)=lower(?)
        `)
        .get(catalog, objectId);
      if (!object) throw new CoopSearchError(`Unknown Catalog object: ${catalog}/${objectId}`);
      if(input.metadataOnly)return {operation:'catalog.object',object:{...object,isDefault:Boolean(object.isDefault)}};
      const prefix = typeof input.fieldPrefix === "string" && input.fieldPrefix.trim()
        ? `${input.fieldPrefix.trim()}%`
        : "%";
      const offset = input.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new CoopSearchError('offset must be a non-negative integer');
      const totalFields = database
        .prepare(`
          SELECT count(*) AS value FROM catalog_fields
          WHERE catalog=? AND object_id=? AND path LIKE ?
        `)
        .get(object.catalog, object.objectId, prefix).value;
      const fields = rowsToPlain(
        database
          .prepare(`
            SELECT path, value, source_file AS sourceFile, origin_object_id AS originObjectId,
                   inheritance_depth AS inheritanceDepth
            FROM catalog_fields WHERE catalog=? AND object_id=? AND path LIKE ?
            ORDER BY path
          `)
          .all(object.catalog, object.objectId, prefix),
      ).sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true })).slice(offset, offset + limit)
        .map(field => ({ ...field, ...(object.class === 'CUpgrade' && /^EffectArray(?:\[#?\d+\])?$/.test(field.path)
          ? { editPath: canonicalEditPath(object.class, field.path), valueAttribute: 'Value' } : {}) }));
      return {
        operation: "catalog.object",
        object: { ...object, isDefault: Boolean(object.isDefault) },
        fields,
        totalFields,
        offset,
        nextOffset: offset + fields.length < totalFields ? offset + fields.length : null,
        truncated: offset + fields.length < totalFields,
      };
    });
  }

  function catalogEffective(input) {
    const catalog = requireString(input, "catalog");
    const objectId = requireString(input, "objectId");
    const requestedPath = requireString(input, "path");
    return withDatabase((database) => {
      const object = database
        .prepare(`
          SELECT catalog, object_id AS objectId, class, parent_id AS parentId,
                 is_default AS isDefault, source_file AS sourceFile
          FROM catalog_objects WHERE lower(catalog)=lower(?) AND lower(object_id)=lower(?)
        `)
        .get(catalog, objectId);
      if (!object) throw new CoopSearchError(`Unknown Catalog object: ${catalog}/${objectId}`);

      const readField = `
        SELECT path, value, source_file AS sourceFile, origin_object_id AS originObjectId,
               inheritance_depth AS inheritanceDepth
        FROM catalog_fields WHERE catalog=? AND object_id=?`;
      const exactMatches = rowsToPlain(database
        .prepare(`
          ${readField} AND lower(path)=lower(?) ORDER BY path
        `)
        .all(object.catalog, object.objectId, requestedPath));
      const exact = exactMatches.length === 1 ? exactMatches[0] : null;
      const editPath = canonicalEditPath(object.class, requestedPath);
      const mastery = object.class === 'CUser' ? masteryPointSelector(editPath) : null;
      const normalize = value => {
        const normalized = canonicalCatalogPath(value);
        return mastery ? normalized.replace(/\.fixed\[0\]/i, '.fixed') : normalized;
      };
      const canonical = normalize(mastery?.physicalPath ?? editPath);
      const alternatives = exact
        ? exactMatches
        : rowsToPlain(database.prepare(`${readField} ORDER BY path`).all(object.catalog, object.objectId))
            .filter((field) => normalize(canonicalEditPath(object.class, field.path)) === canonical);
      const selected = exact ?? (alternatives.length === 1 ? alternatives[0] : null);
      const ambiguous = exactMatches.length > 1 || (!exact && alternatives.length > 1);
      const toField = (field) => ({
        path: field.path,
        value: scalarValue(field.value),
        rawValue: field.value,
        sourceFile: field.sourceFile,
        originObjectId: field.originObjectId,
        inheritanceDepth: field.inheritanceDepth,
        inherited: field.inheritanceDepth > 0,
        valueSource: field.sourceFile?.startsWith("engine:") ? "sc2-engine"
          : field.sourceFile?.startsWith("game-a/") ? "game-a-projection" : "legacy-interpreted",
        ...(field.sourceFile?.startsWith("engine:") ? { inheritanceKnown: false, snapshotId: field.sourceFile.slice(7) } : {}),
        editPath: mastery ? editPath : canonicalEditPath(object.class, field.path),
        patchable: activeProjection?.projection
          ? activeProjection.projection.inspect(object.catalog, object.objectId, mastery ? editPath : canonicalEditPath(object.class, field.path)).catalogEdit.available
          : !field.path.includes('[#'),
      });
      const warnings = [];
      if (!selected && alternatives.length === 0) {
        warnings.push({
          code: "engine-default-not-modeled",
          message: "The field is absent from the merged Catalog projection; an SC2 engine default may still exist.",
        });
      }
      if (ambiguous) {
        warnings.push({
          code: "ambiguous-canonical-path",
          message: "More than one stored field maps to the requested canonical path; choose an exact stored path.",
        });
      }
      if (selected?.path.includes("[#") && !toField(selected).patchable) {
        warnings.push({
          code: "ordinal-unindexed-element",
          message: "This stored path is ordinal evidence. Reuse an available editState operation; the stored ordinal alone does not prove sparse-write support.",
        });
      }
      return {
        operation: "catalog.effective",
        object: { ...object, isDefault: Boolean(object.isDefault) },
        requestedPath,
        resolved: Boolean(selected),
        exists: Boolean(selected) || alternatives.length > 0,
        ambiguous,
        field: selected ? toField(selected) : null,
        alternatives: alternatives.map(toField),
        provenance: {
          effectiveOrder: selected?.sourceFile?.startsWith('engine:') ? ['sc2-loaded-catalog'] : ["class-default", "parent-chain", "direct-and-later-dependency-overrides"],
          overriddenValuesAvailable: false,
        },
        warnings,
      };
    });
  }

  function entityGet(input) {
    const bindQueryContext = facts => {
      if(!input.prestigeUpgrade) return facts;
      const visit=value=> {
        if(!value || typeof value!=='object') return;
        for(const [k,v] of Object.entries(value)) {
          if(['nextQuery','conditionQuery'].includes(k) && v?.operation) v.prestigeUpgrade=input.prestigeUpgrade;
          else visit(v);
        }
      };
      visit(facts); return facts;
    };
    let catalog = input.catalog;
    const objectId = requireString(input, "objectId");
    if (input.query !== undefined) throw new CoopSearchError('entity.get reads an exact objectId; use entity.resolve to resolve names first.');
    const limit = clampLimit(input.limit ?? 30);
    const hasPath = typeof input.path === "string" && input.path.trim().length > 0;
    const hasTopic = input.topic !== undefined;
    if(input.group!==undefined && (hasPath || input.fieldPrefix!==undefined || input.include!==undefined || (hasTopic&&!['parameters','overview'].includes(input.topic)) || ['direction','maxDepth','relationFamily','includeFields'].some(k=>input[k]!==undefined)))throw new CoopSearchError('Object parameter group does not combine with fields, exact paths or graph options.');
    if(['fields','parameters'].includes(input.topic) && ['direction','maxDepth','relationFamily','includeFields'].some(k=>input[k]!==undefined)) {
      throw new CoopSearchError('Object card topics do not combine with graph options; query include relationships separately.');
    }
    if (input.commandIndex !== undefined && (hasPath || input.fieldPrefix !== undefined || input.include !== undefined)) {
      throw new CoopSearchError('commandIndex selects an Abil detail command; do not combine it with path, fieldPrefix or include.');
    }
    if (input.reference!==undefined && (input.topic!=='upgradeEffects'||!input.reference?.catalog||!input.reference?.objectId))throw new CoopSearchError('reference requires topic=upgradeEffects and an exact catalog/objectId target.');
    if (hasTopic && (!['overview','fields','parameters','influences','mastery','identity','upgradeEffects','production','abilities','modifiers',...COMMANDER_SECTIONS].includes(input.topic)
        || (hasPath && input.topic !== 'influences') || input.fieldPrefix !== undefined || input.include !== undefined)) {
      throw new CoopSearchError('entity.get topic selects prebuilt facts by ID; do not combine it with path, fieldPrefix or include.');
    }
    const expansions = ["fields", "effectiveField", "relationships", "unitArrays"];
    if (input.include !== undefined && (!Array.isArray(input.include) ||
        input.include.some((part) => !expansions.includes(part)))) {
      throw new CoopSearchError("entity.get include must contain fields, effectiveField, relationships or unitArrays.");
    }
    if (input.detailLevel !== undefined && !["overview", "full"].includes(input.detailLevel)) {
      throw new CoopSearchError("entity.get detailLevel must be overview or full.");
    }
    const navigationResult = !input.path ? withDatabase(database => ({
      commanderEntries: findCommanderEntries(database, input.commanderId, objectId, catalog),
    })) : null;
    if (!catalog) {
      if (input.topic === 'mastery') {
        const targets = new Map((navigationResult?.commanderEntries ?? [])
          .filter(entry => entry.kind === 'masteries')
          .flatMap(entry => entry.effectTargets ?? [])
          .filter(target => target.catalog === 'Upgrade')
          .map(target => [target.objectId, target]));
        // The caller already selected mastery evidence. An unambiguous profile
        // instance is an alias for that evidence, not another navigation stop.
        if (targets.size === 1) return {
          ...entityGet({ ...input, catalog: 'Upgrade', objectId: targets.keys().next().value }),
          requestedEntryId: objectId,
        };
      }
      if (navigationResult?.commanderEntries.length) return {
        ...navigationResult, operation: 'entity.get', responseMode: 'commander-entry',
        officialFacts: bindQueryContext(withDatabase(db=>({facts:readCoopCommanderFacts(db,{commanderId:input.commanderId,entryId:objectId})})).facts),
        entity: null,
      };
      const resolved = withDatabase(database => ({ candidates: database.prepare(
        'SELECT catalog, object_id AS objectId FROM catalog_objects WHERE lower(object_id)=lower(?) ORDER BY catalog'
      ).all(objectId) }));
      if (resolved.candidates.length !== 1) throw new CoopSearchError(
        resolved.candidates.length ? 'Object ID exists in multiple Catalogs; choose an explicit typed target.' : `Unknown object or commander entry: ${objectId}`,
        { candidates: resolved.candidates });
      catalog = resolved.candidates[0].catalog;
    }
    catalog = requireString({ catalog }, 'catalog');
    if (input.commandIndex !== undefined && (catalog.toLowerCase()!=='abil' || !/^[A-Za-z0-9_]+$/.test(input.commandIndex))) throw new CoopSearchError('commandIndex requires an exact Abil command slot.');
    if (hasTopic && !['fields','parameters','influences','mastery','identity','upgradeEffects'].includes(input.topic) && !(input.topic==='overview' && input.responseProfile==='scalar-card' && catalog.toLowerCase()!=='commander') && (!input.commanderId || !(catalog.toLowerCase()==='unit' && ['overview','production','abilities','modifiers'].includes(input.topic)
        || catalog.toLowerCase()==='commander' && ['overview',...COMMANDER_SECTIONS].includes(input.topic)))) {
      throw new CoopSearchError('entity.get topic selects a Unit or Commander section and requires commanderId. Child objects return details without topic.');
    }
    const cardMode=input.responseProfile==='scalar-card' && !hasPath && input.fieldPrefix===undefined && input.include===undefined
      && (input.detailLevel!=='full' || ['parameters','fields'].includes(input.topic)) && (input.topic===undefined || ['overview','parameters','fields'].includes(input.topic))
      && (catalog.toLowerCase()!=='commander' || ['parameters','fields'].includes(input.topic))
      && !['direction','maxDepth','relationFamily','includeFields'].some(k=>input[k]!==undefined);
    const include = new Set(input.detailLevel === "full" ? expansions : input.include ?? []);
    if (!hasPath && !hasTopic) include.add("fields");
    if (hasTopic) include.clear();
    // Existing callers explicitly requesting graph filters still get that graph.
    // An exact scalar lookup without graph options performs no graph traversal.
    if (input.include === undefined && ["direction", "maxDepth", "minConfidence", "relationFamily", "includeFields"]
      .some((property) => input[property] !== undefined)) include.add("relationships");
    let objectResult;
    try { objectResult = catalogObject({
      ...input,
      catalog,
      objectId,
      limit,
      metadataOnly:cardMode || ['influences','mastery','identity','upgradeEffects'].includes(input.topic),
    }); } catch (error) {
      if (error instanceof CoopSearchError && error.message.startsWith('Unknown Catalog object:')) {
        const hints = withDatabase(database => ({
          commanderEntries: findCommanderEntries(database, input.commanderId, objectId),
          candidates: database.prepare('SELECT catalog, object_id AS objectId FROM catalog_objects WHERE lower(object_id)=lower(?) ORDER BY catalog').all(objectId),
        }));
        error.details = { ...error.details, commanderEntries: hints.commanderEntries, candidates: hints.candidates };
      }
      throw error;
    }
    const readUsage = handler => withDatabase(db => {
      const reader = createFieldUsageReader(db, {
        inspect: (...args) => activeProjection.projection.inspect(...args),
        dependencies: operation => [...new Set(operationTargets(operation).flatMap(target => patchesForTargetLocked({ target }).requiredDependsOn))].sort(),
      });
      return { result: handler(reader) };
    }).result;
    const scriptParameters = hasPath ? null : readUsage(reader => reader.forObject(objectResult.object.catalog, objectResult.object.objectId))
      .map(parameter => ({ ...parameter, nextQuery: { operation: 'entity.get',
        ...(input.commanderId ? { commanderId: input.commanderId } : {}),
        ...(input.prestigeUpgrade ? { prestigeUpgrade: input.prestigeUpgrade } : {}), ...parameter.target } }));
    if(input.topic==='identity') {
      if(catalog!=='Unit')throw new CoopSearchError('identity requires catalog=Unit.');
      return {...objectResult,operation:'entity.get',responseMode:'unit-production-identity',
        unitIdentity:withDatabase(db=>({result:createUnitIdentityReader(db,input).read(objectId)})).result};
    }
    if(input.topic==='upgradeEffects') {
      if(['commandIndex','direction','maxDepth','relationFamily','includeFields'].some(k=>input[k]!==undefined))throw new CoopSearchError('upgradeEffects does not combine with command or graph selectors.');
      return {...objectResult,operation:'entity.get',responseMode:'upgrade-effects',
        upgradeEffects:withDatabase(db=>({result:readUpgradeEffects(db,{...input,catalog:objectResult.object.catalog},{
          inspect:(...args)=>activeProjection.projection.inspect(...args),
          dependencies:operation=>[...new Set(operationTargets(operation).flatMap(target=>patchesForTargetLocked({target}).requiredDependsOn))].sort(),
        })})).result};
    }
    if(input.topic==='mastery') {
      if(['commandIndex','direction','maxDepth','relationFamily','includeFields'].some(k=>input[k]!==undefined))throw new CoopSearchError('mastery does not combine with command or graph selectors.');
      return {...objectResult,operation:'entity.get',responseMode:'mastery-evidence',
        masteryEvidence:withDatabase(db=>({result:readMasteryEvidence(db,{...input,catalog:objectResult.object.catalog},{
          entry:navigationResult?.commanderEntries.find(e=>e.kind==='masteries'),
          inspect:(...args)=>activeProjection.projection.inspect(...args),
          dependencies:operation=>[...new Set(operationTargets(operation).flatMap(target=>patchesForTargetLocked({target}).requiredDependsOn))].sort(),
        })})).result};
    }
    const readInfluences = handler => withDatabase(db => ({ result: handler(createFieldInfluenceReader(db, {
      ...input, catalog: objectResult.object.catalog, objectId: objectResult.object.objectId,
    }, { applied: activeProjection?.projection.applied ?? [] })) })).result;
    if (input.topic === 'influences') {
      if (['commandIndex','direction','maxDepth','relationFamily','includeFields'].some(k => input[k] !== undefined)) throw new CoopSearchError('influences accepts an optional exact field path, not command/graph selectors.');
      return { operation: 'entity.get', responseMode: 'field-influences', entity: objectResult.object,
        database: objectResult.database, currentProject: objectResult.currentProject,
        fieldInfluences: readInfluences(r => r.read({ path: input.path, offset: input.offset ?? 0, limit: input.limit ?? 8 })) };
    }
    if(cardMode) {
      const object=objectResult.object,mode=input.topic==='fields'?'fields':'parameters';
      const objectCard=withDatabase(db=>{
        const request={...input,catalog:object.catalog,objectId:object.objectId,limit};
        const memberships=input.commanderId?db.prepare('SELECT evidence,depth FROM main.commander_membership WHERE commander_id=? AND catalog=? AND object_id=? ORDER BY depth,evidence LIMIT 8')
          .all(input.commanderId,object.catalog,object.objectId):[];
        const identity={commanderId:input.commanderId??null,
          status:!input.commanderId?'commander-not-selected':memberships.length?'indexed-association':'association-unconfirmed',
          evidence:memberships,
          note:'关联证据不证明独占或运行时可用性；commanderId 是查询/编辑上下文，不会把同名对象变为该指挥官实际使用的版本。'};
        if(object.catalog==='Unit')identity.production=createUnitIdentityReader(db,input).read(object.objectId,{summary:true});
        if(object.catalog==='Upgrade')identity.effectsQuery={operation:'entity.get',...(input.commanderId?{commanderId:input.commanderId}:{}),...(input.prestigeUpgrade?{prestigeUpgrade:input.prestigeUpgrade}:{}),catalog:'Upgrade',objectId:object.objectId,topic:'upgradeEffects'};
        if(mode==='fields') {
          const guide=readObjectFieldGuide(db,request);
          return {card:{...guide,identity,mode,entries:guide.entries?.map(e=>({...e,section:'fields'}))}};
        }
        const facts=object.catalog==='Unit' && input.commanderId ? bindQueryContext(readCoopEntityFacts(db,{
          commanderId:input.commanderId,catalog:object.catalog,objectId:object.objectId,
        })):{};
        const card=readObjectParameters(db,request,{directory:facts.directory,status:facts.status});
        return {card:{...card,identity,mode}};
      }).card;
      objectCard.valueContext = { ...INFLUENCE_BOUNDARY,
        cardValues: 'official-baseline',
        note: '卡片数值是官方基线；影响证据来自当前工程。不能直接将两者合计；精确查询读取当前编辑值。' + INFLUENCE_BOUNDARY.note };
      objectCard.influencesQuery = { operation:'entity.get', catalog:object.catalog, objectId:object.objectId,
        ...(input.commanderId?{commanderId:input.commanderId}:{}), ...(input.prestigeUpgrade?{prestigeUpgrade:input.prestigeUpgrade}:{}), topic:'influences' };
      if (objectCard.entries) objectCard.entries = readInfluences(reader => objectCard.entries.map(entry =>
        entry.path && /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(String(entry.baselineValue ?? entry.value))
          ? { ...entry, influenceSummary: reader.summary(entry.path) } : entry));
      // Keep a stale/missing card actionable without broadening a selected
      // production slot into an unscoped all-command field dump.
      if(!objectCard.entries)objectCard.fallbackQuery={operation:'entity.get',catalog:object.catalog,objectId:object.objectId,
        ...(input.commanderId?{commanderId:input.commanderId}:{}),...(input.prestigeUpgrade?{prestigeUpgrade:input.prestigeUpgrade}:{}),
        ...(input.commandIndex!==undefined?{fieldPrefix:`InfoArray[${input.commandIndex}].`}:{}),include:['fields']};
      return {database:objectResult.database,currentProject:objectResult.currentProject,operation:'entity.get',
        responseMode:'object-card',entity:object,objectCard,
        ...(scriptParameters.length ? { scriptParameters } : {}),
        ...(navigationResult?.commanderEntries.length?{commanderEntries:navigationResult.commanderEntries}:{})};
    }
    const relationshipResult = include.has("relationships") ? relationshipsTrace({
      ...input,
      catalog,
      objectId,
      direction: input.direction ?? "both",
      maxDepth: input.maxDepth ?? 1,
      minConfidence: input.minConfidence ?? 0.9,
      relationFamily: input.relationFamily ?? "all",
      includeFields: input.includeFields ?? false,
      limit,
    }) : {};
    const effectiveResult = hasPath
      ? catalogEffective({
          catalog,
          objectId,
          path: input.path,
        })
      : null;
    const unitArrayResult = include.has("unitArrays") && String(catalog).toLowerCase() === "unit"
      ? withDatabase((database) => ({
          unitArrays: projectUnitArrays(database, objectResult.object.catalog, objectResult.object.objectId),
        }))
      : null;
    const { database, currentProject, operation: _objectOperation, object, ...fieldProjection } = objectResult;
    const {
      database: _relationshipDatabase,
      currentProject: _relationshipProject,
      operation: _relationshipOperation,
      start: _relationshipStart,
      ...relationships
    } = relationshipResult;
    let effectiveField = null;
    if (effectiveResult) {
      const {
        database: _effectiveDatabase,
        currentProject: _effectiveProject,
        operation: _effectiveOperation,
        object: _effectiveObject,
        ...effectiveProjection
      } = effectiveResult;
      effectiveField = effectiveProjection;
    }
    const unitArrays = unitArrayResult?.unitArrays ?? null;
    // Prebuilt knowledge is an ID-keyed part of the existing entity read, not
    // a second name resolver. Keep its official baseline separate from the
    // current Game A fields and never expand an exact scalar query implicitly.
    const wantFacts = !['fields','parameters'].includes(input.topic) && ['commander','unit','abil','weapon','behavior','effect','upgrade'].includes(catalog.toLowerCase()) && input.commanderId && !hasPath
      && input.fieldPrefix === undefined && input.include === undefined;
    const officialFacts = wantFacts ? withDatabase(db => ({ facts:readCoopEntityFacts(db, {
      commanderId:input.commanderId, objectId:objectResult.object.objectId,
      catalog:objectResult.object.catalog, commandIndex:input.commandIndex,
      topic:input.topic ?? 'overview', limit, offset:input.offset ?? 0,
    }) })).facts : null;
    // The cached facts stay official; subsequent current-field reads must not
    // silently lose the caller's explicitly selected prestige context.
    bindQueryContext(officialFacts);
    const fieldGuide = input.responseProfile!=='scalar-card' && !hasPath && input.fieldPrefix === undefined && input.include === undefined
      ? withDatabase(db => ({guide:readObjectFieldGuide(db, {
        catalog:object.catalog,objectId:object.objectId,commanderId:input.commanderId,prestigeUpgrade:input.prestigeUpgrade,
        commandIndex:input.commandIndex,limit,offset:input.offset ?? 0,summaryOnly:input.topic !== 'fields',
      })})).guide : null;
    // Meanings annotate the current read; they never supply a value or authorize a write.
    const parameterGuide = input.responseProfile!=='scalar-card' && !hasPath && input.fieldPrefix === undefined && input.include === undefined
      && (input.topic === undefined || ['overview','parameters'].includes(input.topic))
      ? withDatabase(db => ({guide:readObjectParameters(db, {
        catalog:object.catalog,objectId:object.objectId,commanderId:input.commanderId,prestigeUpgrade:input.prestigeUpgrade,
        commandIndex:input.commandIndex,limit,offset:input.offset??0,summaryOnly:input.topic !== 'parameters',
      })})).guide : null;
    if (fieldProjection.fields) fieldProjection.fields = readInfluences(reader => fieldProjection.fields.map(f => ({...f,meaning:describeField(object.catalog,object.class,f.path),
      ...(/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(String(f.value)) ? { influenceSummary:reader.summary(f.path) } : {}) })));
    const editState = effectiveField && activeProjection
      ? activeProjection.projection.inspect(object.catalog, object.objectId, input.path)
      : null;
    const operationMatch = object.catalog === 'Upgrade' && hasPath
      ? /^(EffectArray(?:\[#?\d+\])?)\.@?Operation$/.exec(input.path) : null;
    const operationRead = operationMatch
      ? withDatabase(db => readUpgradeOperation(db, object.objectId, operationMatch[1])) : null;
    const operationSemantics = operationRead ? (({ database: _db, currentProject: _project, ...value }) => value)(operationRead) : null;
    for (const edit of [editState?.edit, editState?.catalogEdit].filter(Boolean)) {
      const targets = operationTargets(edit.operation);
      const history = targets.map((target) => patchesForTargetLocked({ target }));
      edit.requiredDependsOn = [...new Set(history.flatMap((item) => item.requiredDependsOn))].sort();
      edit.targets = targets;
    }
    return {
      database,
      operation: "entity.get",
      projection: {
        id: "entity",
        version: 2,
        purpose: "bounded-authoring-evidence",
      },
      entity: object,
      ...(navigationResult?.commanderEntries.length ? { commanderEntries: navigationResult.commanderEntries } : {}),
      currentProject,
      valueContext: INFLUENCE_BOUNDARY,
      ...(hasPath ? { fieldInfluences: readInfluences(reader => reader.read({ path: input.path, limit: Math.min(input.limit ?? 4, 8) })) } : {}),
      ...(hasPath ? { usageEvidence: readUsage(reader => reader.forField(object.catalog, object.objectId, input.path)) } : {}),
      ...(!hasPath && scriptParameters.length ? { scriptParameters } : {}),
      ...(officialFacts ? { officialFacts } : {}),
      ...(fieldGuide ? { fieldGuide } : {}),
      ...(parameterGuide ? { parameterGuide } : {}),
      ...(hasPath ? { fieldMeaning:describeField(object.catalog,object.class,effectiveField?.field?.path ?? input.path) } : {}),
      ...(include.has("fields") ? fieldProjection : {}),
      ...(include.has("effectiveField") ? { effectiveField } : {}),
      ...(editState ? { editState } : {}),
      ...(operationSemantics ? { operationSemantics } : {}),
      ...(unitArrays ? { unitArrays } : {}),
      ...(include.has("relationships") ? { relationships } : {}),
      ...(effectiveField?.warnings.length ? { fieldWarnings: effectiveField.warnings } : {}),
      guidance: effectiveField
        ? "Follow editState.authoringRoute first. edit.available describes a readable executable precondition, NOT an Upgrade whitelist. For a whitelist/existing Upgrade route use edit.expect and its exact target/dependencies; for private clones use catalogEdit on the source then explicit writes to private targets. Never substitute player Upgrade values for clone Catalog expects. Runtime totals are unknown."
        : "Supply path when an exact writable field value is needed for a PatchPlan expect condition.",
    };
  }

  function catalogReferences(input) {
    const catalog = requireString(input, "catalog");
    const objectId = requireString(input, "objectId");
    const direction = input.direction ?? "both";
    if (!["outgoing", "incoming", "both"].includes(direction)) {
      throw new CoopSearchError("direction must be outgoing, incoming, or both.");
    }
    const limit = clampLimit(input.limit ?? 50);
    return withDatabase((database) => {
      const exists = database
        .prepare("SELECT 1 FROM catalog_objects WHERE lower(catalog)=lower(?) AND lower(object_id)=lower(?)")
        .get(catalog, objectId);
      if (!exists) throw new CoopSearchError(`Unknown Catalog object: ${catalog}/${objectId}`);
      const outgoing = direction === "incoming"
        ? []
        : rowsToPlain(
            database
              .prepare(`
                SELECT field_path AS fieldPath, target_catalog AS targetCatalog,
                       target_object_id AS targetObjectId, confidence, evidence
                FROM object_references
                WHERE lower(source_catalog)=lower(?) AND lower(source_object_id)=lower(?)
                ORDER BY confidence DESC, field_path LIMIT ?
              `)
              .all(catalog, objectId, limit + 1),
          );
      const incoming = direction === "outgoing"
        ? []
        : rowsToPlain(
            database
              .prepare(`
                SELECT source_catalog AS sourceCatalog, source_object_id AS sourceObjectId,
                       field_path AS fieldPath, confidence, evidence
                FROM object_references
                WHERE lower(target_catalog)=lower(?) AND lower(target_object_id)=lower(?)
                ORDER BY confidence DESC, source_catalog, source_object_id LIMIT ?
              `)
              .all(catalog, objectId, limit + 1),
          );
      return {
        operation: "catalog.references",
        object: { catalog, objectId },
        direction,
        outgoing: outgoing.slice(0, limit),
        incoming: incoming.slice(0, limit),
        truncated: outgoing.length > limit || incoming.length > limit,
      };
    });
  }

  function relationshipsTrace(input) {
    const catalog = requireString(input, "catalog");
    const objectId = requireString(input, "objectId");
    const direction = input.direction ?? "both";
    if (!["outgoing", "incoming", "both"].includes(direction)) {
      throw new CoopSearchError("direction must be outgoing, incoming, or both.");
    }
    const maxDepth = input.maxDepth ?? 2;
    if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 4) {
      throw new CoopSearchError("maxDepth must be an integer between 1 and 4.");
    }
    const minConfidence = input.minConfidence ?? 0.9;
    if (typeof minConfidence !== "number" || !Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
      throw new CoopSearchError("minConfidence must be a number between 0 and 1.");
    }
    const relationFamily = input.relationFamily ?? "all";
    if (!RELATIONSHIP_FAMILIES.includes(relationFamily)) {
      throw new CoopSearchError("Unknown relationship family.", { families: RELATIONSHIP_FAMILIES });
    }
    const includeFields = input.includeFields ?? false;
    if (typeof includeFields !== "boolean") {
      throw new CoopSearchError("includeFields must be a boolean.");
    }
    const limit = clampLimit(input.limit ?? 50);
    const commanderId = typeof input.commanderId === "string" && input.commanderId.trim()
      ? input.commanderId.trim()
      : null;

    return withDatabase((database) => {
      const readObject = (nodeCatalog, nodeObjectId) => database
        .prepare(`
          SELECT catalog, object_id AS objectId, class, parent_id AS parentId,
                 is_default AS isDefault, source_file AS sourceFile
          FROM catalog_objects
          WHERE lower(catalog)=lower(?) AND lower(object_id)=lower(?)
        `)
        .get(nodeCatalog, nodeObjectId);
      const startObject = readObject(catalog, objectId);
      if (!startObject) throw new CoopSearchError(`Unknown Catalog object: ${catalog}/${objectId}`);

      let commander = null;
      const memberships = new Map();
      if (commanderId) {
        commander = database
          .prepare(`
            SELECT id AS commanderId, commander_object_id AS commanderObjectId,
                   name_zhcn AS nameZhCN, name_enus AS nameEnUS
            FROM commanders WHERE lower(id)=lower(?) OR lower(commander_object_id)=lower(?)
          `)
          .get(commanderId, commanderId);
        if (!commander) throw new CoopSearchError(`Unknown commander: ${commanderId}`);
        for (const row of database
          .prepare(`
            SELECT catalog, object_id AS objectId, evidence, depth
            FROM commander_membership WHERE commander_id=?
            ORDER BY depth, catalog, object_id, evidence
          `)
          .all(commander.commanderId)) {
          const key = catalogNodeKey(row.catalog, row.objectId);
          if (!memberships.has(key)) memberships.set(key, []);
          memberships.get(key).push({ evidence: row.evidence, depth: row.depth });
        }
      }

      const commanderRelevance = (nodeCatalog, nodeObjectId) => {
        if (!commander) return null;
        const evidence = memberships.get(catalogNodeKey(nodeCatalog, nodeObjectId)) ?? [];
        if (evidence.length === 0) return { relationship: "unresolved", depth: null, evidence: [] };
        const depth = Math.min(...evidence.map((item) => item.depth));
        return {
          relationship: depth === 0 ? "direct" : "dependency",
          depth,
          evidence: evidence.filter((item) => item.depth === depth).map((item) => item.evidence),
        };
      };
      const relevanceScore = (nodeCatalog, nodeObjectId) => {
        const relevance = commanderRelevance(nodeCatalog, nodeObjectId);
        if (!relevance || relevance.depth === null) return 0;
        return Math.max(1, 20 - relevance.depth * 3);
      };
      const decorateNode = (object, distance) => ({
        catalog: object.catalog,
        objectId: object.objectId,
        class: object.class,
        parentId: object.parentId,
        isDefault: Boolean(object.isDefault),
        sourceFile: object.sourceFile,
        distance,
        commanderRelevance: commanderRelevance(object.catalog, object.objectId),
      });

      const outgoingStatement = database.prepare(`
        SELECT r.source_catalog AS sourceCatalog, r.source_object_id AS sourceObjectId,
               source.class AS sourceClass, source.parent_id AS sourceParentId,
               source.is_default AS sourceIsDefault, source.source_file AS sourceFile,
               r.field_path AS fieldPath,
               r.target_catalog AS targetCatalog, r.target_object_id AS targetObjectId,
               target.class AS targetClass, target.parent_id AS targetParentId,
               target.is_default AS targetIsDefault, target.source_file AS targetFile,
               r.confidence, r.evidence
        FROM object_references r
        JOIN catalog_objects source
          ON source.catalog=r.source_catalog AND source.object_id=r.source_object_id
        JOIN catalog_objects target
          ON target.catalog=r.target_catalog AND target.object_id=r.target_object_id
        WHERE r.source_catalog=? AND r.source_object_id=?
          AND r.confidence>=?
        ORDER BY r.confidence DESC, r.field_path, r.target_catalog, r.target_object_id
        LIMIT ?
      `);
      const incomingStatement = database.prepare(`
        SELECT r.source_catalog AS sourceCatalog, r.source_object_id AS sourceObjectId,
               source.class AS sourceClass, source.parent_id AS sourceParentId,
               source.is_default AS sourceIsDefault, source.source_file AS sourceFile,
               r.field_path AS fieldPath,
               r.target_catalog AS targetCatalog, r.target_object_id AS targetObjectId,
               target.class AS targetClass, target.parent_id AS targetParentId,
               target.is_default AS targetIsDefault, target.source_file AS targetFile,
               r.confidence, r.evidence
        FROM object_references r
        JOIN catalog_objects source
          ON source.catalog=r.source_catalog AND source.object_id=r.source_object_id
        JOIN catalog_objects target
          ON target.catalog=r.target_catalog AND target.object_id=r.target_object_id
        WHERE r.target_catalog=? AND r.target_object_id=?
          AND r.confidence>=?
        ORDER BY r.confidence DESC, r.field_path, r.source_catalog, r.source_object_id
        LIMIT ?
      `);
      const contextFieldsStatement = includeFields
        ? database.prepare(`
            SELECT path, value, source_file AS sourceFile,
                   origin_object_id AS originObjectId, inheritance_depth AS inheritanceDepth
            FROM catalog_fields
            WHERE catalog=? AND object_id=?
              AND (path=? OR substr(path, 1, ?)=?)
            ORDER BY path LIMIT 17
          `)
        : null;
      const contextFields = (reference) => {
        if (!contextFieldsStatement) return { fields: undefined, truncated: undefined };
        const prefix = referenceContextPrefix(reference.fieldPath);
        const childPrefix = `${prefix}.`;
        const rows = rowsToPlain(
          contextFieldsStatement.all(
            reference.sourceCatalog,
            reference.sourceObjectId,
            prefix,
            childPrefix.length,
            childPrefix,
          ),
        );
        return { fields: rows.slice(0, 16), truncated: rows.length > 16 };
      };

      const startKey = catalogNodeKey(startObject.catalog, startObject.objectId);
      const nodes = new Map([[startKey, decorateNode(startObject, 0)]]);
      const queue = [{ object: startObject, distance: 0 }];
      const edges = [];
      const edgeKeys = new Set();
      const fetchLimit = Math.min(500, Math.max(50, limit * 5));
      const perNodeLimit = Math.min(20, Math.max(8, Math.ceil(limit / 2)));
      let truncated = false;

      while (queue.length > 0 && edges.length < limit) {
        const current = queue.shift();
        if (current.distance >= maxDepth) continue;
        let candidates = [];
        if (direction !== "incoming") {
          candidates.push(...rowsToPlain(outgoingStatement.all(
            current.object.catalog,
            current.object.objectId,
            minConfidence,
            fetchLimit,
          )).map((reference) => ({ ...reference, traversedAs: "outgoing" })));
        }
        if (direction !== "outgoing") {
          candidates.push(...rowsToPlain(incomingStatement.all(
            current.object.catalog,
            current.object.objectId,
            minConfidence,
            fetchLimit,
          )).map((reference) => ({ ...reference, traversedAs: "incoming" })));
        }
        candidates = candidates
          .map((reference) => {
            const kind = relationshipKind(reference);
            const neighbor = reference.traversedAs === "outgoing"
              ? { catalog: reference.targetCatalog, objectId: reference.targetObjectId }
              : { catalog: reference.sourceCatalog, objectId: reference.sourceObjectId };
            return { ...reference, kind, family: relationshipFamily(kind), neighbor };
          })
          .filter((reference) => relationshipAllowed(reference.kind, relationFamily))
          .sort((left, right) =>
            relationshipPriority(right.kind) - relationshipPriority(left.kind) ||
            relevanceScore(right.neighbor.catalog, right.neighbor.objectId) -
              relevanceScore(left.neighbor.catalog, left.neighbor.objectId) ||
            right.confidence - left.confidence ||
            left.sourceCatalog.localeCompare(right.sourceCatalog) ||
            left.sourceObjectId.localeCompare(right.sourceObjectId) ||
            left.fieldPath.localeCompare(right.fieldPath));
        if (candidates.length > perNodeLimit) truncated = true;

        for (const reference of candidates.slice(0, perNodeLimit)) {
          const edgeKey = [
            reference.sourceCatalog,
            reference.sourceObjectId,
            reference.fieldPath,
            reference.targetCatalog,
            reference.targetObjectId,
          ].join("\u0000").toLowerCase();
          if (edgeKeys.has(edgeKey)) continue;
          if (edges.length >= limit) {
            truncated = true;
            break;
          }
          edgeKeys.add(edgeKey);
          const fieldContext = contextFields(reference);
          edges.push({
            edgeId: `edge-${edges.length + 1}`,
            source: { catalog: reference.sourceCatalog, objectId: reference.sourceObjectId },
            fieldPath: reference.fieldPath,
            target: { catalog: reference.targetCatalog, objectId: reference.targetObjectId },
            relation: { kind: reference.kind, family: reference.family },
            confidence: reference.confidence,
            evidence: reference.evidence,
            contextFields: fieldContext.fields,
            contextFieldsTruncated: fieldContext.truncated,
          });

          const neighborObject = reference.traversedAs === "outgoing"
            ? {
                catalog: reference.targetCatalog,
                objectId: reference.targetObjectId,
                class: reference.targetClass,
                parentId: reference.targetParentId,
                isDefault: reference.targetIsDefault,
                sourceFile: reference.targetFile,
              }
            : {
                catalog: reference.sourceCatalog,
                objectId: reference.sourceObjectId,
                class: reference.sourceClass,
                parentId: reference.sourceParentId,
                isDefault: reference.sourceIsDefault,
                sourceFile: reference.sourceFile,
              };
          const neighborKey = catalogNodeKey(neighborObject.catalog, neighborObject.objectId);
          if (!nodes.has(neighborKey)) {
            nodes.set(neighborKey, decorateNode(neighborObject, current.distance + 1));
            queue.push({ object: neighborObject, distance: current.distance + 1 });
          }
        }
      }
      if (queue.length > 0 || edges.length >= limit) truncated = true;

      const adjacency = new Map();
      const addTraversal = (from, to, edge, traversal) => {
        const key = catalogNodeKey(from.catalog, from.objectId);
        if (!adjacency.has(key)) adjacency.set(key, []);
        adjacency.get(key).push({ from, to, edge, traversal });
      };
      for (const edge of edges) {
        if (direction !== "incoming") addTraversal(edge.source, edge.target, edge, "outgoing");
        if (direction !== "outgoing") addTraversal(edge.target, edge.source, edge, "incoming");
      }
      const paths = [];
      let pathsTruncated = false;
      const visitPaths = (currentNode, visited, steps) => {
        if (steps.length >= maxDepth || paths.length >= limit) {
          if (paths.length >= limit) pathsTruncated = true;
          return;
        }
        for (const traversal of adjacency.get(catalogNodeKey(currentNode.catalog, currentNode.objectId)) ?? []) {
          const nextKey = catalogNodeKey(traversal.to.catalog, traversal.to.objectId);
          if (visited.has(nextKey)) continue;
          const nextSteps = [...steps, {
            edgeId: traversal.edge.edgeId,
            traversal: traversal.traversal,
            relation: traversal.edge.relation.kind,
            from: traversal.from,
            to: traversal.to,
          }];
          paths.push({
            end: traversal.to,
            distance: nextSteps.length,
            steps: nextSteps,
          });
          if (paths.length >= limit) {
            pathsTruncated = true;
            return;
          }
          visitPaths(traversal.to, new Set([...visited, nextKey]), nextSteps);
          if (paths.length >= limit) return;
        }
      };
      visitPaths(
        { catalog: startObject.catalog, objectId: startObject.objectId },
        new Set([startKey]),
        [],
      );

      const nodeItems = [...nodes.values()].sort((left, right) =>
        left.distance - right.distance ||
        (left.commanderRelevance?.depth ?? 999) - (right.commanderRelevance?.depth ?? 999) ||
        left.catalog.localeCompare(right.catalog) ||
        left.objectId.localeCompare(right.objectId));
      return {
        operation: "relationships.trace",
        start: nodeItems.find((node) => catalogNodeKey(node.catalog, node.objectId) === startKey),
        commander: commander ? { ...commander } : null,
        query: {
          direction,
          maxDepth,
          minConfidence,
          relationFamily,
          includeFields,
          limit,
        },
        nodes: nodeItems,
        edges,
        paths,
        truncated: truncated || pathsTruncated,
      };
    });
  }

  function graphSlice(input) {
    const trace = relationshipsTrace({
      ...input,
      direction: input.direction ?? "both",
      relationFamily: input.relationFamily ?? "all",
      maxDepth: input.maxDepth ?? 3,
      minConfidence: input.minConfidence ?? 0.45,
      includeFields: input.includeFields ?? true,
      limit: input.limit ?? 100,
    });
    const { database, ...traceResult } = trace;
    const byCatalog = {};
    for (const node of traceResult.nodes) {
      if (!byCatalog[node.catalog]) byCatalog[node.catalog] = [];
      byCatalog[node.catalog].push(node.objectId);
    }
    const boundary = traceResult.nodes
      .filter((node) => node.distance === traceResult.query.maxDepth)
      .map((node) => ({ catalog: node.catalog, objectId: node.objectId }));
    return {
      database,
      operation: "graph.slice",
      start: traceResult.start,
      commander: traceResult.commander,
      query: traceResult.query,
      summary: {
        nodeCount: traceResult.nodes.length,
        edgeCount: traceResult.edges.length,
        catalogs: Object.fromEntries(
          Object.entries(byCatalog).map(([catalog, objectIds]) => [catalog, objectIds.length]),
        ),
      },
      nodesByCatalog: byCatalog,
      nodes: traceResult.nodes,
      edges: traceResult.edges,
      paths: traceResult.paths,
      boundary,
      completeness: traceResult.truncated ? "bounded-truncated" : "bounded-complete",
      warnings: [
        "This is an explicit bounded Catalog reference slice, not permission to clone every returned object.",
        "Enemy ownership and engine-default references are not proven by the commander membership graph.",
      ],
      truncated: traceResult.truncated,
    };
  }

  function impactAnalyze(input) {
    const catalog = requireString(input, "catalog");
    const objectId = requireString(input, "objectId");
    const targetPath = typeof input.path === "string" && input.path.trim() ? input.path.trim() : null;
    const requestedScope = normalizeImpactScope(input);
    const owner = normalizeImpactOwner(input) ?? (catalog === 'Unit' ? { catalog, objectId } : null);
    const changeType = input.changeType ?? (targetPath ? "scalar" : "structural");
    if (!["scalar", "structural", "reference"].includes(changeType)) {
      throw new CoopSearchError("changeType must be 'scalar', 'structural', or 'reference'.");
    }
    const maxDepth = input.maxDepth ?? 3;
    if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 4) {
      throw new CoopSearchError("maxDepth must be an integer between 1 and 4.");
    }
    const minConfidence = input.minConfidence ?? 0.45;
    if (typeof minConfidence !== "number" || minConfidence < 0 || minConfidence > 1) {
      throw new CoopSearchError("minConfidence must be a number between 0 and 1.");
    }
    const limit = clampLimit(input.limit ?? 100);

    return withDatabase((database) => {
      const readObject = database.prepare(`
        SELECT catalog, object_id AS objectId, class, parent_id AS parentId,
               source_file AS sourceFile
        FROM catalog_objects WHERE lower(catalog)=lower(?) AND lower(object_id)=lower(?)
      `);
      const start = readObject.get(catalog, objectId);
      if (!start) throw new CoopSearchError(`Unknown Catalog object: ${catalog}/${objectId}`);
      if (
        requestedScope?.kind === "commander" &&
        !database.prepare("SELECT 1 FROM commanders WHERE lower(id)=lower(?)").get(requestedScope.commanderId)
      ) {
        throw new CoopSearchError(`Unknown commander scope: ${requestedScope.commanderId}`);
      }
      if (owner && !readObject.get(owner.catalog, owner.objectId)) {
        throw new CoopSearchError(`Unknown isolation owner: ${owner.catalog}/${owner.objectId}`);
      }
      const incoming = database.prepare(`
        SELECT r.source_catalog AS sourceCatalog, r.source_object_id AS sourceObjectId,
               r.field_path AS fieldPath, r.confidence, r.evidence,
               o.class, o.parent_id AS parentId, o.source_file AS sourceFile
        FROM object_references r
        JOIN catalog_objects o
          ON o.catalog=r.source_catalog AND o.object_id=r.source_object_id
        WHERE r.target_catalog=? AND r.target_object_id=? AND r.confidence>=?
        ORDER BY r.confidence DESC, r.source_catalog, r.source_object_id, r.field_path
        LIMIT ?
      `);
      const memberships = database.prepare(`
        SELECT m.commander_id AS commanderId, c.commander_object_id AS commanderObjectId,
               c.name_zhcn AS nameZhCN, c.name_enus AS nameEnUS,
               m.evidence, m.depth
        FROM commander_membership m
        JOIN commanders c ON c.id=m.commander_id
        WHERE m.catalog=? AND m.object_id=?
        ORDER BY m.depth, m.commander_id, m.evidence
      `);
      const directOutgoing = database.prepare(`
        SELECT r.field_path AS fieldPath, r.target_catalog AS targetCatalog,
               r.target_object_id AS targetObjectId, r.confidence, r.evidence,
               target.class AS targetClass, target.parent_id AS targetParentId,
               target.source_file AS targetSourceFile
        FROM object_references r
        JOIN catalog_objects target
          ON target.catalog=r.target_catalog AND target.object_id=r.target_object_id
        WHERE r.source_catalog=? AND r.source_object_id=? AND r.confidence>=?
        ORDER BY r.confidence DESC, r.field_path, r.target_catalog, r.target_object_id
        LIMIT ?
      `);
      const membershipCache = new Map();
      const membershipRowsFor = (nodeCatalog, nodeObjectId) => {
        const key = catalogNodeKey(nodeCatalog, nodeObjectId);
        if (!membershipCache.has(key)) {
          membershipCache.set(key, rowsToPlain(memberships.all(nodeCatalog, nodeObjectId)));
        }
        return membershipCache.get(key);
      };

      const startKey = catalogNodeKey(start.catalog, start.objectId);
      const nodes = new Map([[startKey, { ...start, distance: 0 }]]);
      const queue = [{ ...start, distance: 0 }];
      const edges = [];
      let truncated = false;
      const fetchLimit = Math.min(500, Math.max(50, limit * 3));
      while (queue.length > 0 && edges.length < limit) {
        const current = queue.shift();
        if (current.distance >= maxDepth) continue;
        const rows = rowsToPlain(incoming.all(
          current.catalog,
          current.objectId,
          minConfidence,
          fetchLimit,
        ));
        if (rows.length >= fetchLimit) truncated = true;
        for (const row of rows) {
          if (edges.length >= limit) {
            truncated = true;
            break;
          }
          const source = { catalog: row.sourceCatalog, objectId: row.sourceObjectId };
          const target = { catalog: current.catalog, objectId: current.objectId };
          edges.push({
            source,
            fieldPath: row.fieldPath,
            target,
            confidence: row.confidence,
            evidence: row.evidence,
            relation: relationshipKind({
              sourceCatalog: row.sourceCatalog,
              targetCatalog: current.catalog,
              sourceClass: row.class,
              fieldPath: row.fieldPath,
            }),
          });
          const key = catalogNodeKey(row.sourceCatalog, row.sourceObjectId);
          if (!nodes.has(key)) {
            const node = {
              catalog: row.sourceCatalog,
              objectId: row.sourceObjectId,
              class: row.class,
              parentId: row.parentId,
              sourceFile: row.sourceFile,
              distance: current.distance + 1,
            };
            nodes.set(key, node);
            queue.push(node);
          }
        }
      }
      if (queue.length > 0) truncated = true;

      const commanderMap = new Map();
      const nodeMemberships = new Map();
      for (const node of nodes.values()) {
        const rows = membershipRowsFor(node.catalog, node.objectId);
        nodeMemberships.set(catalogNodeKey(node.catalog, node.objectId), rows);
        for (const row of rows) {
          let commander = commanderMap.get(row.commanderId);
          if (!commander) {
            commander = {
              commanderId: row.commanderId,
              commanderObjectId: row.commanderObjectId,
              nameZhCN: row.nameZhCN,
              nameEnUS: row.nameEnUS,
              minimumGraphDistance: node.distance,
              minimumMembershipDepth: row.depth,
              evidence: [],
            };
            commanderMap.set(row.commanderId, commander);
          }
          commander.minimumGraphDistance = Math.min(commander.minimumGraphDistance, node.distance);
          commander.minimumMembershipDepth = Math.min(commander.minimumMembershipDepth, row.depth);
          commander.evidence.push({
            catalog: node.catalog,
            objectId: node.objectId,
            graphDistance: node.distance,
            membershipDepth: row.depth,
            source: row.evidence,
          });
        }
      }
      const commanders = [...commanderMap.values()].sort((left, right) =>
        left.minimumGraphDistance - right.minimumGraphDistance ||
        left.minimumMembershipDepth - right.minimumMembershipDepth ||
        left.commanderId.localeCompare(right.commanderId));
      const unownedConsumers = [...nodes.values()].filter((node) =>
        node.distance > 0 &&
        ["Unit", "Abil", "Weapon", "Effect", "Upgrade"].includes(node.catalog) &&
        (nodeMemberships.get(catalogNodeKey(node.catalog, node.objectId)) ?? []).length === 0);
      const classification = commanders.length > 1
        ? "shared-across-commanders"
        : commanders.length === 1 ? "commander-associated" : "unresolved";
      const advice = classification === "shared-across-commanders"
        ? "Default to a private owner/dependency slice. Use a commander Upgrade shortcut only for the exact whitelisted scalar target or an existing scoped edit."
        : classification === "commander-associated"
          ? "Commander association is evidence, not proof of exclusivity; inspect unowned consumers before a global override."
          : "Do not assume this object is safe to modify globally; no commander ownership was proven.";
      const affectedUnits = [...nodes.values()]
        .filter((node) => node.catalog.toLowerCase() === "unit")
        .sort((left, right) => left.distance - right.distance || left.objectId.localeCompare(right.objectId));
      const requestedIsolation = input.includeIsolationPlan === true
        ? isolationPlan({
            requestedScope,
            owner,
            changeType,
            start,
            edges,
            nodes,
            nodeMemberships,
            truncated,
            inspectEdit: (catalog, id, field) => activeProjection.projection.inspect(catalog, id, field),
            targetEdit: targetPath ? activeProjection.projection.inspect(start.catalog, start.objectId, targetPath) : null,
            targetPath,
            localObject: !database.prepare('SELECT 1 FROM main.catalog_objects WHERE catalog=? AND object_id=?').get(start.catalog, start.objectId),
          })
        : null;
      const outgoingRows = rowsToPlain(directOutgoing.all(
        start.catalog,
        start.objectId,
        minConfidence,
        limit + 1,
      ));
      const dependenciesTruncated = outgoingRows.length > limit;
      const directDependencies = outgoingRows.slice(0, limit).map((row) => ({
        source: { catalog: start.catalog, objectId: start.objectId },
        fieldPath: row.fieldPath,
        target: { catalog: row.targetCatalog, objectId: row.targetObjectId },
        targetClass: row.targetClass,
        targetParentId: row.targetParentId,
        targetSourceFile: row.targetSourceFile,
        confidence: row.confidence,
        evidence: row.evidence,
        relation: relationshipKind({
          sourceCatalog: start.catalog,
          targetCatalog: row.targetCatalog,
          sourceClass: start.class,
          fieldPath: row.fieldPath,
        }),
      }));
      const profileBindings = profileBindingsForObject(database, start);
      const targetKinds = semanticTargetKinds(database, start, profileBindings);
      for (const edge of directDependencies) {
        edge.semanticRole = semanticDependencyRole(targetKinds, edge);
      }
      const directConsumerEdges = edges.filter((edge) =>
        catalogNodeKey(edge.target.catalog, edge.target.objectId) === startKey);
      const consumerGroups = groupSemanticReferences(directConsumerEdges, {
        direction: "incoming",
        targetKinds,
        nodeMemberships: membershipRowsFor,
        requestedScope,
      });
      const catalogEntrypointGroups = consumerGroups.filter((group) =>
        semanticEntrypointRole(targetKinds, group.role));
      const profileEntrypoints = profileBindingEntrypoints(profileBindings, requestedScope);
      const entrypointGroups = mergeSemanticGroups(catalogEntrypointGroups, profileEntrypoints);
      const dependencyGroups = groupSemanticReferences(directDependencies, {
        direction: "outgoing",
        targetKinds,
        nodeMemberships: membershipRowsFor,
        requestedScope,
      });
      const sharedDependencies = analyzeSharedDependencies({
        database,
        start,
        directDependencies,
        membershipRowsFor,
        requestedScope,
      });
      const semanticImpact = {
        schemaVersion: 1,
        targetKinds,
        owners: semanticOwnerSummary(
          membershipRowsFor(start.catalog, start.objectId),
          profileBindings,
        ),
        entrypoints: {
          itemCount: entrypointGroups.reduce((total, group) => total + group.itemCount, 0),
          groups: entrypointGroups,
        },
        consumers: {
          itemCount: consumerGroups.reduce((total, group) => total + group.itemCount, 0),
          groups: consumerGroups,
        },
        dependencies: {
          itemCount: dependencyGroups.reduce((total, group) => total + group.itemCount, 0),
          groups: dependencyGroups,
        },
        sharedDependencies,
        completeness: dependenciesTruncated || truncated || sharedDependencies.truncated
          ? "bounded-truncated"
          : "bounded-complete",
        warnings: [
          "Semantic groups contain only explicit Catalog references and commander-profile bindings.",
          "Shared-dependency evidence is bounded and does not prove the absence of Galaxy, enemy, or engine-default consumers.",
        ],
      };
      return {
        operation: "impact.analyze",
        target: { ...start, path: targetPath },
        query: {
          maxDepth,
          minConfidence,
          limit,
          requestedScope,
          owner,
          changeType,
          includeIsolationPlan: input.includeIsolationPlan === true,
        },
        scope: {
          classification,
          commanderCount: commanders.length,
          sharedAcrossCommanders: commanders.length > 1,
          nonCommanderImpact: unownedConsumers.length > 0 ? "possible" : "unknown",
          enemyUsage: "unknown",
          risk: commanders.length > 1 || unownedConsumers.length > 0 ? "high" : "unknown",
          advice,
        },
        commanders,
        affectedUnits,
        directConsumers: directConsumerEdges.map((edge) => ({
            catalog: edge.source.catalog,
            objectId: edge.source.objectId,
            fieldPath: edge.fieldPath,
            relation: edge.relation,
            confidence: edge.confidence,
          })),
        directDependencies: directDependencies.map((edge) => ({
          catalog: edge.target.catalog,
          objectId: edge.target.objectId,
          fieldPath: edge.fieldPath,
          relation: edge.relation,
          semanticRole: edge.semanticRole,
          confidence: edge.confidence,
        })),
        semanticImpact,
        unownedConsumers,
        nodes: [...nodes.values()].sort((left, right) =>
          left.distance - right.distance || left.catalog.localeCompare(right.catalog) || left.objectId.localeCompare(right.objectId)),
        edges,
        ...(requestedIsolation ? { isolation: requestedIsolation } : {}),
        ...(requestedIsolation ? { authoringWorkflow: isolationWorkflow(repoRoot, requestedIsolation) } : {}),
        warnings: [
          "Catalog references cannot prove that enemy compositions or map Galaxy scripts do not use this object.",
          ...(targetPath ? ["The reference graph is object-level; the requested field path narrows the intended write, not the graph edges."] : []),
        ],
        truncated,
      };
    });
  }

  function requirementExplain(input) {
    const objectId = requireString(input, "objectId");
    const limit = clampLimit(input.limit ?? 100);
    const requestedDepth = input.maxDepth ?? 8;
    if (!Number.isInteger(requestedDepth) || requestedDepth < 1 || requestedDepth > 12) {
      throw new CoopSearchError("maxDepth must be an integer between 1 and 12 for requirement.explain.");
    }
    return withDatabase((database) => {
      const readObject = database.prepare(`
        SELECT catalog, object_id AS objectId, class, parent_id AS parentId,
               source_file AS sourceFile
        FROM catalog_objects
        WHERE lower(catalog)='requirement' AND lower(object_id)=lower(?)
      `);
      const readFields = database.prepare(`
        SELECT path, value, source_file AS sourceFile, origin_object_id AS originObjectId,
               inheritance_depth AS inheritanceDepth
        FROM catalog_fields
        WHERE lower(catalog)='requirement' AND object_id=? ORDER BY path
      `);
      const start = readObject.get(objectId);
      if (!start) throw new CoopSearchError(`Unknown Requirement object: ${objectId}`);
      let visitedCount = 0;
      let partial = false;
      const warnings = [];
      const unsupported = new Set();

      const describeLeaf = (object, fields) => {
        const values = new Map(fields.map((field) => [field.path, field.value]));
        const type = object.class.replace(/^CRequirement/, "") || "Wrapper";
        const countMatch = /^Count(.+)$/.exec(type);
        if (countMatch) {
          const subject = values.get("Count.@Link") ?? null;
          const state = values.get("Count.@State") ?? null;
          if (!subject) {
            partial = true;
            warnings.push(`${object.objectId} does not materialize Count.@Link; an engine default may apply.`);
          }
          return {
            kind: "count",
            subjectCatalog: countMatch[1],
            subject,
            state,
            summary: `${countMatch[1]} ${subject ?? "?"} must be ${state ?? "the required state"}`,
          };
        }
        const allowMatch = /^Allow(.+)$/.exec(type);
        if (allowMatch) {
          const subject = values.get("Link") ?? values.get("Allow.@Link") ?? null;
          if (!subject) {
            partial = true;
            warnings.push(`${object.objectId} does not materialize its allowed object link.`);
          }
          return {
            kind: "allow",
            subjectCatalog: allowMatch[1],
            subject,
            summary: `${allowMatch[1]} ${subject ?? "?"} must be allowed`,
          };
        }
        if (type === "Const") {
          const value = values.get("Value") ?? null;
          if (value === null) {
            partial = true;
            warnings.push(`${object.objectId} does not materialize its constant Value.`);
          }
          return { kind: "constant", value: value === null ? null : scalarValue(value), summary: `constant ${value ?? "?"}` };
        }
        unsupported.add(object.class);
        partial = true;
        return { kind: "raw", summary: `${object.class} ${object.objectId}` };
      };

      const buildExpression = (nodeId, depth, stack) => {
        if (visitedCount >= limit) {
          partial = true;
          return { objectId: nodeId, kind: "limit", summary: "node limit reached" };
        }
        if (depth > requestedDepth) {
          partial = true;
          return { objectId: nodeId, kind: "depth-limit", summary: "depth limit reached" };
        }
        const key = nodeId.toLowerCase();
        if (stack.has(key)) {
          partial = true;
          warnings.push(`Requirement cycle detected at ${nodeId}.`);
          return { objectId: nodeId, kind: "cycle", summary: "cycle detected" };
        }
        const object = readObject.get(nodeId);
        if (!object) {
          partial = true;
          warnings.push(`Requirement node ${nodeId} is missing.`);
          return { objectId: nodeId, kind: "missing", summary: "missing requirement node" };
        }
        visitedCount += 1;
        const fields = rowsToPlain(readFields.all(object.objectId));
        const nextStack = new Set([...stack, key]);
        const operands = fields
          .filter((field) => /^OperandArray(?:\[|$)/.test(field.path))
          .map((field) => field.value)
          .filter(Boolean);
        if (["CRequirementAnd", "CRequirementOr", "CRequirementXor"].includes(object.class)) {
          const kind = object.class === "CRequirementAnd"
            ? "all"
            : object.class === "CRequirementOr" ? "any" : "xor";
          const children = operands.map((operand) => buildExpression(operand, depth + 1, nextStack));
          return {
            objectId: object.objectId,
            class: object.class,
            kind,
            summary: kind === "all"
              ? "all child requirements must pass"
              : kind === "any" ? "any child requirement may pass" : "exactly one child requirement must pass",
            children,
            fields,
          };
        }
        if (["CRequirementNot", "CRequirementOdd"].includes(object.class)) {
          const childId = operands[0] ?? null;
          if (!childId) {
            partial = true;
            warnings.push(`${object.objectId} has no materialized operand.`);
          }
          return {
            objectId: object.objectId,
            class: object.class,
            kind: "not",
            summary: "the child requirement must not pass",
            child: childId ? buildExpression(childId, depth + 1, nextStack) : null,
            fields,
          };
        }
        const comparison = /^CRequirement(Eq|NE|GT|GTE|LT|LTE)$/.exec(object.class);
        if (comparison) {
          const children = operands.slice(0, 2).map((operand) => buildExpression(operand, depth + 1, nextStack));
          if (children.length < 2) {
            partial = true;
            warnings.push(`${object.objectId} does not materialize both comparison operands.`);
          }
          return {
            objectId: object.objectId,
            class: object.class,
            kind: "compare",
            operator: comparison[1],
            summary: `compare child values with ${comparison[1]}`,
            children,
            fields,
          };
        }
        const arithmetic = /^CRequirement(Sum|Mul|Div|Mod)$/.exec(object.class);
        if (arithmetic) {
          return {
            objectId: object.objectId,
            class: object.class,
            kind: "arithmetic",
            operator: arithmetic[1].toLowerCase(),
            summary: `${arithmetic[1].toLowerCase()} child values`,
            children: operands.map((operand) => buildExpression(operand, depth + 1, nextStack)),
            fields,
          };
        }
        return {
          objectId: object.objectId,
          class: object.class,
          ...describeLeaf(object, fields),
          fields,
        };
      };

      const fields = rowsToPlain(readFields.all(start.objectId));
      const rootFields = fields.filter((field) => /^NodeArray\[.+\]\.@Link$/.test(field.path));
      const phases = rootFields.map((field) => {
        const phase = /^NodeArray\[([^\]]+)\]/.exec(field.path)?.[1] ?? "Unknown";
        return {
          phase,
          rootObjectId: field.value,
          expression: buildExpression(field.value, 1, new Set([start.objectId.toLowerCase()])),
        };
      });
      if (phases.length === 0 && start.class !== "CRequirement") {
        phases.push({
          phase: "Node",
          rootObjectId: start.objectId,
          expression: buildExpression(start.objectId, 1, new Set()),
        });
      } else if (phases.length === 0) {
        partial = true;
        warnings.push(`${start.objectId} has no materialized NodeArray phase links.`);
      }
      if (unsupported.size > 0) {
        warnings.push(`Unsupported Requirement classes are returned with raw fields: ${[...unsupported].sort().join(", ")}.`);
      }
      return {
        operation: "requirement.explain",
        requirement: { ...start },
        phases,
        complete: !partial,
        partial,
        visitedNodes: visitedCount,
        unsupportedClasses: [...unsupported].sort(),
        semantics: "This explains Catalog conditions only; it does not evaluate a live player's state.",
        warnings,
      };
    });
  }

  function galaxyContext(input) {
    const query = requireString(input, "query");
    const full = input.detailLevel === "full";
    const requestedLimit = clampLimit(input.limit ?? (full ? DEFAULT_GALAXY_LIMIT : 3));
    const limit = Math.min(requestedLimit, MAX_GALAXY_LIMIT);
    const requestedCommanderId = typeof input.commanderId === "string" && input.commanderId.trim()
      ? input.commanderId.trim()
      : null;
    return withDatabase((database) => {
      const tables = new Set(
        database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name),
      );
      if (!tables.has("galaxy_files") || !tables.has("galaxy_symbols")) {
        throw new CoopSearchError(
          "The co-op database does not contain Galaxy source indexes; rebuild the local database.",
        );
      }

      let commander = null;
      if (requestedCommanderId) {
        commander = database.prepare(`
          SELECT id, commander_object_id AS commanderObjectId,
                 name_zhcn AS nameZhCN, name_enus AS nameEnUS
          FROM commanders
          WHERE lower(id)=lower(?) OR lower(commander_object_id)=lower(?)
        `).get(requestedCommanderId, requestedCommanderId);
        if (!commander) throw new CoopSearchError(`Unknown commander: ${requestedCommanderId}`);
        commander = { ...commander };
      }

      const matchingSymbolNames = database.prepare(`
        SELECT count(DISTINCT lower(name)) AS value
        FROM galaxy_symbols
        WHERE instr(lower(name), lower(?)) > 0
      `).get(query).value;
      const exactSymbol = database.prepare(`
        SELECT name FROM galaxy_symbols
        WHERE lower(name)=lower(?)
        ORDER BY name, source_file, line LIMIT 1
      `).get(query);
      const symbolRows = rowsToPlain(database.prepare(`
        SELECT s.source_file AS sourceFile, s.name, s.kind, s.line,
               g.package_id AS packageId, g.sha256 AS sourceSha256, g.contents,
               CASE
                 WHEN lower(s.name)=lower(?) THEN 'exact'
                 WHEN lower(s.name) LIKE lower(?) || '%' THEN 'prefix'
                 ELSE 'substring'
               END AS matchType
        FROM galaxy_symbols s
        LEFT JOIN galaxy_files g ON g.source_file=s.source_file
        WHERE instr(lower(s.name), lower(?)) > 0
        ORDER BY CASE matchType WHEN 'exact' THEN 0 WHEN 'prefix' THEN 1 ELSE 2 END,
                 length(s.name), s.name, s.source_file, s.line
        LIMIT ?
      `).all(query, query, query, limit + 1));
      const selectedRows = exactSymbol ? symbolRows.filter((row) => row.matchType === "exact") : symbolRows;
      const symbolTruncated = selectedRows.length > limit;
      const visibleSymbolRows = selectedRows.slice(0, limit);
      const parsedFiles = new Map();
      const definitions = visibleSymbolRows.map((row) => {
        const line = row.contents === null || row.contents === undefined
          ? row.line
          : locateGalaxySymbolLine(row.contents, row.line, row.name, row.kind);
        if (!parsedFiles.has(row.sourceFile)) parsedFiles.set(row.sourceFile, extractGalaxySymbols(row.contents ?? ""));
        const declaration = parsedFiles.get(row.sourceFile).filter((s) => s.name === row.name)
          .sort((a, b) => Math.abs(a.line - line) - Math.abs(b.line - line))[0];
        const body=full&&declaration?.kind==='function'&&row.contents
          ? galaxyFunctionBody(row.contents,line) : null;
        const called=body?[...body.text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map(match=>match[1])
          .filter(name=>name!==row.name):[];
        const dependencies=[];
        for(const name of [...new Set(called)]) {
          const dependency=database.prepare(`SELECT s.name,s.kind,s.source_file AS sourceFile,s.line,g.sha256 AS sourceSha256
            FROM galaxy_symbols s LEFT JOIN galaxy_files g ON g.source_file=s.source_file
            WHERE lower(s.name)=lower(?) AND s.kind IN ('function','native') ORDER BY s.source_file,s.line LIMIT 1`).get(name);
          if(dependency)dependencies.push({...dependency,nextQuery:{operation:'galaxy.context',query:dependency.name,detailLevel:'full'}});
          if(dependencies.length>=8)break;
        }
        return {
          name: row.name,
          kind: row.kind,
          matchType: row.matchType,
          sourceFile: row.sourceFile,
          sourceSha256: row.sourceSha256 ?? null,
          packageId: row.packageId ?? null,
          line,
          indexedLine: row.line,
          signature: declaration?.signature.slice(0, 1500) ?? null,
          ...(declaration?.parameters ? { returnType: declaration.returnType, parameters: declaration.parameters } : {}),
          ...(declaration?.kind === "constant" ? { type: declaration.type, value: declaration.value.slice(0, 1500) } : {}),
          snippet: row.contents === null || row.contents === undefined
            ? null
            : galaxySnippet(row.contents, line, full ? GALAXY_CONTEXT_RADIUS : 0),
          ...(body?{body,dependencies,dependenciesTruncated:new Set(called).size>dependencies.length}:{}),
        };
      });

      const uniqueVisibleNames = [...new Set(visibleSymbolRows.map((row) => row.name))];
      const referenceTerm = exactSymbol?.name ??
        (matchingSymbolNames === 1 && uniqueVisibleNames.length === 1 ? uniqueVisibleNames[0] : query);
      const exactDefinitionRows = rowsToPlain(database.prepare(`
        SELECT s.source_file AS sourceFile, s.name, s.kind, s.line, g.contents
        FROM galaxy_symbols s LEFT JOIN galaxy_files g ON g.source_file=s.source_file
        WHERE lower(s.name)=lower(?)
      `).all(referenceTerm));
      const definitionKeys = new Set(exactDefinitionRows.map((row) => {
        const line = row.contents === null || row.contents === undefined
          ? row.line
          : locateGalaxySymbolLine(row.contents, row.line, row.name, row.kind);
        return `${row.sourceFile.toLowerCase()}:${line}`;
      }));
      const referenceLimit = full ? Math.min(60, limit * 3) : Math.min(2, limit);
      const referenceFileLimit = Math.min(50, Math.max(8, limit * 4));
      const referenceFileRows = rowsToPlain(database.prepare(`
        SELECT source_file AS sourceFile, package_id AS packageId, contents
        FROM galaxy_files
        WHERE instr(lower(contents), lower(?)) > 0
        ORDER BY source_file LIMIT ?
      `).all(referenceTerm, referenceFileLimit + 1));
      const referenceFilesTruncated = referenceFileRows.length > referenceFileLimit;
      const references = [];
      let referenceOccurrencesTruncated = false;
      const referencePattern = galaxyIdentifierPattern(referenceTerm);
      for (const file of referenceFileRows.slice(0, referenceFileLimit)) {
        const lines = String(file.contents).replaceAll("\r\n", "\n").split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          if (!referencePattern.test(lines[index])) continue;
          const line = index + 1;
          if (definitionKeys.has(`${file.sourceFile.toLowerCase()}:${line}`)) continue;
          if (references.length >= referenceLimit) {
            referenceOccurrencesTruncated = true;
            break;
          }
          references.push({
            sourceFile: file.sourceFile,
            packageId: file.packageId,
            line,
            snippet: galaxySnippet(file.contents, line, full ? GALAXY_CONTEXT_RADIUS : 1),
          });
        }
        if (referenceOccurrencesTruncated) break;
      }

      const evidenceTexts = [
        query,
        referenceTerm,
        ...definitions.map((item) => item.snippet?.text ?? ""),
        ...references.map((item) => item.snippet.text),
      ];
      const tokens = orderedGalaxyTokens(evidenceTexts);
      const tokenOrder = new Map(tokens.map((token, index) => [token.toLowerCase(), index]));
      let relatedCatalogObjects = [];
      if (full && tokens.length > 0) {
        const placeholders = tokens.map(() => "?").join(",");
        relatedCatalogObjects = rowsToPlain(database.prepare(`
          SELECT catalog, object_id AS objectId, class, source_file AS sourceFile
          FROM catalog_objects WHERE object_id IN (${placeholders})
        `).all(...tokens));
        const membership = commander
          ? database.prepare(`
              SELECT evidence, depth FROM commander_membership
              WHERE commander_id=? AND catalog=? AND object_id=?
              ORDER BY depth, evidence
            `)
          : null;
        relatedCatalogObjects = relatedCatalogObjects
          .map((item) => ({
            ...item,
            commanderEvidence: membership
              ? rowsToPlain(membership.all(commander.id, item.catalog, item.objectId))
              : [],
          }))
          .sort((left, right) =>
            (tokenOrder.get(left.objectId.toLowerCase()) ?? Number.MAX_SAFE_INTEGER) -
              (tokenOrder.get(right.objectId.toLowerCase()) ?? Number.MAX_SAFE_INTEGER) ||
            left.catalog.localeCompare(right.catalog) || left.objectId.localeCompare(right.objectId))
          .slice(0, 30);
      }

      const tokenSet = new Set(tokens.map((token) => token.toLowerCase()));
      const relatedCommanders = full ? rowsToPlain(database.prepare(`
        SELECT id, commander_object_id AS commanderObjectId,
               name_zhcn AS nameZhCN, name_enus AS nameEnUS
        FROM commanders ORDER BY id
      `).all()).filter((item) =>
        tokenSet.has(item.id.toLowerCase()) || tokenSet.has(item.commanderObjectId.toLowerCase())) : [];
      const warnings = [
        "References are bounded textual source matches, not a complete Galaxy call graph.",
        ...(full ? ["Related Catalog objects are exact IDs observed in returned snippets; commander membership is association evidence, not proof of exclusivity."] : []),
      ];
      const symbolVersion = Number(database.prepare("SELECT value FROM meta WHERE key='galaxySymbolVersion'").get()?.value ?? 1);
      if (symbolVersion < GALAXY_SYMBOL_VERSION) {
        warnings.push("Galaxy symbol index is outdated; run scripts/casc-database.mjs reindex-galaxy on this local database to include native declarations and constants. Missing definitions are not proof that an API does not exist.");
      }
      if (!exactSymbol && matchingSymbolNames > 1) {
        warnings.push("The query matched multiple symbol names, so references use the literal query text.");
      }
      if (matchingSymbolNames === 0) {
        warnings.push("No Galaxy symbol definition matched; source references use the literal query text.");
      }
      if (symbolTruncated || referenceFilesTruncated || referenceOccurrencesTruncated || requestedLimit > limit) {
        warnings.push(full ? "Results were truncated by Galaxy context safety limits."
          : "Examples are intentionally limited; expand only if the returned contract leaves a specific question unanswered.");
      }
      return {
        operation: "galaxy.context",
        detailLevel: full ? "full" : "overview",
        query,
        scope: { commander: commander ?? null },
        lookup: {
          referenceTerm,
          exactSymbol: exactSymbol?.name ?? null,
          matchingSymbolNames,
        },
        definitions,
        references,
        ...(full ? { relatedCatalogObjects, relatedCommanders } : {}),
        guidance: full ? "Source evidence is not a compiler or a runtime test."
          : "Use signature/parameters as the declaration contract. Expand with detailLevel: full only for a specific unresolved implementation detail; do not recursively look up every symbol in examples.",
        truncated: {
          definitions: symbolTruncated,
          referenceFiles: referenceFilesTruncated,
          references: referenceOccurrencesTruncated,
          catalogObjects: relatedCatalogObjects.length >= 30,
          requestedLimitCapped: requestedLimit > limit,
        },
        limits: {
          definitions: limit,
          references: referenceLimit,
          contextLinesBeforeAndAfter: full ? GALAXY_CONTEXT_RADIUS : 1,
        },
        warnings,
      };
    });
  }

  function patchesForTarget(input) {
    return readGameAConsistently(repoRoot, () => patchesForTargetLocked(input));
  }

  function patchesForTargetLocked(input) {
    const targetInput = typeof input.target === "string" && input.target.trim()
      ? input.target.trim().replaceAll("\\", "/")
      : null;
    const catalog = typeof input.catalog === "string" && input.catalog.trim()
      ? input.catalog.trim().toLowerCase()
      : null;
    const objectId = typeof input.objectId === "string" && input.objectId.trim()
      ? input.objectId.trim().toLowerCase()
      : null;
    const fieldPath = typeof input.path === "string" && input.path.trim()
      ? canonicalCatalogPath(input.path)
      : null;
    const commanderId = typeof input.commanderId === "string" && input.commanderId.trim()
      ? input.commanderId.trim().toLowerCase()
      : null;
    if (!targetInput && !catalog && !objectId) {
      throw new CoopSearchError("patches.for_target requires target or catalog/objectId.");
    }
    const limit = clampLimit(input.limit ?? 50);
    const patchesRoot = path.join(repoRoot, "game-a", "patches");
    const matches = [];
    if (existsSync(patchesRoot)) {
      for (const name of readdirSync(patchesRoot).filter((entry) => entry.endsWith(".receipt.json")).sort()) {
        let receipt;
        try {
          receipt = readJson(path.join(patchesRoot, name));
        } catch (error) {
          throw new CoopSearchError(`Unable to read PatchPlan receipt ${name}.`, {
            cause: error instanceof Error ? error.message : String(error),
          });
        }
        if (typeof receipt.planId !== "string" || `${receipt.planId}.receipt.json` !== name) {
          throw new CoopSearchError(`PatchPlan receipt filename does not match planId: ${name}.`, {
            planId: receipt.planId ?? null,
          });
        }
        const planFile = path.join(patchesRoot, `${receipt.planId}.patch-plan.json`);
        let plan = null;
        if (existsSync(planFile)) {
          try {
            plan = readJson(planFile);
          } catch (error) {
            throw new CoopSearchError(`Unable to read applied PatchPlan ${receipt.planId}.`, {
              cause: error instanceof Error ? error.message : String(error),
            });
          }
          if (plan.id !== receipt.planId) {
            throw new CoopSearchError(`Applied PatchPlan id does not match its receipt: ${receipt.planId}.`, {
              planId: plan.id ?? null,
            });
          }
        }
        const operationsById = new Map((plan?.operations ?? []).map((operation) => [operation.opId, operation]));
        for (const receiptOperation of receipt.operations ?? []) {
          const operation = operationsById.get(receiptOperation.opId) ?? null;
          const receiptTargets = Array.isArray(receiptOperation.targets) && receiptOperation.targets.length > 0
            ? receiptOperation.targets
            : receiptOperation.target ? [receiptOperation.target] : [];
          const allTargets = [...new Set([
            ...receiptTargets,
            ...(operation ? operationTargets(operation) : []),
          ])];
          const conflictingTargets = targetInput
            ? allTargets.filter((candidate) => targetsConflict(targetInput, candidate))
            : [];
          const semanticTargets = targetInput
            ? allTargets.filter((candidate) =>
                !targetsConflict(targetInput, candidate) && targetsSemanticallyOverlap(targetInput, candidate))
            : [];
          const targetMatches = targetInput
            ? conflictingTargets.length > 0 || semanticTargets.length > 0
            : operation
              ? operationTouchesCatalogTarget(operation, {
                  catalog,
                  objectId,
                  path: fieldPath,
                  commanderId,
                })
              : allTargets.some((candidate) => targetTouchesCatalogQuery(candidate, {
                  catalog,
                  objectId,
                  path: fieldPath,
                  commanderId,
                }));
          if (!targetMatches) continue;
          const exactTarget = targetInput
            ? allTargets.some((candidate) => candidate.toLowerCase() === targetInput.toLowerCase())
            : false;
          matches.push({
            planId: receipt.planId,
            title: plan?.title ?? receipt.planId,
            appliedAt: receipt.appliedAt,
            planSha256: receipt.planSha256,
            dependsOn: plan?.dependsOn ?? [],
            conflictsWith: plan?.conflictsWith ?? [],
            planAvailable: Boolean(plan),
            receiptPath: path.posix.join("game-a", "patches", name),
            match: targetInput
              ? exactTarget ? "exact" : conflictingTargets.length > 0 ? "executor-conflict" : "semantic-overlap"
              : "semantic",
            executorConflict: targetInput ? conflictingTargets.length > 0 : null,
            matchedTargets: targetInput ? [...conflictingTargets, ...semanticTargets] : allTargets,
            operation: {
              opId: receiptOperation.opId,
              kind: receiptOperation.kind,
              target: receiptOperation.target,
              targets: allTargets,
              status: receiptOperation.status,
              verified: receiptOperation.verified,
              expect: operation && Object.hasOwn(operation, "expect") ? operation.expect : undefined,
              value: operation && Object.hasOwn(operation, "value") ? operation.value : undefined,
              commanderId: operation?.commanderId ?? null,
            },
          });
        }
      }
    }
    matches.sort((left, right) =>
      String(left.appliedAt).localeCompare(String(right.appliedAt)) ||
      left.planId.localeCompare(right.planId) ||
      left.operation.opId.localeCompare(right.operation.opId));
    const items = matches.slice(Math.max(0, matches.length - limit));
    const latest = items.at(-1) ?? null;
    const requiredDependsOn = [...new Set(
      matches.filter((item) => item.executorConflict === true).map((item) => item.planId),
    )];
    const semanticOverlaps = matches
      .filter((item) => item.match === "semantic-overlap")
      .map((item) => ({
        planId: item.planId,
        opId: item.operation.opId,
        target: item.operation.target,
        matchedTargets: item.matchedTargets,
      }));
    return {
      operation: "patches.for_target",
      query: {
        target: targetInput,
        catalog,
        objectId,
        path: fieldPath,
        commanderId,
      },
      matchCount: matches.length,
      items,
      latest,
      requiredDependsOn,
      semanticOverlaps,
      suggestedDependsOn: requiredDependsOn.length > 0
        ? requiredDependsOn
        : latest ? [latest.planId] : [],
      truncated: matches.length > items.length,
    };
  }

  function execute(input = {}) {
    // The isolation scope must also select the current player Upgrade overlay.
    // Previously impact(scope only) silently read the unscoped Catalog state.
    if (input.operation === 'impact.analyze' && input.scope?.kind === 'commander') {
      if (input.commanderId && input.commanderId !== input.scope.commanderId) {
        throw new CoopSearchError('impact commanderId must match scope.commanderId.');
      }
      input = { ...input, commanderId: input.scope.commanderId };
    }
    const currentOperations = ["commander.get", "entity.resolve", "entity.get", "catalog.search",
      "catalog.object", "catalog.effective", "catalog.references", "relationships.trace", "graph.slice",
      "requirement.explain", "impact.analyze"];
    if (currentOperations.includes(input.operation)) {
      return withProjectDatabase(input, () => executeInternal(input));
    }
    return executeInternal(input);
  }

  function executeInternal(input = {}) {
    if (!ALL_SEARCH_OPERATIONS.includes(input.operation)) {
      throw new CoopSearchError("Unknown search operation.", { operations: SEARCH_OPERATIONS });
    }
    switch (input.operation) {
      case "status": return status();
      case "commander.list": return commanderList(input);
      case "commander.resolve": return commanderResolve(input);
      case "commander.get": return commanderGet(input);
      case "commanders_for_unit": return commandersForUnit(input);
      case "catalog.search": return catalogSearch(input);
      case "catalog.object": return catalogObject(input);
      case "catalog.references": return catalogReferences(input);
      case "relationships.trace": return relationshipsTrace(input);
      case "entity.resolve": return entityResolve(input);
      case "entity.get": return entityGet(input);
      case "catalog.effective": return catalogEffective(input);
      case "graph.slice": return graphSlice(input);
      case "impact.analyze": return impactAnalyze(input);
      case "requirement.explain": return requirementExplain(input);
      case "galaxy.context": return galaxyContext(input);
      case "patches.for_target": return patchesForTarget(input);
      default: throw new CoopSearchError(`Unsupported search operation: ${input.operation}`);
    }
  }

  return { execute, locateDatabase, withProjectDatabase,close:()=>readCache?.close(),
    metrics:()=>({timing:structuredClone(timing),cache:readCache?.stats()??null}) };
}
