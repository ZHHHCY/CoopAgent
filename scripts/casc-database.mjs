import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildCascDatabase, defaultCascRoot } from "./lib/casc-database-builder.mjs";
import { reindexGalaxySymbols } from "./lib/galaxy-symbols.mjs";
import { reindexCoopSemantics, readCoopEntityFacts } from './lib/coop-semantics.mjs';
import { readFieldVocabulary } from './lib/field-vocabulary.mjs';
import { attachEngineCatalog, importEngineCatalog, engineCatalogStatus, readEngineCache } from "./lib/engine-catalog-store.mjs";

function usage() {
  return `
CoopAgent CASC database

Build:
  node scripts/casc-database.mjs build [--casc-root <path>] [--output <path>] [--engine-cache <cache.json>] [--json]

Derived-index maintenance (local database write, no CASC extraction):
  node scripts/casc-database.mjs reindex-galaxy <database>
  node scripts/casc-database.mjs reindex-semantics <database>
  node scripts/casc-database.mjs import-engine <database> <cache.json> [...cache.json]
  node scripts/casc-database.mjs engine-status <database>

Query:
  node scripts/casc-database.mjs object <database> <catalog> <id>
  node scripts/casc-database.mjs commander <database> <commander-id>
  node scripts/casc-database.mjs search <database> <query>
  node scripts/casc-database.mjs field-vocabulary <database> [catalog] [offset] [limit]
  node scripts/casc-database.mjs entity-facts <database> <commander-id> <unit-id> [overview|production|abilities|modifiers]
`.trim();
}

function parseBuildOptions(args) {
  const options = { cascRoot: null, output: null, engineCaches: [], json: false };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--casc-root") options.cascRoot = args[++index];
    else if (value === "--output") options.output = args[++index];
    else if (value === "--engine-cache") options.engineCaches.push(args[++index]);
    else if (value === "--json") options.json = true;
    else throw new Error(`未知参数：${value}`);
  }
  return options;
}

function openDatabase(file) {
  const db = new DatabaseSync(path.resolve(file), { readOnly: true });
  db.exec('BEGIN');
  attachEngineCatalog(db);
  db.exec('PRAGMA query_only=ON');
  return db;
}

function queryObject(databaseFile, catalog, objectId) {
  const database = openDatabase(databaseFile);
  try {
    const object = database
      .prepare("SELECT * FROM catalog_objects WHERE lower(catalog)=lower(?) AND lower(object_id)=lower(?)")
      .get(catalog, objectId);
    if (!object) throw new Error(`找不到对象：${catalog}/${objectId}`);
    const fields = database
      .prepare(`
        SELECT path, value, source_file, origin_object_id, inheritance_depth
        FROM catalog_fields WHERE catalog=? AND object_id=? ORDER BY path
      `)
      .all(object.catalog, object.object_id);
    const references = database
      .prepare(`
        SELECT field_path, target_catalog, target_object_id, confidence, evidence
        FROM object_references WHERE source_catalog=? AND source_object_id=?
        ORDER BY field_path, target_catalog, target_object_id
      `)
      .all(object.catalog, object.object_id);
    return { object, fields, references, engineCatalog: engineCatalogStatus(database), objectXmlSource: 'legacy-authoring-projection' };
  } finally {
    database.close();
  }
}

function queryCommander(databaseFile, commanderId) {
  const database = openDatabase(databaseFile);
  try {
    const commander = database
      .prepare("SELECT * FROM commanders WHERE lower(id)=lower(?) OR lower(commander_object_id)=lower(?)")
      .get(commanderId, commanderId);
    if (!commander) throw new Error(`找不到指挥官：${commanderId}`);
    const summary = database
      .prepare(`
        SELECT catalog, count(DISTINCT object_id) AS objects, min(depth) AS nearest_depth
        FROM commander_membership WHERE commander_id=? GROUP BY catalog ORDER BY objects DESC, catalog
      `)
      .all(commander.id);
    const units = database
      .prepare(`
        SELECT object_id, min(depth) AS depth, group_concat(DISTINCT evidence) AS evidence
        FROM commander_membership WHERE commander_id=? AND catalog='Unit'
        GROUP BY object_id ORDER BY depth, object_id LIMIT 250
      `)
      .all(commander.id);
    return { commander, summary, units };
  } finally {
    database.close();
  }
}

function search(databaseFile, query) {
  const database = openDatabase(databaseFile);
  try {
    return database
      .prepare("SELECT kind, key, title, snippet(search_index, 3, '[', ']', '...', 20) AS context FROM search_index WHERE search_index MATCH ? LIMIT 50")
      .all(query);
  } finally {
    database.close();
  }
}

async function main() {
  const [command = "", ...args] = process.argv.slice(2);
  if (!command || ["-h", "--help", "help"].includes(command)) {
    console.log(usage());
    return;
  }
  if (command === "build") {
    const options = parseBuildOptions(args);
    const result = buildCascDatabase({
      cascRoot: options.cascRoot ? path.resolve(options.cascRoot) : defaultCascRoot(),
      output: options.output ? path.resolve(options.output) : null,
      engineCaches: options.engineCaches.map((file) => path.resolve(file)),
      onProgress: options.json ? () => {} : (message) => console.error(message),
    });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`数据库构建完成：${result.databaseFile}`);
      console.log(`Catalog 对象：${result.report.stats.catalogObjects}`);
      console.log(`有效字段：${result.report.stats.effectiveFields}`);
      console.log(`引用：${result.report.stats.references}`);
      console.log(`指挥官：${result.report.stats.commanders}`);
      if (result.report.warnings.length > 0) console.log(`警告：${result.report.warnings.length}（见 build-report.json）`);
    }
    return;
  }
  if (command === "reindex-galaxy") {
    if (args.length !== 1) throw new Error(usage());
    console.log(JSON.stringify(reindexGalaxySymbols(path.resolve(args[0])), null, 2));
    return;
  }
  if (command === 'reindex-semantics') {
    if (args.length !== 1) throw new Error(usage());
    console.log(JSON.stringify(reindexCoopSemantics(path.resolve(args[0])), null, 2));
    return;
  }
  if (command === 'field-vocabulary') {
    if (args.length < 1 || args.length > 4) throw new Error(usage());
    const db = openDatabase(args[0]);
    try { console.log(JSON.stringify(readFieldVocabulary(db, {catalog:args[1],offset:Number(args[2] ?? 0),limit:Number(args[3] ?? 30)}), null, 2)); }
    finally { db.close(); }
    return;
  }
  if (command === 'entity-facts') {
    if (args.length < 3 || args.length > 4) throw new Error(usage());
    const db = openDatabase(args[0]);
    try { console.log(JSON.stringify(readCoopEntityFacts(db, {
      commanderId:args[1], objectId:args[2], topic:args[3] ?? 'overview',
    }), null, 2)); } finally { db.close(); }
    return;
  }
  if (command === 'import-engine') {
    if (args.length < 2) throw new Error(usage());
    for (const file of args.slice(1)) console.log(JSON.stringify(importEngineCatalog(path.resolve(args[0]), readEngineCache(file), { cachePath: path.resolve(file) }), null, 2));
    return;
  }
  if (command === 'engine-status') {
    if (args.length !== 1) throw new Error(usage());
    const db = openDatabase(args[0]);
    try { console.log(JSON.stringify(engineCatalogStatus(db), null, 2)); }
    finally { db.close(); }
    return;
  }
  if (command === "object") {
    if (args.length !== 3) throw new Error(usage());
    console.log(JSON.stringify(queryObject(...args), null, 2));
    return;
  }
  if (command === "commander") {
    if (args.length !== 2) throw new Error(usage());
    console.log(JSON.stringify(queryCommander(...args), null, 2));
    return;
  }
  if (command === "search") {
    if (args.length < 2) throw new Error(usage());
    console.log(JSON.stringify(search(args[0], args.slice(1).join(" ")), null, 2));
    return;
  }
  throw new Error(`未知命令：${command}\n${usage()}`);
}

main().catch((error) => {
  console.error(`CASC 数据库失败：${error.message}`);
  process.exitCode = 1;
});
