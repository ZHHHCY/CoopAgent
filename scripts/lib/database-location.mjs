import { existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DATABASE_SCHEMA_VERSION = 2;
export class DatabaseLocationError extends Error {
  constructor(message, details) { super(message); this.details = details; }
}

export function resolveCoopDatabase({ repoRoot, databaseFile, localAppDataDirectory, environment = process.env }) {
  const baseline = JSON.parse(readFileSync(path.join(repoRoot, 'game-a/runtime-baseline.json'), 'utf8'));
  const dataBuild = baseline.sc2.dataBuild;
  let source;
  if (databaseFile) source = 'configured-database';
  else if (environment.COOPAGENT_DATABASE) { databaseFile = environment.COOPAGENT_DATABASE; source = 'environment-database'; }
  else if (environment.COOPAGENT_CATALOG_ROOT) {
    databaseFile = path.join(path.dirname(path.dirname(path.resolve(environment.COOPAGENT_CATALOG_ROOT))), 'coop.sqlite');
    source = 'environment-catalog';
  } else {
    const local = localAppDataDirectory ?? environment.LOCALAPPDATA ?? environment.XDG_DATA_HOME
      ?? path.join(os.homedir(), process.platform === 'win32' ? 'AppData/Local' : '.local/share');
    databaseFile = path.join(local, 'CoopAgent/database', dataBuild, 'coop.sqlite');
    source = 'local-database';
  }
  return { dataBuild, databaseFile: path.resolve(databaseFile), source };
}

export function requireCoopDatabase(location) {
  if (!existsSync(location.databaseFile)) throw new DatabaseLocationError('合作模式数据库尚未构建，请运行 setup.cmd。', {
    code: 'database-missing', expectedBuild: location.dataBuild, expectedPath: location.databaseFile,
  });
  return location;
}

export function inspectCoopDatabase(options) {
  let location, database;
  try {
    location = resolveCoopDatabase(options);
    requireCoopDatabase(location);
    database = new DatabaseSync(location.databaseFile, { readOnly: true, timeout: 2000 });
    const metadata = Object.fromEntries(database.prepare('SELECT key, value FROM meta').all().map(row => [row.key, row.value]));
    if (metadata.sc2Build !== location.dataBuild) throw new DatabaseLocationError('数据库与当前项目的数据版本不匹配，请运行 setup.cmd。', {
      code: 'database-build-mismatch', expectedBuild: location.dataBuild, actualBuild: metadata.sc2Build,
    });
    if (Number(metadata.schemaVersion) !== DATABASE_SCHEMA_VERSION) throw new DatabaseLocationError('数据库结构需要更新，请运行 setup.cmd。', { code: 'database-schema-mismatch' });
    // Read only the tables needed for initial navigation. This is a readiness
    // check, not a full multi-gigabyte integrity scan on every page load.
    for (const query of ['SELECT commander_id, profile_json FROM commander_profiles LIMIT 1',
      'SELECT catalog, object_id, path, value FROM catalog_fields LIMIT 1']) {
      if (!database.prepare(query).get()) throw new DatabaseLocationError('数据库内容不完整，请运行 setup.cmd。', { code: 'database-incomplete' });
    }
    const catalogRoot = path.join(path.dirname(location.databaseFile), 'merged/GameData');
    if (!existsSync(catalogRoot) || !statSync(catalogRoot).isDirectory()) throw new DatabaseLocationError('合并后的游戏数据缺失，请运行 setup.cmd。', { code: 'catalog-missing', catalogRoot });
    return { ...location, ready: true, code: 'ready', message: '合作模式数据库已就绪。' };
  } catch (error) {
    const busy = [5, 6].includes(error.errcode & 255);
    return { ...location, ready: false, code: error.details?.code ?? (busy ? 'database-busy' : 'database-unreadable'),
      message: error instanceof DatabaseLocationError ? error.message
        : busy ? '数据库正忙，请稍后重新检查。' : '无法读取合作模式数据库，请检查路径或重新运行 setup.cmd。',
      details: error.details ?? { reason: error.message } };
  } finally { database?.close(); }
}
