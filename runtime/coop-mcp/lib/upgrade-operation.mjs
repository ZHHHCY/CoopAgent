const canonical = value => String(value).replaceAll('.@', '.')
  .replace(/\[#(\d+)\]/g, '[$1]').replace(/^EffectArray(?=\.|$)/, 'EffectArray[0]');

const pick = (rows, path) => rows.find(row => canonical(row.path) === canonical(path));

/** Describe authored presence separately from the engine-effective operation.
 * An engine snapshot may expose Add for an omitted XML attribute. Without
 * that observation (or another explicit field), omission remains unresolved. */
export function resolveUpgradeOperation({ projected = null, authored = null, path }) {
  const rawExists = Boolean(authored);
  if (projected) {
    const fromEngine = String(projected.source_file ?? '').startsWith('engine:');
    return {
      rawField: { exists: rawExists, path: authored?.path ?? path,
        ...(rawExists ? { value: authored.value, source: authored.source_file } : {}) },
      effective: { status: 'resolved', value: projected.value,
        basis: fromEngine && !rawExists ? 'sc2-engine-resolved-default'
          : fromEngine ? 'explicit-confirmed-by-sc2-engine' : 'explicit-field',
        source: projected.source_file ?? null },
    };
  }
  return { rawField: { exists: rawExists, path: authored?.path ?? path,
      ...(rawExists ? { value: authored.value, source: authored.source_file } : {}) },
    effective: rawExists
      ? { status: 'resolved', value: authored.value, basis: 'explicit-field', source: authored.source_file ?? null }
      : { status: 'unresolved', value: null, basis: 'no-explicit-field-or-engine-default-evidence', source: null } };
}

export function readUpgradeOperation(db, objectId, stem, projectedRows = null) {
  const path = `${stem}.@Operation`;
  const projected = pick(projectedRows ?? db.prepare(
    'SELECT path,value,source_file FROM catalog_fields WHERE catalog=? AND object_id=?').all('Upgrade', objectId), path);
  const authoredRows = db.prepare(
    'SELECT path,value,source_file FROM main.catalog_fields WHERE catalog=? AND object_id=?').all('Upgrade', objectId);
  const authored = String(projected?.source_file ?? '').startsWith('game-a/') ? projected : pick(authoredRows, path);
  return resolveUpgradeOperation({ projected, authored, path });
}
