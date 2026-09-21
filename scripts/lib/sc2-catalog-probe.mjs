import { DOMParser } from '@xmldom/xmldom';

// Query descriptions and original probe code only. Engine-produced data stays local.
export const PROBE_REVISION = 1;
export const OFFICIAL_DEPENDENCY = 'bnet:Allied Commanders/0.0/1270,file:Mods\\AlliedCommanders.SC2Mod';
export const PROBE_QUERIES = [
  { id: 'wraith-weapons', kind: 'array', catalog: 'Unit', entry: 'Wraith', field: 'WeaponArray', member: 'Link' },
  { id: 'wraith-abilities', kind: 'array', catalog: 'Unit', entry: 'Wraith', field: 'AbilArray', member: 'Link' },
  { id: 'wraith-behaviors', kind: 'array', catalog: 'Unit', entry: 'Wraith', field: 'BehaviorArray', member: 'Link' },
  { id: 'blink-cooldown', kind: 'value', catalog: 'Abil', entry: 'Blink', field: 'Cost[0].Cooldown.TimeUse' },
  { id: 'blink-range-slop', kind: 'value', catalog: 'Abil', entry: 'Blink', field: 'RangeSlop' },
  { id: 'blink-effect', kind: 'array', catalog: 'Abil', entry: 'Blink', field: 'Effect' },
  { id: 'blink-name', kind: 'value', catalog: 'Abil', entry: 'Blink', field: 'Name' },
  { id: 'blink-requirement', kind: 'value', catalog: 'Abil', entry: 'Blink', field: 'CmdButtonArray[Execute].Requirements' },
  { id: 'banshee-weapon-effect', kind: 'value', catalog: 'Weapon', entry: 'StukovInfestedBacklashRockets', field: 'Effect' },
  { id: 'corpse-removed-behaviors', kind: 'array', catalog: 'Unit', entry: 'ZealotPurifierReviveCorpse', field: 'BehaviorArray', member: 'Link' },
  { id: 'corsair-validators', kind: 'array', catalog: 'Abil', entry: 'CorsairMPDisruptionWeb', field: 'AutoCastValidatorArray' },
  { id: 'blink-schema', kind: 'schema', catalog: 'Abil', entry: 'Blink' },
  { id: 'wraith-schema', kind: 'schema', catalog: 'Unit', entry: 'Wraith' },
  { id: 'weapon-schema', kind: 'schema', catalog: 'Weapon', entry: 'StukovInfestedBacklashRockets' },
];

const quote = (value) => JSON.stringify(value);

export function generateProbe({ runId, bankName, queries = PROBE_QUERIES }) {
  if (!/^[a-zA-Z0-9-]+$/.test(runId) || !/^[a-zA-Z0-9_]+$/.test(bankName)) throw new Error('Unsafe probe identity');
  for (const q of queries) {
    if (!['Unit', 'Abil', 'Weapon', 'Effect', 'Behavior', 'Upgrade', 'Requirement', 'Validator', 'Actor', 'Model', 'Button','Commander','User'].includes(q.catalog)) throw new Error('Unsupported probe catalog');
    if (!['array', 'value', 'schema','user-fixed','user-link'].includes(q.kind)) throw new Error('Unsupported probe query');
    if(q.kind.startsWith('user-')&&(q.catalog!=='User'||typeof q.instance!=='string'||!q.instance))throw Error('User query requires User catalog and instance identity.');
    if(q.maxItems!==undefined&&(q.kind!=='array'||!Number.isInteger(q.maxItems)||q.maxItems<1||q.maxItems>1024))throw Error('Array maxItems must be an integer in 1..1024.');
    if (!/^[a-zA-Z0-9-]+$/.test(q.id) || q.id === 'meta' || typeof q.entry !== 'string' || !q.entry
      || (q.kind !== 'schema' && (typeof q.field !== 'string' || !q.field))
      || (q.member !== undefined && typeof q.member !== 'string')) throw new Error('Invalid probe query');
  }
  if (!queries.length || queries.length > 512 || new Set(queries.map((q) => q.id)).size !== queries.length) throw new Error('Probe batch must have 1..512 unique query ids');
  const callbacks = queries.map((q, i) => `
bool ProbeQuery${i}(bool testConds, bool runActions) {
    ${q.kind.startsWith('user-')
      ? `ProbePut(${quote(q.id)}, "value", ${q.kind==='user-fixed'?`FixedToString(UserDataGetFixed(${quote(q.entry)}, ${quote(q.instance)}, ${quote(q.field)}, 1), 6)`:`UserDataGetGameLink(${quote(q.entry)}, ${quote(q.instance)}, ${quote(q.field)}, 1)`});\n    ProbePut(${quote(q.id)}, "status", "complete");`
      : q.kind === 'schema'
      ? `ProbeSchema(${quote(q.id)}, c_gameCatalog${q.catalog}, ${quote(q.entry)});`
      : q.kind === 'array'
        ? `ProbeArray(${quote(q.id)}, c_gameCatalog${q.catalog}, ${quote(q.entry)}, ${quote(q.field)}, ${quote(q.member ?? '')}, ${q.maxItems??256});`
        : `ProbeValue(${quote(q.id)}, c_gameCatalog${q.catalog}, ${quote(q.entry)}, ${quote(q.field)});`}
    return true;
}`).join('\n');
  return `// CoopAgent isolated Catalog experiment. No mission/commander initialization.
include "TriggerLibs/natives"
bank probeBank;
string BoolToString(bool value) {
    if (value) { return "true"; }
    return "false";
}
void ProbePut(string section, string key, string value) {
    BankValueSetFromString(probeBank, section, key, value);
}
bool ProbeEntry(string section, int catalog, string entry) {
    ProbePut(section, "valid", BoolToString(CatalogEntryIsValid(catalog, entry)));
    if (!CatalogEntryIsValid(catalog, entry)) {
        ProbePut(section, "status", "invalid-entry");
        return false;
    }
    ProbePut(section, "scope", CatalogEntryScope(catalog, entry));
    ProbePut(section, "parent", CatalogEntryParent(catalog, entry));
    ProbePut(section, "class", IntToString(CatalogEntryClass(catalog, entry)));
    return true;
}
void ProbeValue(string section, int catalog, string entry, string field) {
    if (!ProbeEntry(section, catalog, entry)) { return; }
    ProbePut(section, "value", CatalogFieldValueGet(catalog, entry, field, 0));
    ProbePut(section, "status", "complete");
}
void ProbeArray(string section, int catalog, string entry, string field, string member, int maxItems) {
    int i;
    int count;
    string itemPath;
    if (!ProbeEntry(section, catalog, entry)) { return; }
    count = CatalogFieldValueCount(catalog, entry, field, 0);
    ProbePut(section, "count", IntToString(count));
    for (i = 0; i < count && i < maxItems; i += 1) {
        itemPath = field + "[" + IntToString(i) + "]";
        if (member != "") { itemPath += "." + member; }
        ProbePut(section, "item" + IntToString(i), CatalogFieldValueGet(catalog, entry, itemPath, 0));
    }
    ProbePut(section, "status", "complete");
}
void ProbeFields(string section, string scope) {
    int i;
    int count;
    string field;
    string key;
    ProbePut(section, "scope", scope);
    count = CatalogFieldCount(scope);
    ProbePut(section, "count", IntToString(count));
    for (i = 0; i < count && i < 1024; i += 1) {
        key = "field" + IntToString(i);
        field = CatalogFieldGet(scope, i);
        ProbePut(section, key + ".name", field);
        ProbePut(section, key + ".type", CatalogFieldType(scope, field));
        ProbePut(section, key + ".category", IntToString(CatalogFieldTypeCategory(scope, field)));
        ProbePut(section, key + ".array", BoolToString(CatalogFieldIsArray(scope, field)));
        ProbePut(section, key + ".scope", BoolToString(CatalogFieldIsScope(scope, field)));
    }
}
void ProbeSchema(string section, int catalog, string entry) {
    string scope;
    if (!ProbeEntry(section, catalog, entry)) { return; }
    scope = CatalogEntryScope(catalog, entry);
    ProbeFields(section, scope);
    if (CatalogFieldExists(scope, "CmdButtonArray")) {
        ProbeFields(section + "-cmd", CatalogFieldType(scope, "CmdButtonArray"));
    }
    ProbePut(section, "status", "complete");
}
${callbacks}
bool ProbeRun(bool testConds, bool runActions) {
    probeBank = BankLoad(${quote(bankName)}, 1);
    BankWait(probeBank);
    ProbePut("meta", "runId", ${quote(runId)});
    ProbePut("meta", "revision", "${PROBE_REVISION}");
    ProbePut("meta", "player", "0");
    ProbePut("meta", "context", "official-catalog-no-mission-init-no-upgrades");
    ProbePut("meta", "map", GameMapPath());
    ProbePut("meta", "status", "running");
    BankSave(probeBank);
${queries.map((q, i) => `    ProbePut(${quote(q.id)}, "status", "started");
    TriggerExecute(TriggerCreate("ProbeQuery${i}"), false, true);
    BankSave(probeBank);`).join('\n')}
    ProbePut("meta", "status", "complete");
    BankSave(probeBank);
    Wait(2.0, c_timeGame);
    GameOver(1, c_gameOverTie, false, false);
    return true;
}
void InitMap() {
    TriggerAddEventTimeElapsed(TriggerCreate("ProbeRun"), 0.1, c_timeGame);
}
`;
}

export function parseProbeBank(xml, expectedRunId, queries = PROBE_QUERIES) {
  const errors = [];
  const doc = new DOMParser({ onError: (level, message) => errors.push(`${level}: ${message}`) }).parseFromString(xml, 'text/xml');
  if (errors.length || doc.documentElement?.tagName !== 'Bank') throw new Error('Invalid Bank XML');
  const sections = {};
  for (const section of Array.from(doc.getElementsByTagName('Section'))) {
    const values = {};
    for (const key of Array.from(section.getElementsByTagName('Key'))) {
      const value = key.getElementsByTagName('Value')[0];
      values[key.getAttribute('name')] = value?.getAttribute('string') ?? '';
    }
    sections[section.getAttribute('name')] = values;
  }
  if (sections.meta?.runId !== expectedRunId) throw new Error('Stale or unrelated Bank runId');
  if (sections.meta.status !== 'complete') throw new Error('Probe has not completed');
  const results = queries.map((query) => {
    const record = sections[query.id] ?? { status: 'missing' };
    const result = { ...query, status: record.status, scope: record.scope, parent: record.parent, class: record.class };
    if (query.kind === 'value'||query.kind.startsWith('user-')) result.value = record.value;
    if (query.kind === 'array') {
      result.count = record.count === undefined ? null : Number(record.count);
      const maxItems=Number.isInteger(query.maxItems)&&query.maxItems>0&&query.maxItems<=1024?query.maxItems:256;
      result.items = Array.from({ length: Math.min(result.count ?? 0, maxItems) }, (_, i) => record[`item${i}`] ?? null);
      result.truncated = result.count > maxItems;
    }
    if (query.kind === 'schema') {
      result.schemas = Object.entries(sections).filter(([key]) => key === query.id || key.startsWith(query.id + '-')).map(([key, data]) => ({
        key, scope: data.scope, count: Number(data.count ?? 0),
        fields: Array.from({ length: Math.min(Number(data.count ?? 0), 1024) }, (_, i) => ({
          name: data[`field${i}.name`], type: data[`field${i}.type`], category: Number(data[`field${i}.category`]),
          array: data[`field${i}.array`] === 'true', scope: data[`field${i}.scope`] === 'true',
        })),
      }));
    }
    return result;
  });
  return { meta: sections.meta, results };
}
