import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveCoopDatabase, inspectCoopDatabase, DATABASE_SCHEMA_VERSION } from '../lib/database-location.mjs';
import { createCoopSearch } from '../../runtime/coop-mcp/lib/coop-search.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'coop-db-status-'));
  t.after(() => { assert.equal(path.dirname(root), tmpdir()); rmSync(root, {recursive:true,force:true}); });
  mkdirSync(path.join(root, 'game-a'));
  writeFileSync(path.join(root, 'game-a/runtime-baseline.json'), JSON.stringify({sc2:{dataBuild:'BTEST'}}));
  const databaseFile = path.join(root, 'chosen/coop.sqlite');
  mkdirSync(path.join(root,'chosen/merged/GameData'),{recursive:true});
  const db = new DatabaseSync(databaseFile);
  db.exec(`CREATE TABLE meta(key TEXT, value TEXT); INSERT INTO meta VALUES ('sc2Build','BTEST'),('schemaVersion','${DATABASE_SCHEMA_VERSION}');
    CREATE TABLE commander_profiles(commander_id TEXT, profile_json TEXT); INSERT INTO commander_profiles VALUES ('Commander','{}');
    CREATE TABLE catalog_fields(catalog TEXT, object_id TEXT, path TEXT, value TEXT); INSERT INTO catalog_fields VALUES ('Unit','Worker','LifeMax','45');`);
  db.close();
  return {repoRoot:root, databaseFile, environment:{}};
}
test('readiness and query use the same explicit, environment and local locations', t => {
  const f=fixture(t);
  for (const options of [f, {...f,databaseFile:undefined, environment:{COOPAGENT_DATABASE:f.databaseFile}},
    {...f,databaseFile:undefined,environment:{COOPAGENT_CATALOG_ROOT:path.join(path.dirname(f.databaseFile),'merged/GameData')}}]) {
    assert.equal(createCoopSearch(options).locateDatabase().databaseFile, resolveCoopDatabase(options).databaseFile);
    assert.equal(inspectCoopDatabase(options).ready,true);
  }
  const before=readFileSync(f.databaseFile);
  assert.equal(inspectCoopDatabase({...f,environment:{COOPAGENT_DATABASE:'wrong.sqlite'}}).ready,true);
  assert.deepEqual(readFileSync(f.databaseFile),before);
  const local=resolveCoopDatabase({...f,databaseFile:undefined,localAppDataDirectory:f.repoRoot});
  assert.equal(local.databaseFile,path.join(f.repoRoot,'CoopAgent/database/BTEST/coop.sqlite'));
});
test('missing and unreadable files never become ready or get created by inspection',t=>{
  const f=fixture(t), missing=path.join(f.repoRoot,'missing.sqlite');
  const status=inspectCoopDatabase({...f,databaseFile:missing});
  assert.equal(status.code,'database-missing'); assert.equal(status.databaseFile,missing); assert.equal(existsSync(missing),false);
  writeFileSync(f.databaseFile,'not a database');
  assert.equal(inspectCoopDatabase(f).code,'database-unreadable');
});
test('wrong build, schema, incomplete tables and missing catalogs are distinguished',t=>{
  const f=fixture(t), db=new DatabaseSync(f.databaseFile);
  db.exec("UPDATE meta SET value='BOTHER' WHERE key='sc2Build'");
  assert.equal(inspectCoopDatabase(f).code,'database-build-mismatch');
  db.exec("UPDATE meta SET value='BTEST' WHERE key='sc2Build'; UPDATE meta SET value='0' WHERE key='schemaVersion'");
  assert.equal(inspectCoopDatabase(f).code,'database-schema-mismatch');
  db.prepare("UPDATE meta SET value=? WHERE key='schemaVersion'").run(String(DATABASE_SCHEMA_VERSION));
  db.exec('DELETE FROM commander_profiles'); assert.equal(inspectCoopDatabase(f).code,'database-incomplete');
  db.exec("INSERT INTO commander_profiles VALUES ('Commander','{}')"); db.close();
  rmSync(path.join(f.repoRoot,'chosen/merged/GameData'),{recursive:true});
  assert.equal(inspectCoopDatabase(f).code,'catalog-missing');
});
test('a temporary writer lock reports busy and recovers on a later check',t=>{
  const f=fixture(t), writer=new DatabaseSync(f.databaseFile);
  try { writer.exec('BEGIN EXCLUSIVE'); assert.equal(inspectCoopDatabase(f).code,'database-busy'); }
  finally { writer.exec('ROLLBACK'); writer.close(); }
  assert.equal(inspectCoopDatabase(f).ready,true);
});
