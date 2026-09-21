// Observer-only engine acceptance. Expected values are test requirements, never
// calculated from the executor's projection or copied out of generated XML.
import { cp, mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';

const exec = promisify(execFile);
const hash = (s) => createHash('sha256').update(s).digest('hex');
const q = JSON.stringify;
export function validateMechanismConfig(config) {
  if (!config || !['swann', 'karax', 'raynor'].includes(config.scenario)
      || typeof config.sourceProject !== 'string' || !path.isAbsolute(config.sourceProject)
      || !Number.isInteger(config.prestige ?? 0) || (config.prestige ?? 0) < 0 || (config.prestige ?? 0) > 3
      || !['integration', 'controlled'].includes(config.mode ?? 'integration')
      || (config.mode === 'controlled' && config.scenario === 'karax')
      || Object.keys(config).some((k) => !['scenario', 'sourceProject', 'prestige', 'mode'].includes(k))) {
    throw new Error('Mechanism config requires scenario swann|karax|raynor, absolute sourceProject, prestige 0..3, mode integration|controlled (controlled: swann/raynor only)');
  }
  return { ...config, prestige: config.prestige ?? 0, mode: config.mode ?? 'integration' };
}

export async function fingerprintTree(root) {
  const files = [];
  async function walk(dir) {
    for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, e.name);
      if (e.isSymbolicLink()) throw new Error(`Probe sources must not contain symlinks: ${file}`);
      if (e.isDirectory()) await walk(file);
      else files.push({ path: path.relative(root, file).replaceAll('\\', '/'), sha256: hash(await readFile(file)) });
    }
  }
  await walk(root);
  return { sha256: hash(JSON.stringify(files)), files };
}

export function generateMechanismObserver(rawConfig, { runId, bankName }) {
  const config = validateMechanismConfig(rawConfig);
  if (!/^[a-zA-Z0-9-]+$/.test(runId) || !/^[a-zA-Z0-9]+$/.test(bankName)) throw new Error('Unsafe probe identity');
  if (config.mode === 'controlled') return generateControlledObserver(config, { runId, bankName });
  const { scenario, prestige } = config;
  const commander = { swann: 'TerranSwann', karax: 'ProtossKarax', raynor: 'TerranRaynor' }[scenario];
  const unitType = { swann: 'ScienceVessel', karax: 'ImmortalAiur', raynor: 'Marine' }[scenario];
  const generated = { swann: ['f1f20dead96e79e7', 'c31278a5639686e5'], karax: ['cffabcc0507a8cf5', '032a9e0cab8e78da'], raynor: ['d05e3c2e1152f273'] }[scenario].map((id) => `GameACommanderStat${id}`);
  const rows = [];
  function record(id, expression, expected, type = 'number') {
    rows.push({ id, kind: 'value', catalog: 'Unit', entry: unitType, field: 'engine-observation', expected, valueType: type });
    return `    MechanismPut(${q(id)}, ${type === 'string' ? expression : `FixedToString(${expression}, 4)`});`;
  }
  const level = (id, player = 1) => `TechTreeUpgradeCount(${player}, ${q(id)}, c_techCountCompleteOnly)`;
  const prop = (u, key) => `UnitGetPropertyFixed(${u}, c_unitProp${key}, true)`;
  const cat = (catalog, entry, field, player = 1) => `CatalogFieldValueGet(c_gameCatalog${catalog}, ${q(entry)}, ${q(field)}, ${player})`;
  function stage(name) {
    return [
      record(`${name}-commander`, 'libCOOC_gf_ActiveCommanderForPlayer(1)', commander, 'string'),
      ...generated.map((id, i) => record(`${name}-patch${i}`, level(id), name === 'settled' ? (scenario === 'karax' && prestige !== 2 ? 0 : 1) : undefined)),
      record(`${name}-prestige`, level('CommanderPrestigeKaraxArmy'), name === 'settled' && scenario === 'karax' ? (prestige === 2 ? 1 : 0) : undefined),
      record(`${name}-existing-max`, prop('mechanismExisting', scenario === 'karax' ? 'ShieldsMax' : 'LifeMax'), name === 'settled' && scenario !== 'raynor' ? (scenario === 'swann' ? 300 : prestige === 2 ? 125 : 100) : undefined),
      record(`${name}-existing-current`, prop('mechanismExisting', scenario === 'karax' ? 'Shields' : 'Life')),
    ].join('\n');
  }
  const stages = ['configured', 'tech-applied', 'settled'].map((name) => `    if (stage == ${q(name)}) {\n${stage(name)}\n    }`).join('\n');
  const spawn = (variable, type, player) => `    UnitCreate(1, ${q(type)}, c_unitCreateIgnorePlacement, ${player}, Point(32.0, 32.0), 0.0);\n    ${variable} = UnitLastCreated();`;
  let measurements = [spawn('fresh', unitType, 1), record('new-unit-type', 'UnitGetType(fresh)', unitType, 'string')];
  if (scenario !== 'raynor') {
    const expected = scenario === 'swann' ? 300 : prestige === 2 ? 125 : 100;
    const base = scenario === 'swann' ? 200 : 100;
    const key = scenario === 'swann' ? 'Life' : 'Shields';
    measurements.push(record('new-max', prop('fresh', key + 'Max'), expected), record('new-current', prop('fresh', key), expected),
      record('catalog-max', `StringToFixed(${cat('Unit', unitType, key + 'Max')})`, expected),
      spawn('control', unitType, 2), record('control-max', prop('control', key + 'Max'), base), record('control-current', prop('control', key), base));
    if (scenario === 'swann') measurements.push(record('original-health-upgrade', level('SwannCommanderVehicleHealth'), 1));
  } else {
    // Execute the effect reached through the real spawned Marine's weapon. This
    // proves engine damage/isolation, not attack cadence or order acquisition.
    function hit(prefix, owner, expected) {
      return [spawn('attacker', 'Marine', owner), spawn('target', 'Marine', 15),
        '    UnitSetState(attacker, c_unitStatePaused, true);\n    UnitSetState(target, c_unitStatePaused, true);',
        record(`${prefix}-armor`, prop('target', 'LifeArmor'), 0), record(`${prefix}-shields`, prop('target', 'Shields'), 0),
        record(`${prefix}-attacker-type`, 'UnitGetType(attacker)', 'Marine', 'string'),
        record(`${prefix}-target-type`, 'UnitGetType(target)', 'Marine', 'string'),
        record(`${prefix}-weapon`, 'UnitWeaponGet(attacker, 1)', 'GuassRifle', 'string'),
        '    weapon = UnitWeaponGet(attacker, 1);',
        '    effect = CatalogFieldValueGet(c_gameCatalogWeapon, weapon, "Effect", ' + owner + ');',
        record(`${prefix}-effect`, 'effect', 'GuassRifle', 'string'),
        `    before = ${prop('target', 'Life')};`,
        '    UnitCreateEffectUnit(attacker, effect, target);',
        record(`${prefix}-damage`, `before - ${prop('target', 'Life')}`, expected),
        '    UnitRemove(attacker);\n    UnitRemove(target);'].join('\n');
    }
    measurements.push(record('research-before', level('TerranInfantryWeaponsLevel1'), 0), hit('raynor', 1, 8), hit('ally-raynor', 2, 8), hit('unmodified-player', 14, 6),
      '    TechTreeUpgradeAddLevel(1, "TerranInfantryWeaponsLevel1", 1);', record('research-after', level('TerranInfantryWeaponsLevel1'), 1),
      hit('raynor-researched', 1, 9), hit('ally-after-research', 2, 8), hit('unmodified-after-research', 14, 6));
  }
  const galaxy = `// Observer attached only to a disposable copy of the actual host map.
bank mechanismBank;
unit mechanismExisting;
bool mechanismReady = false;
void MechanismPut(string id, string value) {
    BankValueSetFromString(mechanismBank, id, "value", value);
    BankValueSetFromString(mechanismBank, id, "status", "complete");
    BankSave(mechanismBank);
}
void MechanismStage(string stage) {
    if (!mechanismReady) { return; }
${stages}
}
bool MechanismRun(bool testConds, bool runActions) {
    unit fresh;
    unit control;
    unit attacker;
    unit target;
    string weapon;
    string effect;
    fixed before;
    mechanismBank = BankLoad(${q(bankName)}, 1);
    BankWait(mechanismBank);
    BankValueSetFromString(mechanismBank, "meta", "runId", ${q(runId)});
    BankValueSetFromString(mechanismBank, "meta", "status", "running");
    BankValueSetFromString(mechanismBank, "meta", "context", "actual-game-a-host-autostart");
    BankValueSetFromString(mechanismBank, "meta", "map", GameMapPath());
    BankSave(mechanismBank);
    gameA_selectedCommander = ${q(commander)};
    gameA_selectedPrestige = ${prestige};
    gameA_commanderSelected = true;
    GameA_PreparationOptionsCommanderChanged(gameA_selectedCommander);
${spawn('mechanismExisting', unitType, 1)}
    mechanismReady = true;
    GameA_OnStart(false, true);
    Wait(12.0, c_timeGame);
    MechanismStage("settled");
${measurements.join('\n')}
    BankValueSetFromString(mechanismBank, "meta", "status", "complete");
    BankSave(mechanismBank);
    return true;
}
`;
  return { galaxy, queries: rows, generatedUpgrades: generated };
}


function generateControlledObserver(config, { runId, bankName }) {
  const swann = config.scenario === 'swann';
  const generatedUpgrades = (swann ? ['f1f20dead96e79e7', 'c31278a5639686e5'] : ['d05e3c2e1152f273']).map((s) => 'GameACommanderStat' + s);
  const queries = [];
  const lines = [];
  function record(id, expression, expected, valueType = 'number') {
    queries.push({ id, kind: 'value', catalog: 'Unit', entry: swann ? 'ScienceVessel' : 'Marine', field: 'engine-observation', expected, valueType });
    lines.push(`    MechanismPut(${q(id)}, ${valueType === 'string' ? expression : `FixedToString(${expression}, 4)`});`);
  }
  function grant(player, id) {
    lines.push(`    TechTreeUpgradeAddLevel(${player}, ${q(id)}, 1);`);
    record(`grant-${player}-${id}`, `TechTreeUpgradeCount(${player}, ${q(id)}, c_techCountCompleteOnly)`, 1);
  }
  function spawn(variable, type, owner) { lines.push(`    UnitCreate(1, ${q(type)}, c_unitCreateIgnorePlacement, ${owner}, Point(32.0, 32.0), 0.0);`, `    ${variable} = UnitLastCreated();`, `    UnitSetState(${variable}, c_unitStatePaused, true);`); }
  const prop = (u, key) => `UnitGetPropertyFixed(${u}, c_unitProp${key}, true)`;
  function health(prefix, u, expected, born = false) {
    record(prefix + '-max', prop(u, 'LifeMax'), expected);
    record(prefix + '-current', prop(u, 'Life'), born ? expected : undefined);
  }
  function damage(prefix, owner, expected) {
    spawn('attacker', 'Marine', owner); spawn('target', 'Marine', 15);
    record(prefix + '-armor', prop('target', 'LifeArmor'), 0);
    record(prefix + '-shields', prop('target', 'Shields'), 0);
    record(prefix + '-attacker-type', 'UnitGetType(attacker)', 'Marine', 'string');
    record(prefix + '-target-type', 'UnitGetType(target)', 'Marine', 'string');
    record(prefix + '-weapon', 'UnitWeaponGet(attacker, 1)', 'GuassRifle', 'string');
    lines.push(`    effect = CatalogFieldValueGet(c_gameCatalogWeapon, UnitWeaponGet(attacker, 1), "Effect", ${owner});`);
    record(prefix + '-effect', 'effect', 'GuassRifle', 'string');
    lines.push(`    before = ${prop('target', 'Life')};`, '    UnitCreateEffectUnit(attacker, effect, target);');
    record(prefix + '-damage', `before - ${prop('target', 'Life')}`, expected);
    lines.push('    UnitRemove(attacker);', '    UnitRemove(target);');
  }
  if (swann) {
    for (const [player, order] of [[1, 'set-add'], [2, 'add-set']]) {
      spawn('existing', 'ScienceVessel', player); health(order + '-base', 'existing', 200, true);
      if (player === 2) grant(player, 'SwannCommanderVehicleHealth');
      for (const id of generatedUpgrades) grant(player, id);
      if (player === 1) health(order + '-set-only', 'existing', 260);
      if (player === 1) grant(player, 'SwannCommanderVehicleHealth');
      health(order + '-existing', 'existing', 300);
      spawn('fresh', 'ScienceVessel', player); health(order + '-new', 'fresh', 300, true);
      record(order + '-catalog', `StringToFixed(CatalogFieldValueGet(c_gameCatalogUnit, "ScienceVessel", "LifeMax", ${player}))`, 300);
    }
    spawn('fresh', 'ScienceVessel', 3); health('unmodified-player', 'fresh', 200, true);
  } else {
    grant(1, generatedUpgrades[0]); damage('set-only', 1, 8);
    // The unsuffixed TerranInfantryWeapons is default="1", a template, NOT
    // the upgrade researched in EngineeringBayResearch.InfoArray[Research3].
    grant(1, 'TerranInfantryWeaponsLevel1'); damage('set-add', 1, 9);
    grant(2, 'TerranInfantryWeaponsLevel1'); damage('add-only', 2, 7);
    grant(2, generatedUpgrades[0]); damage('add-set', 2, 9);
    damage('unmodified-player', 3, 6);
  }
  return { queries, generatedUpgrades, galaxy: `// Controlled mechanism experiment: explicit upgrade grants, NO mission or commander init.
include "TriggerLibs/natives"
bank mechanismBank;
void MechanismPut(string id, string value) {
    BankValueSetFromString(mechanismBank, id, "value", value);
    BankValueSetFromString(mechanismBank, id, "status", "complete");
    BankSave(mechanismBank);
}
bool MechanismRun(bool testConds, bool runActions) {
    unit existing;
    unit fresh;
    unit attacker;
    unit target;
    string effect;
    fixed before;
    mechanismBank = BankLoad(${q(bankName)}, 1);
    BankWait(mechanismBank);
    BankValueSetFromString(mechanismBank, "meta", "runId", ${q(runId)});
    BankValueSetFromString(mechanismBank, "meta", "status", "running");
    BankValueSetFromString(mechanismBank, "meta", "context", "controlled-explicit-upgrades-no-commander-init");
    BankSave(mechanismBank);
${lines.join('\n')}
    BankValueSetFromString(mechanismBank, "meta", "status", "complete");
    BankSave(mechanismBank);
    return true;
}
void InitMap() {
    TriggerAddEventTimeElapsed(TriggerCreate("MechanismRun"), 0.2, c_timeGame);
}
` };
}

// A missing record, invalid number, incomplete lifecycle or bad log never passes.
export function evaluateMechanism(results, transportUsable) {
  const checks = results.filter((r) => r.expected !== undefined).map((r) => {
    const valid = r.status === 'complete' && typeof r.value === 'string' && r.value.trim() !== ''
      && (r.valueType === 'string' || (/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(r.value) && Number.isFinite(Number(r.value))));
    const actual = r.valueType === 'string' ? r.value : valid ? Number(r.value) : null;
    return { id: r.id, expected: r.expected, actual, status: !valid ? 'inconclusive' :
      (r.valueType === 'string' ? actual === r.expected : Math.abs(actual - r.expected) < 0.001) ? 'pass' : 'fail' };
  });
  return { status: !transportUsable || !checks.length || checks.some((c) => c.status === 'inconclusive') ? 'inconclusive' : checks.some((c) => c.status === 'fail') ? 'fail' : 'pass',
    passed: checks.filter((c) => c.status === 'pass').length, total: checks.length, checks,
    boundary: 'See run.context for integration vs explicit-grant control. Unit properties and weapon damage effects only; not a full mission playthrough or attack cadence test.' };
}

export async function prepareMechanismProbe({ config: rawConfig, runDirectory, mapPath, runId, bankName }) {
  const config = validateMechanismConfig(rawConfig);
  const source = path.join(config.sourceProject, 'game-a');
  const before = await fingerprintTree(path.join(source, 'core'));
  // Windows PowerShell 5 Copy-Item still hits MAX_PATH on deep build outputs.
  // A short, unique sibling workspace avoids changing the production builder.
  const buildRoot = path.resolve(runDirectory, '../..', 'mb');
  await mkdir(buildRoot, { recursive: true });
  const isolated = path.join(await mkdtemp(path.join(buildRoot, 'p-')), 'game-a');
  await mkdir(isolated, { recursive: true });
  // Production builder, unchanged, operates only on a new local copy.
  for (const relative of ['core', 'projects/GameA-OblivionExpress.SC2Map', 'scripts', 'hosts.json', 'runtime-baseline.json']) {
    await cp(path.join(source, relative), path.join(isolated, relative), { recursive: true });
  }
  const builder = await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(isolated, 'scripts/build-game-a.ps1'), '-HostId', 'oblivion-express'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  await writeFile(path.join(runDirectory, 'build.log'), builder.stdout + builder.stderr);
  const component = builder.stdout.trim().split(/\r?\n/).findLast((line) => line.endsWith('ComponentList.SC2Components'));
  if (!component || !path.resolve(component).startsWith(isolated + path.sep)) throw new Error('Isolated builder did not return its own map');
  await cp(path.dirname(component), mapPath, { recursive: true });
  const artifact = await fingerprintTree(mapPath);
  const observer = generateMechanismObserver(config, { runId, bankName });
  const sourcePreserved = (await fingerprintTree(path.join(source, 'core'))).sha256 === before.sha256;
  if (!sourcePreserved) throw new Error('Source changed while preparing the probe');
  if (config.mode === 'controlled') return { galaxy: observer.galaxy, queries: observer.queries,
    context: { missionInitialized: false, commanderInitialized: false, gameAPatchesLoaded: true, explicitUpgradeGrants: true },
    mechanism: { revision: 1, config, isolatedBuild: isolated, generatedUpgrades: observer.generatedUpgrades, sourceCore: before, builtMap: artifact,
      sourcePreserved } };
  const scriptPath = path.join(mapPath, 'MapScript.galaxy');
  let script = await readFile(scriptPath, 'utf8');
  if ((script.match(/void InitMap\s*\(\s*\)\s*\{/g) ?? []).length !== 1) throw new Error('Expected one host InitMap');
  if (script.split('include "scripts/generated/GameABootstrap"').length !== 2) throw new Error('Expected one actual Game A bootstrap include');
  script = script.replace('include "scripts/generated/GameABootstrap"', 'void MechanismStage(string stage);\ninclude "scripts/generated/GameABootstrap"');
  script = script.replace(/void InitMap\s*\(\s*\)\s*\{/, observer.galaxy + '\nvoid InitMap () {\n    TriggerAddEventTimeElapsed(TriggerCreate("MechanismRun"), 0.2, c_timeGame);');
  const core = path.join(mapPath, 'scripts/generated/GameACore.galaxy');
  const integration = path.join(mapPath, 'scripts/generated/GameAIntegration.galaxy');
  async function insert(file, needle, replacement) {
    const text = await readFile(file, 'utf8');
    if (text.split(needle).length !== 2) throw new Error(`Cannot instrument lifecycle: ${file}`);
    await writeFile(file, text.replace(needle, replacement));
  }
  await insert(core, 'GameA_GeneratedConfigureCommander();', 'GameA_GeneratedConfigureCommander();\n    MechanismStage("configured");');
  await insert(integration, 'libCOOC_gf_CC_InitNonDefeatedPlayers();', 'MechanismStage("tech-applied");\n    libCOOC_gf_CC_InitNonDefeatedPlayers();');
  const after = await fingerprintTree(path.join(source, 'core'));
  if (before.sha256 !== after.sha256) throw new Error('Source changed while preparing the probe');
  return { galaxy: script, queries: observer.queries, context: { missionInitialized: 'observed-at-runtime', commanderInitialized: 'observed-at-runtime', gameAPatchesLoaded: true },
    mechanism: { revision: 1, config, isolatedBuild: isolated, generatedUpgrades: observer.generatedUpgrades, sourceCore: before, builtMap: artifact, sourcePreserved: true } };
}
