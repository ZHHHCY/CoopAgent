import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { OFFICIAL_DEPENDENCY } from './sc2-catalog-probe.mjs';

export const ENGINE_CATALOG_VERSION = 1;
export const canonicalEnginePath = (value) => String(value).replaceAll('.@', '.').replace(/\[#(\d+)\]/g, '[$1]').toLowerCase();
const withoutZero = (value) => canonicalEnginePath(value).replace(/\[0\]/g, '');
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const attached = new WeakMap();
const exists = (db, table) => Boolean(db.prepare("SELECT 1 FROM main.sqlite_master WHERE name=? AND type='table'").get(table));

/** Additive schema: never changes the lossless definitions or legacy projections. */
export function createEngineCatalogSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS engine_snapshots (
      id TEXT PRIMARY KEY, digest TEXT NOT NULL, imported_at TEXT NOT NULL,
      context_key TEXT NOT NULL, manifest_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS engine_queries (
      catalog TEXT NOT NULL, object_id TEXT NOT NULL, query_key TEXT NOT NULL,
      snapshot_id TEXT NOT NULL, result_json TEXT NOT NULL,
      PRIMARY KEY(catalog,object_id,query_key)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS engine_schema_fields (
      scope TEXT NOT NULL, name TEXT NOT NULL, snapshot_id TEXT NOT NULL,
      descriptor_json TEXT NOT NULL, PRIMARY KEY(scope,name)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS engine_objects (
      catalog TEXT NOT NULL, object_id TEXT NOT NULL, PRIMARY KEY(catalog,object_id)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS engine_resolved_fields (
      catalog TEXT NOT NULL, object_id TEXT NOT NULL, path TEXT NOT NULL,
      value TEXT NOT NULL, field_tag TEXT NOT NULL, attribute TEXT,
      source_file TEXT NOT NULL, origin_object_id TEXT NOT NULL, inheritance_depth INTEGER NOT NULL,
      PRIMARY KEY(catalog,object_id,path)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS engine_resolved_references (
      source_catalog TEXT NOT NULL, source_object_id TEXT NOT NULL, field_path TEXT NOT NULL,
      target_catalog TEXT NOT NULL, target_object_id TEXT NOT NULL, confidence REAL NOT NULL, evidence TEXT NOT NULL,
      PRIMARY KEY(source_catalog,source_object_id,field_path,target_catalog,target_object_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS engine_reference_target ON engine_resolved_references(target_catalog,target_object_id);
  `);
  db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run('engineCatalogVersion', String(ENGINE_CATALOG_VERSION));
}

export function fieldCoveredByEngine(fieldPath, query) {
  const field = canonicalEnginePath(fieldPath);
  const root = canonicalEnginePath(query.field);
  if (query.kind === 'value') return field === root || withoutZero(field) === withoutZero(root);
  if (query.kind !== 'array') return false;
  if (field !== root && !field.startsWith(root + '[') && !field.startsWith(root + '.')) return false;
  // Array length also proves that out-of-range struct items no longer exist.
  const index = /^\[(\d+)\]/.exec(field.slice(root.length));
  if (index && Number(index[1]) >= query.count) return true;
  if (!query.member) return field === root || /^\[\d+\]$/.test(field.slice(root.length));
  return field.endsWith('.' + query.member.toLowerCase());
}

function validateCache(db, cache) {
  const fail = (message) => { throw new Error(`Engine snapshot rejected: ${message}`); };
  const meta = Object.fromEntries(db.prepare('SELECT key,value FROM meta').all().map((r) => [r.key, r.value]));
  if (cache.schemaVersion !== 1 || cache.usable !== true || !/^[a-z0-9-]+$/i.test(cache.run?.id ?? '')) fail('not a usable version-1 snapshot');
  if (cache.meta?.runId !== cache.run.id || cache.meta.status !== 'complete') fail('run identity/completion mismatch');
  const context = cache.run.context;
  if (context?.player !== 0 || context.missionInitialized !== false || context.commanderInitialized !== false || context.gameAPatchesLoaded !== false
    || cache.meta.player !== '0' || cache.meta.context !== 'official-catalog-no-mission-init-no-upgrades'
    || cache.run.dependency !== OFFICIAL_DEPENDENCY) fail('only the official, no-upgrade player-0 baseline can be imported');
  if (!cache.databaseMetadata?.cascManifestSha256 || cache.databaseMetadata.cascManifestSha256 !== meta.cascManifestSha256
    || cache.databaseMetadata.sc2Build !== meta.sc2Build) fail('CASC source/build does not match this database');
  const runtime = cache.logs?.filter((log) => log.version && log.dataBuild) ?? [];
  if (!runtime.length || runtime.some((log) => log.dataBuild !== meta.sc2Build)
    || cache.logs.some((log) => log.diagnostics?.some((d) => d.severity === 'error'))) fail('runtime build/log verification failed');
  if (!Array.isArray(cache.results) || !cache.results.length || cache.results.length !== cache.run.queries?.length) fail('query set is incomplete');
  const ids = new Set();
  const plans = new Map(cache.run.queries.map((q) => [q.id, q]));
  for (const result of cache.results) {
    if (ids.has(result.id)) fail('duplicate query id');
    ids.add(result.id);
    const plan = plans.get(result.id);
    if (!plan || ['kind', 'catalog', 'entry', 'field', 'member', 'maxItems'].some((key) => plan[key] !== result[key])) fail('query/result mismatch');
    if (result.status !== 'complete' || result.truncated) fail('failed/truncated query');
    if (!db.prepare('SELECT 1 FROM catalog_objects WHERE catalog=? AND object_id=?').get(result.catalog, result.entry)) fail(`unknown source object ${result.catalog}/${result.entry}`);
    if (result.kind === 'array') {
      const maxItems=result.maxItems??256;
      if (!Number.isInteger(maxItems)||maxItems<1||maxItems>1024||!Number.isInteger(result.count) || result.count < 0 || result.count > maxItems || result.items?.length !== result.count || result.items.some((v) => typeof v !== 'string')) fail('incomplete array');
    } else if (result.kind === 'value') {
      if (typeof result.value !== 'string') fail('missing field value');
    } else if (result.kind === 'schema') {
      if (!result.schemas?.length || result.schemas.some((s) => !s.scope || !Number.isInteger(s.count) || s.count < 0 || s.count > 1024 || s.fields.length !== s.count
        || s.fields.some((f) => !f.name || typeof f.type !== 'string' || !Number.isInteger(f.category)))) fail('incomplete schema');
    } else fail('unsupported query kind');
  }
  // An ordinal is not an Upgrade effect identity. Never attach an engine Value
  // to a legacy Reference at the same index: native and merged orders can differ.
  const upgradeArrays=new Set(cache.results.filter(r=>r.catalog==='Upgrade'&&/^effectarray(?:\[|\.|$)/.test(canonicalEnginePath(r.field??''))).map(r=>r.entry));
  for(const entry of upgradeArrays) {
    const rows=cache.results.filter(r=>r.catalog==='Upgrade'&&r.entry===entry&&canonicalEnginePath(r.field??'')==='effectarray'&&r.kind==='array');
    const complete=['Reference','Operation','Value'].map(member=>rows.filter(r=>r.member===member));
    if(complete.some(rows=>rows.length!==1)||new Set(complete.map(rows=>rows[0]?.count)).size!==1)
      fail(`Upgrade/${entry} requires complete matching Reference/Operation/Value arrays from the same snapshot; a scalar ordinal cannot prove effect identity`);
  }
  for (const array of cache.results.filter((r) => r.kind === 'array')) {
    if (cache.results.some((r) => r.kind === 'value' && r.catalog === array.catalog && r.entry === array.entry && fieldCoveredByEngine(r.field, array))) {
      fail('overlapping scalar and array observations; request the complete array only');
    }
  }
  return digest({ build: meta.sc2Build, source: meta.cascManifestSha256, dependency: cache.run.dependency,
    install: cache.run.buildInfoSha256, runtime: runtime[0].version, context });
}

function linkType(db, query, fieldPath) {
  let scope = query.scope;
  for (const segment of fieldPath.split('.')) {
    const name = segment.replace(/\[.*$/, '');
    const row = db.prepare('SELECT descriptor_json FROM engine_schema_fields WHERE scope=? AND name=?').get(scope, name);
    if (!row) { scope = null; break; }
    const field = JSON.parse(row.descriptor_json);
    scope = field.type;
  }
  const match = /^C([A-Za-z]+)Link$/.exec(scope ?? '');
  if (match && db.prepare('SELECT 1 FROM catalog_objects WHERE catalog=? LIMIT 1').get(match[1])) return { catalog: match[1], evidence: 'engine-schema-link' };
  // Small explicit adapters for native pointer/link wrappers. No substring guessing.
  if (/\.Requirements$/.test(fieldPath)) return { catalog: 'Requirement', evidence: 'engine-value:requirements-adapter' };
  for (const [root, catalog] of [['WeaponArray', 'Weapon'], ['AbilArray', 'Abil'], ['BehaviorArray', 'Behavior']]) {
    if (query.catalog === 'Unit' && fieldPath.startsWith(root + '[') && fieldPath.endsWith('.Link')) return { catalog, evidence: 'engine-value:unit-link-adapter' };
  }
  if (query.catalog === 'Abil' && fieldPath.startsWith('AutoCastValidatorArray[')) return { catalog: 'Validator', evidence: 'engine-value:validator-adapter' };
  return null;
}

function rebuildObject(db, catalog, objectId) {
  const base = db.prepare('SELECT * FROM main.catalog_fields WHERE catalog=? AND object_id=?').all(catalog, objectId);
  const queries = db.prepare('SELECT snapshot_id,result_json FROM engine_queries WHERE catalog=? AND object_id=? ORDER BY query_key').all(catalog, objectId)
    .map((r) => ({ ...JSON.parse(r.result_json), snapshotId: r.snapshot_id }));
  const fields = base.filter((f) => !queries.some((q) => fieldCoveredByEngine(f.path, q)));
  const observed = [];
  for (const query of queries) {
    const entries = query.kind === 'value' ? [[query.field, query.value]] : query.items.map((v, i) => [`${query.field}[${i}]${query.member ? '.' + query.member : ''}`, v]);
    for (const [fieldPath, value] of entries) {
      const parts = fieldPath.split('.');
      const attribute = parts.length > 1 ? parts.at(-1) : 'value';
      const fieldTag = (parts.length > 1 ? parts.at(-2) : parts.at(-1)).replace(/\[.*$/, '');
      const field = { catalog, object_id: objectId, path: fieldPath, value, field_tag: fieldTag, attribute,
        source_file: `engine:${query.snapshotId}`, origin_object_id: objectId, inheritance_depth: 0 };
      fields.push(field);
      observed.push({ query, field });
    }
  }
  db.prepare('INSERT OR IGNORE INTO engine_objects VALUES (?,?)').run(catalog, objectId);
  db.prepare('DELETE FROM engine_resolved_fields WHERE catalog=? AND object_id=?').run(catalog, objectId);
  db.prepare('DELETE FROM engine_resolved_references WHERE source_catalog=? AND source_object_id=?').run(catalog, objectId);
  const put = db.prepare('INSERT INTO engine_resolved_fields VALUES (?,?,?,?,?,?,?,?,?)');
  for (const f of fields) put.run(f.catalog, f.object_id, f.path, f.value, f.field_tag, f.attribute, f.source_file, f.origin_object_id, f.inheritance_depth);
  const putRef = db.prepare('INSERT OR IGNORE INTO engine_resolved_references VALUES (?,?,?,?,?,?,?)');
  for (const r of db.prepare('SELECT * FROM main.object_references WHERE source_catalog=? AND source_object_id=?').all(catalog, objectId)) {
    if (!queries.some((q) => fieldCoveredByEngine(r.field_path, q))) putRef.run(r.source_catalog, r.source_object_id, r.field_path, r.target_catalog, r.target_object_id, r.confidence, r.evidence);
  }
  for (const { query, field } of observed) {
    if(query.catalog==='Upgrade'&&/^EffectArray\[\d+\]\.Reference$/i.test(field.path)) {
      const [targetCatalog,targetId,...targetField]=field.value.split(',');
      if(targetField.join(',')&&db.prepare('SELECT 1 FROM main.catalog_objects WHERE catalog=? AND object_id=?').get(targetCatalog,targetId))
        putRef.run(catalog,objectId,field.path,targetCatalog,targetId,1,'engine-value:upgrade-reference');
      continue;
    }
    const type = linkType(db, query, field.path);
    if (!type || !field.value || !db.prepare('SELECT 1 FROM main.catalog_objects WHERE catalog=? AND object_id=?').get(type.catalog, field.value)) continue;
    putRef.run(catalog, objectId, field.path, type.catalog, field.value, 1, type.evidence);
  }
}

/** One transaction installs a snapshot, its coverage, and rebuilt read projections. */
export function importEngineCatalog(databaseFile, cache, { cachePath = null } = {}) {
  if (!existsSync(databaseFile)) throw new Error('Baseline database does not exist; build the CASC index first');
  const db = new DatabaseSync(databaseFile, { timeout: 2000 });
  try {
    db.exec('BEGIN IMMEDIATE');
    const contextKey = validateCache(db, cache);
    createEngineCatalogSchema(db);
    const contentDigest = digest({ run: cache.run, results: cache.results });
    const existing = db.prepare('SELECT digest FROM engine_snapshots WHERE id=?').get(cache.run.id);
    if (existing) {
      if (existing.digest !== contentDigest) throw new Error('Engine snapshot identity reused with different data');
      db.exec('ROLLBACK');
      return { status: 'already-imported', snapshotId: cache.run.id };
    }
    const activeContext = db.prepare('SELECT value FROM meta WHERE key=?').get('engineContextKey')?.value;
    if (activeContext && activeContext !== contextKey) throw new Error('Engine context changed; rebuild the baseline database before importing a different context');
    db.prepare('INSERT INTO engine_snapshots VALUES (?,?,?,?,?)').run(cache.run.id, contentDigest, new Date().toISOString(), contextKey,
      JSON.stringify({ run: cache.run, logs: cache.logs, cachePath }));
    const changed = new Map();
    for (const result of cache.results.filter((r) => r.kind === 'schema')) {
      for (const schema of result.schemas) {
        db.prepare('DELETE FROM engine_schema_fields WHERE scope=?').run(schema.scope);
        for (const field of schema.fields) db.prepare('INSERT INTO engine_schema_fields VALUES (?,?,?,?)').run(schema.scope, field.name, cache.run.id, JSON.stringify(field));
      }
    }
    for (const result of cache.results.filter((r) => r.kind !== 'schema')) {
      // Whole-array queries supersede narrower observations and vice versa.
      // Do not silently combine two overlapping authorities for one field family.
      const current = db.prepare('SELECT query_key,result_json FROM engine_queries WHERE catalog=? AND object_id=?').all(result.catalog, result.entry);
      for (const row of current) {
        const old = JSON.parse(row.result_json);
        if (result.kind === 'value' && old.kind === 'array' && fieldCoveredByEngine(result.field, old)) {
          throw new Error('Refresh the observed array as a whole instead of replacing it with one scalar');
        }
        if (result.kind === 'array' && old.kind === 'array' && canonicalEnginePath(old.field) === canonicalEnginePath(result.field)
          && old.member !== result.member && old.count === result.count) continue;
        if (fieldCoveredByEngine(old.field, result) || fieldCoveredByEngine(result.field, old)
          || canonicalEnginePath(old.field) === canonicalEnginePath(result.field)) {
          db.prepare('DELETE FROM engine_queries WHERE catalog=? AND object_id=? AND query_key=?').run(result.catalog, result.entry, row.query_key);
        }
      }
      const queryKey = `${canonicalEnginePath(result.field)}|${result.member ?? ''}`;
      db.prepare('INSERT INTO engine_queries VALUES (?,?,?,?,?)').run(result.catalog, result.entry, queryKey, cache.run.id, JSON.stringify(result));
      changed.set(`${result.catalog}\0${result.entry}`, [result.catalog, result.entry]);
    }
    // New schema may classify references in an earlier imported batch.
    if (cache.results.some((r) => r.kind === 'schema')) for (const row of db.prepare('SELECT * FROM engine_objects').all()) changed.set(`${row.catalog}\0${row.object_id}`, [row.catalog, row.object_id]);
    for (const [catalog, id] of changed.values()) rebuildObject(db, catalog, id);
    db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('engineContextKey', contextKey);
    db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('engineLatestSnapshot', cache.run.id);
    db.exec('COMMIT');
    return { status: 'imported', snapshotId: cache.run.id, ...engineCatalogStatus(db) };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    throw error;
  } finally { db.close(); }
}

export function engineCatalogStatus(db) {
  if (!exists(db, 'engine_snapshots')) return { mode: 'legacy-interpreted', snapshots: 0, objects: 0, queries: 0, schemaFields: 0, coverage: 'none' };
  const count = (table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  const snapshots = count('engine_snapshots');
  return { mode: snapshots ? 'hybrid-engine-baseline' : 'legacy-interpreted', snapshots, objects: count('engine_objects'),
    queries: count('engine_queries'), schemaFields: count('engine_schema_fields'), coverage: snapshots ? 'partial' : 'none',
    observedFields: db.prepare("SELECT count(*) AS n FROM engine_resolved_fields WHERE source_file LIKE 'engine:%'").get().n,
    unobserved: 'legacy-interpreted-not-engine-verified', player: 0, commanderRuntimeEvaluated: false,
    compatibilityXml: 'legacy-authoring-projection-not-engine-export', commanderMembership: 'legacy-derived' };
}

/** Shared by UI, MCP and CLI. Main remains read-only; only TEMP views are created. */
export function attachEngineCatalog(db) {
  if (attached.has(db)) return attached.get(db);
  const priorQueryOnly = db.prepare('PRAGMA query_only').get().query_only;
  db.exec('PRAGMA query_only=OFF');
  const status = engineCatalogStatus(db);
  for (const [name, predicate] of [
    ['catalog_fields', 'e.catalog=m.catalog AND e.object_id=m.object_id'],
    ['object_references', 'e.catalog=m.source_catalog AND e.object_id=m.source_object_id'],
  ]) {
    const engineTable = name === 'catalog_fields' ? 'engine_resolved_fields' : 'engine_resolved_references';
    db.exec(`CREATE TEMP VIEW _baseline_${name} AS SELECT m.* FROM main.${name} m ${status.snapshots
      ? `WHERE NOT EXISTS (SELECT 1 FROM main.engine_objects e WHERE ${predicate}) UNION ALL SELECT * FROM main.${engineTable}` : ''};
      CREATE TEMP VIEW ${name} AS SELECT * FROM _baseline_${name};`);
  }
  if (priorQueryOnly) db.exec('PRAGMA query_only=ON');
  const readQueries = status.snapshots ? db.prepare('SELECT result_json,snapshot_id FROM main.engine_queries WHERE catalog=? AND object_id=?') : null;
  const api = { status, coverage(catalog, id) { return readQueries?.all(catalog, id).map((r) => ({ ...JSON.parse(r.result_json), snapshotId: r.snapshot_id })) ?? []; } };
  attached.set(db, api);
  return api;
}

export const readEngineCache = (file) => JSON.parse(readFileSync(file, 'utf8'));
