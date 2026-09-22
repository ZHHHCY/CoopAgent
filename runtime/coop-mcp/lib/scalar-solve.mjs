import { createHash } from 'node:crypto';
import { canonicalFieldPath } from './game-a-projection.mjs';
import { readScopedBatch } from './scoped-read-batch.mjs';

// Decimal rational arithmetic: no eval, implicit rounding, or boolean coercion.
const gcd = (a, b) => b ? gcd(b, a % b) : a < 0n ? -a : a;
function rational(n, d = 1n) {
  if (!d) throw Error('Cannot divide by zero');
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d); return { n: n / g, d: d / g };
}
function decimal(value) {
  if (!['number', 'string'].includes(typeof value)) throw Error('Expected a finite decimal number, not a boolean or record');
  const match = String(value).match(/^(-?)(\d*\.?\d+)(?:e([+-]?\d+))?$/i);
  if (!match || !Number.isFinite(Number(value))) throw Error('Expected a finite decimal number');
  const digits = match[2].replace('.', '');
  const scale = (match[2].split('.')[1]?.length ?? 0) - Number(match[3] ?? 0);
  if (Math.abs(scale) > 300 || digits.length > 310) throw Error('Decimal exceeds supported precision');
  const n = BigInt(digits) * (match[1] ? -1n : 1n);
  return scale >= 0 ? rational(n, 10n ** BigInt(scale)) : rational(n * 10n ** BigInt(-scale));
}
const add = (a, b) => rational(a.n * b.d + b.n * a.d, a.d * b.d);
const neg = a => rational(-a.n, a.d);
const sub = (a, b) => add(a, neg(b));
const mul = (a, b) => rational(a.n * b.n, a.d * b.d);
const div = (a, b) => rational(a.n * b.d, a.d * b.n);
const eq = (a, b) => a.n === b.n && a.d === b.d;
const one = decimal(1), hundred = decimal(100);
function number(a) {
  const result = Number(a.n) / Number(a.d);
  if (!Number.isFinite(result) || !eq(decimal(result), a)) {
    throw Error('Result is not an exact JSON decimal; specify roundingDecimals explicitly');
  }
  return result;
}
function rounded(a, places) {
  if (places === undefined) return a;
  if (!Number.isInteger(places) || places < 0 || places > 8) throw Error('roundingDecimals must be 0–8');
  const scale = 10n ** BigInt(places), n = a.n * scale;
  let q = n / a.d;
  if ((n % a.d < 0n ? -(n % a.d) : n % a.d) * 2n >= a.d) q += n < 0n ? -1n : 1n;
  return rational(q, scale);
}
function transform(a, input) {
  const b = decimal(input.value);
  switch (input.kind) {
    case 'set': return b;
    case 'add': return add(a, b);
    case 'subtract': return sub(a, b);
    case 'multiply': return mul(a, b);
    case 'divide': return div(a, b);
    case 'increase-percent': return mul(a, add(one, div(b, hundred)));
    case 'decrease-percent': return mul(a, sub(one, div(b, hundred)));
    default: throw Error('Unknown scalar transform');
  }
}
function semantic(raw, kind, reverse = false) {
  switch (kind) {
    case 'number': return raw;
    case 'damage-reduction-percent': return reverse ? sub(one, div(raw, hundred)) : mul(sub(one, raw), hundred);
    case 'bonus-percent': return reverse ? div(raw, hundred) : mul(raw, hundred);
    case 'supply-cost': return neg(raw);
    default: throw Error('Unknown scalar meaning');
  }
}
export const SCALAR_TRANSFORMS = ['set', 'add', 'subtract', 'multiply', 'divide', 'increase-percent', 'decrease-percent'];
export const SCALAR_MEANINGS = ['number', 'damage-reduction-percent', 'bonus-percent', 'supply-cost'];

function applyModifier(base, operation, operand) {
  switch (operation) {
    case 'Add': return add(base, operand);
    case 'Subtract': return sub(base, operand);
    case 'Set': return operand;
    case 'Multiply': return mul(base, operand);
    case 'Divide': return div(base, operand);
    default: throw Error(`Unsupported Upgrade operation: ${operation}`);
  }
}
function inverseModifier(base, operation, desired) {
  switch (operation) {
    case 'Add': return sub(desired, base);
    case 'Subtract': return sub(base, desired);
    case 'Set': return desired;
    case 'Multiply': return div(desired, base);
    case 'Divide': return div(base, desired);
    default: throw Error(`Unsupported Upgrade operation: ${operation}`);
  }
}
function upgradeEntries(search, context) {
  const records = new Map(); let offset = 0;
  do {
    const page = search.execute({ ...context, operation: 'entity.get', catalog: 'Upgrade',
      objectId: context.prestigeUpgrade, fieldPrefix: 'EffectArray', limit: 100, offset });
    for (const f of page.fields ?? []) {
      const m = f.path.match(/^EffectArray(?:\[#?(\d+)\])?(?:\.@?(Value|Reference|Operation))?$/);
      if (!m) continue;
      const index = Number(m[1] ?? 0), entry = records.get(index) ?? { index };
      entry[m[2] ?? 'Value'] = f.value; records.set(index, entry);
    }
    const next = page.nextOffset;
    if (next == null) {
      if (page.truncated) throw Error('Upgrade field pagination is incomplete');
      break;
    }
    if (next <= offset) throw Error('Upgrade pagination did not advance');
    offset = next;
  } while (true);
  return [...records.values()].sort((a, b) => a.index - b.index);
}

/** Read one consistent Map Runtime snapshot. Evaluate only the explicitly selected
 * prestige and recorded same-field commander Set; never claim live-game totals. */
export function solveScalar(search, input) {
  if (!input.commanderId || !input.target?.catalog || !input.target?.objectId || !input.target?.path) {
    throw Error('Provide commanderId and an exact catalog/objectId/path target');
  }
  const context = { commanderId: input.commanderId, ...(input.prestigeUpgrade ? { prestigeUpgrade: input.prestigeUpgrade } : {}) };
  return search.withProjectDatabase(context, () => {
    const target = input.target, basis = input.basis ?? 'current', meaning = input.meaning ?? 'number';
    if (!['current', 'catalog'].includes(basis)) throw Error('basis must be current or catalog');
    const query = t => search.execute({ ...context, operation: 'entity.get', ...t, include: ['effectiveField'] });
    const facts = query(target), state = facts.editState;
    if (!state?.edit?.available || !state.catalogEdit?.available) throw Error(`Scalar field is not safely readable: ${state?.edit?.reason ?? 'missing edit state'}`);
    const base = decimal(state.catalogEdit.expect);
    let current = base, edit = state.edit, modifier = null;
    const modifiers = [];
    if (basis === 'catalog' && state.commanderPatch) throw Error('A commander edit already overrides this field; use current basis for continuous editing');
    if (meaning === 'supply-cost' && !(target.catalog === 'Unit' && canonicalFieldPath(target.path) === 'food')) {
      throw Error('supply-cost requires Unit.Food');
    }
    if (meaning === 'damage-reduction-percent' && !/damageResponse\.@?modifyFraction$/i.test(target.path)) {
      throw Error('damage-reduction-percent requires DamageResponse.ModifyFraction');
    }
    if (basis === 'current' && input.prestigeUpgrade && target.catalog !== 'Upgrade') {
      const targetKey = [target.catalog, target.objectId, canonicalFieldPath(target.path)].join(',').toLowerCase();
      for (const entry of upgradeEntries(search, context)) {
        if (typeof entry.Reference !== 'string') continue;
        const parts = entry.Reference.split(',');
        const refKey = [parts[0], parts[1], canonicalFieldPath(parts.slice(2).join(','))].join(',').toLowerCase();
        if (refKey !== targetKey) continue;
        const operation = entry.Operation ?? 'Add';
        const operand = decimal(entry.Value), before = current;
        current = applyModifier(current, operation, operand);
        modifiers.push({ index: entry.index, operation, operand: number(operand), before: number(before), after: number(current), reference: entry.Reference });
      }
      if (modifiers.length > 1) throw Error('Multiple prestige modifiers affect this field; v1 requires an explicit implementation');
      if (modifiers.length === 1 && !state.commanderPatch) {
        modifier = modifiers[0];
        const f = query({ catalog: 'Upgrade', objectId: input.prestigeUpgrade, path: `EffectArray[${modifier.index}].@Value` });
        edit = f.editState?.catalogEdit;
        if (!edit?.available || edit.expect !== modifier.operand) throw Error('Upgrade modifier is not an unambiguous editable number');
      }
    }
    if (basis === 'current' && state.commanderPatch) {
      if (input.prestigeUpgrade && state.edit.operation.prestigeUpgrade !== input.prestigeUpgrade) {
        throw Error('An unconditional commander Set overlaps this prestige; activation order needs an explicit implementation');
      }
      current = decimal(state.commanderPatch.value);
    }
    if (target.catalog === 'Upgrade') edit = state.catalogEdit;
    const currentMeaning = semantic(current, meaning);
    const desiredMeaning = rounded(transform(currentMeaning, input.transform ?? {}), input.roundingDecimals);
    const desired = semantic(desiredMeaning, meaning, true);
    if (meaning === 'damage-reduction-percent' && (number(desiredMeaning) < 0 || number(desiredMeaning) > 100)) throw Error('Damage reduction must be 0–100 percent');
    const solved = modifier ? inverseModifier(base, modifier.operation, desired) : desired;
    // Verify by forward substitution independently of the transform.
    const verified = modifier ? applyModifier(base, modifier.operation, solved) : solved;
    if (!eq(verified, desired)) throw Error('Scalar postcondition failed');
    const already = eq(current, desired);
    const operation = { ...edit.operation, opId: 'scalar-change', expect: edit.expect, value: number(solved) };
    const result = { status: already ? 'already-at-target' : 'solved', target, basis, meaning,
      commanderId: input.commanderId, prestigeUpgrade: input.prestigeUpgrade ?? null,
      catalogValue: number(base), currentValue: number(current), currentMeaning: number(currentMeaning),
      desiredMeaning: number(desiredMeaning), desiredValue: number(desired), modifiers,
      operation: already ? null : operation, requiredDependsOn: edit.requiredDependsOn ?? [],
      postcondition: { value: number(verified), verifiedBySubstitution: true, runtimeVerified: false },
      provenance: { catalog: state.coreCatalog, commanderPatch: state.commanderPatch },
      coverage: 'Catalog + selected prestige + recorded commander Set only; other research, buffs and Galaxy are not evaluated.',
      handoff: {
        action: already ? 'report-if-requested-context-is-covered' : 'reuse-operation-with-evidence-based-scope',
        remainingResponsibility: 'Confirm target meaning, relevant activation conditions and consumers. Solved arithmetic is not scope or runtime proof.',
        verificationQuery: { operation: 'entity.get', ...context, ...target },
        note: already
          ? 'No operation is needed for this field in the evaluated context. Do not submit an equal expect/value change.'
          : 'Reuse operation and requiredDependsOn; assign a unique opId when batching. Consult .opencode/skills/coop-scalar-change/plan.md for the plan envelope. Investigate further only for a specific missing relevant fact; runtimeVerified:false alone is not a diagnostic.',
      },
      ...(input.roundingDecimals !== undefined ? { rounding: { decimals: input.roundingDecimals, mode: 'half-away-from-zero' } } : {}),
    };
    result.calculationId = createHash('sha256').update(JSON.stringify({ input, result })).digest('hex');
    return result;
  });
}

// Re-read relevant calculations at preparation, including upstream Catalog values
// whose changes would not be caught by the modifier's own expect alone.
export function checkScalarCalculations(search, plan, calculations) {
  const checks=[];
  for (const { input, result } of calculations) {
    const expected = result.operation;
    if (!expected) continue;
    const matches = (plan.operations ?? []).filter(op => op.kind === expected.kind && op.catalog === expected.catalog && op.object === expected.object
      && canonicalFieldPath(op.path) === canonicalFieldPath(expected.path)
      && op.commanderId === expected.commanderId && op.prestigeUpgrade === expected.prestigeUpgrade);
    if (!matches.length) continue;
    checks.push({input,result,expected,matches});
  }
  const refreshed=readScopedBatch(search,checks.map(c=>c.input),input=>solveScalar(search,input));
  for(const [index,{result,expected,matches}] of checks.entries()) {
    const fresh=refreshed[index];
    if(fresh.status==='unsupported')throw Error(`Scalar calculation could not be rechecked: ${fresh.error}`);
    if (fresh.calculationId !== result.calculationId) throw Error('Scalar calculation is stale; run scalar_solve again');
    for (const op of matches) if (op.expect !== expected.expect || op.value !== expected.value) {
      throw Error(`Plan differs from scalar_solve for ${op.object}.${op.path}: expected ${expected.expect} -> ${expected.value}`);
    }
  }
}
