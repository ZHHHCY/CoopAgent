#!/usr/bin/env node
// Independent engine experiment; never edits Map Runtime or the official-data database.
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, copyFile, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { generateProbe, parseProbeBank, PROBE_QUERIES, PROBE_REVISION, OFFICIAL_DEPENDENCY } from './lib/sc2-catalog-probe.mjs';
import { prepareMechanismProbe, evaluateMechanism, fingerprintTree } from './lib/sc2-mechanism-probe.mjs';
import { masteryPanelExperiment, evaluateMasteryPanel } from './lib/mastery-panel-probe.mjs';
import { parseScriptDiagnostics, parseAlertDiagnostics, parseRuntimeMetadata, parseTasklistProcessIds } from '../runtime/coop-mcp/lib/game-a-runtime-test.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const command = argv.shift() ?? 'help';
function option(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`Missing --${name} value`);
  return argv[index + 1];
}
const localRoot = path.join(process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE, 'AppData', 'Local'), 'CoopAgent');
const stateRoot = path.join(localRoot, 'catalog-probe');
const documents = option('documents', path.join(process.env.USERPROFILE, 'Documents'));
const jsonWrite = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const xmlEscape = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

async function findBanks(root, name) {
  const matches = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) matches.push(...await findBanks(file, name));
    else if (entry.name === name) matches.push(file);
  }
  return matches;
}

async function start() {
  if (process.platform !== 'win32') throw new Error('SC2 probe launch currently supports Windows only');
  const sc2Root = path.resolve(option('sc2', process.env.COOPAGENT_SC2_ROOT ?? 'C:/Program Files (x86)/StarCraft II'));
  const switcher = path.join(sc2Root, 'Support64', 'SC2Switcher_x64.exe');
  if (!existsSync(switcher)) throw new Error(`SC2Switcher not found: ${switcher}`);
  for (const name of ['SC2_x64.exe', 'SC2.exe']) {
    const output = execFileSync('tasklist.exe', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'], { windowsHide: true, encoding: 'utf8' });
    if (parseTasklistProcessIds(output, name).size) throw new Error('SC2 is already running; leave that session untouched and close it before probing');
  }
  const defaultTemplate = existsSync(path.join(repo, 'game-a/projects/GameA.SC2Map/MapInfo'))
    ? 'game-a/projects/GameA.SC2Map' : 'game-a/projects/GameA-OblivionExpress.SC2Map';
  const template = path.resolve(option('template', path.join(repo, defaultTemplate)));
  const queriesPath = option('queries', null);
  let queries = queriesPath ? JSON.parse(await readFile(queriesPath, 'utf8')) : PROBE_QUERIES;
  const mechanismPath = option('mechanism', null);
  const panelMode=option('mastery-panel',null);
  if(panelMode&&(mechanismPath||queriesPath))throw Error('--mastery-panel is exclusive with --mechanism and --queries');
  let panelUserXml=null;
  if(panelMode==='indexed-keyed') {
    const db=new DatabaseSync(option('database',path.join(localRoot,'database','B97579','coop.sqlite')),{readOnly:true});
    try { panelUserXml=db.prepare('SELECT direct_xml FROM catalog_objects WHERE catalog=? AND object_id=?').get('User','MasteryUpgrades')?.direct_xml; }
    finally { db.close(); }
  }
  const panelExperiment=panelMode?masteryPanelExperiment(panelMode,panelUserXml):null;
  if(panelExperiment)queries=panelExperiment.queries;
  if (mechanismPath && queriesPath) throw new Error('--mechanism and --queries are exclusive');
  const id = randomUUID();
  const bankName = `CoopAgentCatalogProbe${id.replaceAll('-', '')}`;
  const runDirectory = path.join(stateRoot, id);
  const mapName = `CoopAgentCatalogProbe-${id}.SC2Map`;
  const mapPath = path.join(sc2Root, 'Maps', 'Test', mapName);
  await mkdir(runDirectory, { recursive: true });
  await mkdir(path.dirname(mapPath), { recursive: true });
  await mkdir(mapPath, { recursive: false });
  // Only map geometry/MapInfo, not units, triggers, GameData, or Map Runtime generated scripts.
  const templateFiles = [];
  for (const entry of await readdir(template, { withFileTypes: true })) {
    if (mechanismPath) break; // The actual host will be built and copied in full.
    if (!entry.isFile() || !(/^(t3|MapInfo$|MapInfo\.version$)/.test(entry.name))) continue;
    const source = path.join(template, entry.name);
    await copyFile(source, path.join(mapPath, entry.name));
    templateFiles.push({ name: entry.name, sha256: sha256(await readFile(source)) });
  }
  if (!mechanismPath && !templateFiles.some((entry) => entry.name === 'MapInfo')) throw new Error('Template must contain MapInfo');
  // SC2's folder-map loader needs its component marker and binary dependency header.
  // Reuse only a local header already declaring the same official dependency.
  const header = await readFile(path.join(repo, 'game-a/projects/GameA-OblivionExpress.SC2Map/DocumentHeader'));
  if (!header.includes(Buffer.from(OFFICIAL_DEPENDENCY))) throw new Error('Local header does not match official dependency');
  await writeFile(path.join(mapPath, 'DocumentHeader'), header);
  await writeFile(path.join(mapPath, 'ComponentList.SC2Components'), '<?xml version="1.0" encoding="utf-8"?><Components><DataComponent Type="info">DocumentInfo</DataComponent><DataComponent Type="mapi">MapInfo</DataComponent><DataComponent Type="terr">t3Terrain.xml</DataComponent></Components>', 'utf8');
  if(panelExperiment) {
    await writeFile(path.join(mapPath,'ComponentList.SC2Components'),'<Components><DataComponent Type="gada">GameData</DataComponent><DataComponent Type="info">DocumentInfo</DataComponent><DataComponent Type="mapi">MapInfo</DataComponent><DataComponent Type="terr">t3Terrain.xml</DataComponent></Components>');
    for(const [relative,source] of Object.entries(panelExperiment.files)){const file=path.join(mapPath,relative);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,source);}
    panelExperiment.fileHashes=Object.fromEntries(Object.entries(panelExperiment.files).map(([file,source])=>[file,sha256(source)]));
  }
  const mechanismProbe = mechanismPath ? await prepareMechanismProbe({
    config: JSON.parse(await readFile(mechanismPath, 'utf8')), runDirectory, mapPath, runId: id, bankName,
  }) : null;
  if (mechanismProbe) queries = mechanismProbe.queries;
  const galaxy = mechanismProbe?.galaxy ?? generateProbe({ runId: id, bankName, queries });
  await writeFile(path.join(mapPath, 'MapScript.galaxy'), galaxy, 'utf8');
  if (!mechanismProbe) await writeFile(path.join(mapPath, 'DocumentInfo'), `<?xml version="1.0" encoding="utf-8"?><DocInfo><Dependencies><Value>${xmlEscape(OFFICIAL_DEPENDENCY)}</Value></Dependencies></DocInfo>`, 'utf8');
  await writeFile(path.join(mapPath, 'BankList.xml'), `<?xml version="1.0" encoding="utf-8"?><BankList><Bank Name="${bankName}" Player="1"/></BankList>`, 'utf8');
  if (mechanismProbe) mechanismProbe.mechanism.launchedMap = await fingerprintTree(mapPath);
  const configPath = path.join(runDirectory, 'Probe.SC2TestConfig');
  await writeFile(configPath, '<?xml version="1.0" encoding="utf-8"?><TestConfig><Attribute AttNamespace="0" Id="1" Player="1" Value="0001"/></TestConfig>', 'utf8');
  const args = ['-run', `Test\\${mapName}`, '-displaymode', '0', '-preload', '1', '-NoUserCheats', '-reloadcheck', '-meleeMod', 'Void', '-difficulty', '2', '-speed', '2', '-testconfig', configPath];
  const buildInfo = await readFile(path.join(sc2Root, '.build.info'), 'utf8');
  const run = {
    id, probeRevision: PROBE_REVISION, startedAt: new Date().toISOString(), bankName, runDirectory,
    mapPath, template, templateFiles, sc2Root, documents, queries,
    dependency: OFFICIAL_DEPENDENCY, headerSha256: sha256(header), scriptSha256: sha256(galaxy), buildInfoSha256: sha256(buildInfo),
    context: mechanismProbe?.context ?? { player: 0, missionInitialized: false, commanderInitialized: false, gameAPatchesLoaded: false },
    ...(mechanismProbe ? { mechanism: mechanismProbe.mechanism } : {}),
    ...(panelExperiment?{panelExperiment}:{}),
    switcher, args,
  };
  await jsonWrite(path.join(runDirectory, 'run.json'), run);
  await jsonWrite(path.join(stateRoot, 'latest.json'), { id });
  const child = spawn(switcher, args, { cwd: sc2Root, shell: false, detached: true, stdio: 'ignore', windowsHide: false });
  await once(child, 'spawn');
  child.unref();
  run.launcherPid = child.pid;
  await jsonWrite(path.join(runDirectory, 'run.json'), run);
  console.log(JSON.stringify({ status: 'launched', id, mapPath, runDirectory }, null, 2));
  return run;
}

async function loadRun() {
  const id = option('run', null) ?? JSON.parse(await readFile(path.join(stateRoot, 'latest.json'), 'utf8')).id;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid probe runId');
  return JSON.parse(await readFile(path.join(stateRoot, id, 'run.json'), 'utf8'));
}

async function stopOwnedProbe(run) {
  // GameOver ends the probe match but this SC2 build stays at its front end.
  // Never terminate by image name: verify the unique map argument and executable.
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process -Filter "Name = \'SC2_x64.exe\'" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress'],
  { encoding: 'utf8', windowsHide: true });
  if (!output.trim()) return;
  const found = JSON.parse(output);
  const processes = Array.isArray(found) ? found : [found];
  const owned = processes.filter((p) => p.CommandLine?.includes(`Test\\${path.basename(run.mapPath)}`)
    && p.ExecutablePath?.toLowerCase().startsWith(path.join(run.sc2Root, 'Versions').toLowerCase() + path.sep));
  if (owned.length > 1) throw new Error('Multiple processes match this probe; refusing automatic cleanup');
  for (const p of owned) {
    process.kill(p.ProcessId);
    const deadline = Date.now() + 15000;
    let present = true;
    while (present && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const remaining = execFileSync('tasklist.exe', ['/FI', `PID eq ${p.ProcessId}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
      present = parseTasklistProcessIds(remaining, 'SC2_x64.exe').has(p.ProcessId);
    }
    if (present) throw new Error(`Owned probe process ${p.ProcessId} has not exited; refusing to start another test`);
    console.log(`Closed only probe SC2 process ${p.ProcessId}; local cache retained.`);
  }
}

async function readRunLogs(run) {
  const logsRoot = path.join(run.documents, 'StarCraft II', 'GameLogs');
  const logs = [];
  for (const entry of await readdir(logsRoot).catch(() => [])) {
    if (!entry.endsWith('ScriptError.txt') && !entry.endsWith('Alerts.txt') && !entry.endsWith('Graphics.txt')) continue;
    const file = path.join(logsRoot, entry);
    if ((await stat(file)).mtimeMs < Date.parse(run.startedAt)) continue;
    const content = await readFile(file, 'utf8');
    if (!content.includes(path.basename(run.mapPath))) continue;
    await mkdir(path.join(run.runDirectory, 'logs'), { recursive: true });
    await copyFile(file, path.join(run.runDirectory, 'logs', entry));
    const normalized = content.replace(/^[A-Z]+\s+(?:\d{2}:\d{2}:\d{2}\.\d+|\d+\s+[\d.]+\s+[\d.]+)\s+/gm, '');
    const diagnostics = entry.endsWith('Graphics.txt') ? [] : entry.endsWith('Alerts.txt') ? parseAlertDiagnostics(content).map((d) => !run.mechanism && /技能过多/.test(d.message) ? { ...d, severity: 'warning' } : d) : parseScriptDiagnostics(content);
    logs.push({ path: file, ...parseRuntimeMetadata(normalized), diagnostics });
  }
  return logs;
}

async function collect(run, { quiet = false } = {}) {
  // SC2 strips underscores from Bank filenames on this build.
  const banks = await findBanks(path.join(run.documents, 'StarCraft II', 'Banks'), `${run.bankName.replaceAll('_', '')}.SC2Bank`);
  if (banks.length === 0) return null;
  if (banks.length !== 1) throw new Error('Ambiguous probe Bank paths');
  let data;
  try { data = parseProbeBank(await readFile(banks[0], 'utf8'), run.id, run.queries); }
  catch (error) {
    if (error.message === 'Probe has not completed') return null;
    // BankSave replaces the file while SC2 is running. A poll can observe the
    // temporary half-written XML; treat only parser failures as transient and
    // let the normal deadline expose a file that stays malformed.
    if (error.name === 'ParseError') return null;
    throw error;
  }
  const logs = await readRunLogs(run);
  const dbPath = option('database', path.join(localRoot, 'database', 'B97579', 'coop.sqlite'));
  const db = !run.mechanism && existsSync(dbPath) ? new DatabaseSync(dbPath, { readOnly: true }) : null;
  try {
    const canonical = (field) => field.replaceAll('[#', '[').replace(/\.@/g, '.');
    for (const result of data.results) {
      if (result.kind === 'schema' || !db) continue;
      const rows = db.prepare('SELECT path, value FROM catalog_fields WHERE catalog=? AND object_id=?').all(result.catalog, result.entry);
      result.database = rows.filter((row) => result.kind === 'array'
        ? (canonical(row.path).startsWith(`${result.field}[`) || canonical(row.path).startsWith(`${result.field}.`) || canonical(row.path) === result.field) && (!result.member || canonical(row.path).endsWith('.' + result.member))
        : canonical(row.path) === result.field);
    }
    data.databaseMetadata = db ? Object.fromEntries(db.prepare('SELECT key,value FROM meta').all().map((row) => [row.key, row.value])) : null;
  } finally { db?.close(); }
  const bankStat = await stat(banks[0]);
  await copyFile(banks[0], path.join(run.runDirectory, 'observations.SC2Bank'));
  const cache = { schemaVersion: 1, collectedAt: new Date().toISOString(), run, bankPath: banks[0],
    launchToBankMs: bankStat.mtimeMs - Date.parse(run.startedAt), bankBytes: bankStat.size, logs, ...data };
  cache.usable = logs.some((log) => log.version && log.dataBuild) && logs.every((log) => log.diagnostics.every((d) => d.severity !== 'error')) && data.results.every((r) => r.status === 'complete' && !r.truncated && (r.kind !== 'schema' || r.schemas.every((s) => s.count <= 1024)));
  if (run.mechanism) cache.mechanismVerdict = evaluateMechanism(data.results, cache.usable);
  if(run.panelExperiment)cache.panelVerdict=evaluateMasteryPanel(data.results,run.panelExperiment,cache.usable);
  const cachePath = path.join(run.runDirectory, 'cache.json');
  await jsonWrite(cachePath, cache);
  if (!quiet && run.mechanism) console.log(JSON.stringify({ status: cache.mechanismVerdict.status, cachePath,
    checks: `${cache.mechanismVerdict.passed}/${cache.mechanismVerdict.total}`, failedChecks: cache.mechanismVerdict.checks.filter((c) => c.status !== 'pass'),
    errors: logs.flatMap((l) => l.diagnostics).filter((d) => d.severity === 'error'),
  }, null, 2));
  else if (!quiet) console.log(JSON.stringify({ status: cache.usable ? 'collected' : 'collected-with-errors', cachePath, logs, mechanismVerdict: cache.mechanismVerdict,
    results: data.results.map((r) => r.kind === 'schema' ? { id: r.id, status: r.status, schemas: r.schemas.map((s) => ({ scope: s.scope, count: s.count })) } : r),
  }, null, 2));
  return cache;
}

try {
  if (command === 'start') await start();
  else if (command === 'stop') await stopOwnedProbe(await loadRun());
  else if (command === 'collect') {
    if (!await collect(await loadRun())) console.log('Probe Bank not complete yet. Check the fresh SC2 ScriptError log if this persists.');
  } else if (command === 'run') {
    const run = await start();
    const timeout = Number(option('timeout', '180'));
    const deadline = Date.now() + timeout * 1000;
    let cache;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      cache = await collect(run, { quiet: Boolean(run.mechanism) && !argv.includes('--keep-open') });
      if (cache) break;
    }
    if (!cache) {
      if ((run.mechanism||run.panelExperiment) && !argv.includes('--keep-open')) await stopOwnedProbe(run);
      await jsonWrite(path.join(run.runDirectory, 'failure.json'), { status: 'inconclusive', reason: 'bank-timeout', runId: run.id, timeoutSeconds: timeout, mapPath: run.mapPath, logs: await readRunLogs(run) });
      throw new Error('Timed out waiting for the probe Bank. The experiment files and logs are retained; no unrelated processes were stopped.');
    }
    if ((cache.usable || run.mechanism || run.panelExperiment) && !argv.includes('--keep-open')) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await stopOwnedProbe(run);
      // Error-free matches may only have the Graphics header. Re-read after the
      // owned process closes so buffered run-scoped logs are included.
      cache = await collect(run);
    }
    if (!cache.usable || (cache.mechanismVerdict && cache.mechanismVerdict.status !== 'pass') || (cache.panelVerdict && cache.panelVerdict.status !== 'pass')) process.exitCode = 1;
  } else {
    console.log('Usage: node scripts/sc2-catalog-probe.mjs run|start|collect|stop [--queries FILE.json | --mechanism FILE.json] [--sc2 DIR] [--template DIR.SC2Map] [--documents DIR] [--database FILE] [--timeout SECONDS] [--run ID] [--keep-open]\nLocal output: %LOCALAPPDATA%/CoopAgent/catalog-probe. No original Map Runtime or database writes. --mechanism builds a disposable copy. Mechanism run closes only its own SC2 process after collection or timeout; stop also requires a uniquely owned process.');
  }
} catch (error) {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
}
