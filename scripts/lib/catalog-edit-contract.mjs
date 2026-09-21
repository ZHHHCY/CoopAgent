// Authoring semantics, not extracted game data. Keep adapters class-specific:
// CAbilTrain's Unit is an array; CAbilWarpTrain's Unit is a scalar.
export const catalogClassBase = (name) => name === 'CWeaponLegacy' ? 'CWeapon' : null;

export function canonicalEditPath(className, fieldPath) {
  let result = String(fieldPath);
  // Upgrade entries are records, not value="..." scalar elements. Legacy
  // database rows flattened their uppercase Value attribute onto the record.
  if (className === 'CUpgrade') {
    result = result.replace(/^EffectArray(?:\[#?(\d+)\])?(?:\.(?:@?Value))?$/, (_, index) => `EffectArray[${index ?? 0}].@Value`);
  }
  if (className === 'CAbilTrain') {
    result = result.replace(/^(InfoArray\[[^\]]+\]\.Unit)(?:\[#(\d+)\])?(?=$|\.)/, (_, root, index) => `${root}[${index ?? 0}]`);
  }
  // Ability Cost is a positional record array. Official definitions commonly
  // author the first record without an index and patch members later with
  // index="0". Both spellings address the same slot; writes use the explicit
  // index so a partial override preserves sibling members.
  if (/^CAbil/.test(className ?? '')) {
    result = result.replace(/^Cost\[#(\d+)\](?=$|\.)/, (_, index) => `Cost[${index}]`);
    result = result.replace(/^Cost(?=\.)/, 'Cost[0]');
  }
  if (className === 'CUnit') {
    result = result.replace(/^(WeaponArray|TechTreeProducedUnitArray)(?:\[#(\d+)\])?(?=$|\.)/, (_, root, index) => `${root}[${index ?? 0}]`);
  }
  if (className === 'CCommander') {
    result = result.replace(/^MasteryTalentArray\[#(\d+)\]/, 'MasteryTalentArray[$1]')
      .replace(/^(MasteryTalentArray\[\d+\])\.@ValuePerRank$/, '$1.ValuePerRank');
  }
  return result;
}

export function requireCanonicalEditPath(className, fieldPath) {
  const canonical = canonicalEditPath(className, fieldPath);
  if (canonical !== fieldPath) throw new Error(`Non-canonical ${className} field ${fieldPath}; use ${canonical}. Array indices are required by the engine.`);
}

// Reading an ordinal is not evidence that an index="n" sparse override has the
// same identity. Keep this decision shared by query, solver and executor.
export function ordinalEditSupport(className, fieldPath, { identityKey = null, engineVerified = false } = {}) {
  if (identityKey) return { supported: false, reason: 'identity-selector-required',
    message: `${fieldPath} traverses an unindexed ${identityKey}-keyed record. A numeric ordinal cannot safely author a sparse index override. This record layout needs an identity-preserving editor; changing expect or guessing another index cannot resolve it.` };
  const adapted = className === 'CUpgrade' && /^EffectArray\[\d+\](?:\.|$)/.test(fieldPath)
    // Native B97579 map-layer experiment c176ab1d: six commanders, changed
    // ValuePerRank while every Talent, array count, sibling and MaxRank survived.
    || className === 'CCommander' && /^MasteryTalentArray\[\d+\]\.ValuePerRank$/.test(fieldPath)
    || className === 'CAbilTrain' && /^InfoArray\[[^\]]+\]\.Unit\[\d+\](?:\.|$)/.test(fieldPath)
    || className === 'CUnit' && /^(WeaponArray|TechTreeProducedUnitArray)\[\d+\](?:\.|$)/.test(fieldPath)
    || /^CAbil/.test(className ?? '') && /^Cost\[\d+\](?:\.|$)/.test(fieldPath);
  if (adapted || engineVerified) return { supported: true, reason: null };
  return { supported: false, reason: 'ordinal-index-unverified',
    message: `${fieldPath} is readable ordinal evidence, but its sparse index override is not verified. Resolve the field's array layout before editing; changing expect cannot establish write support.` };
}
