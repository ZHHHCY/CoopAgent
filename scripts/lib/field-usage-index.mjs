export const FIELD_USAGE_INDEX_VERSION = 2;

const CATALOG_TYPES = new Map([
  ['c_gameCatalogAbil', 'Abil'],
  ['c_gameCatalogBehavior', 'Behavior'],
  ['c_gameCatalogEffect', 'Effect'],
  ['c_gameCatalogUnit', 'Unit'],
  ['c_gameCatalogUpgrade', 'Upgrade'],
  ['c_gameCatalogWeapon', 'Weapon'],
]);

const CALL_PATTERN = /\b((?:libNtve_gf_)?CatalogFieldValue(?:Get|Set|Modify)(?:AsReal|AsInt)?)\b/g;

function maskNonCode(source) {
  const output = [...source];
  let state = 'code';
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index], next = source[index + 1];
    if (state === 'code') {
      if (current === '"') { output[index] = ' '; state = 'string'; }
      else if (current === '/' && next === '/') { output[index] = output[index + 1] = ' '; index += 1; state = 'line-comment'; }
      else if (current === '/' && next === '*') { output[index] = output[index + 1] = ' '; index += 1; state = 'block-comment'; }
      continue;
    }
    if (current !== '\n' && current !== '\r') output[index] = ' ';
    if (state === 'string') {
      if (current === '\\' && next !== undefined) { if (next !== '\n' && next !== '\r') output[index + 1] = ' '; index += 1; }
      else if (current === '"') state = 'code';
    } else if (state === 'line-comment' && current === '\n') state = 'code';
    else if (state === 'block-comment' && current === '*' && next === '/') {
      output[index + 1] = ' '; index += 1; state = 'code';
    }
  }
  return output.join('');
}

function lineAt(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

function matchingDelimiter(masked, start, open = '(', close = ')') {
  let depth = 0;
  for (let index = start; index < masked.length; index += 1) {
    if (masked[index] === open) depth += 1;
    else if (masked[index] === close && --depth === 0) return index;
  }
  return -1;
}

function functionRanges(masked) {
  const ranges = [];
  const declaration = /(?:^|\n)\s*(?:static\s+)?[A-Za-z_][A-Za-z0-9_]*(?:\s*\[[^\]]*\])?\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;{}]*\)\s*\{/g;
  for (const match of masked.matchAll(declaration)) {
    const open = masked.indexOf('{', match.index + match[0].lastIndexOf('{'));
    const close = matchingDelimiter(masked, open, '{', '}');
    if (close >= 0) ranges.push({ name: match[1], start: open, end: close });
  }
  return ranges;
}

function functionAt(ranges, offset) {
  return ranges.find(range => range.start < offset && offset < range.end)?.name ?? null;
}

function splitArguments(value, masked) {
  const result = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = masked[index];
    if ('([{'.includes(character)) depth += 1;
    else if (')]}'.includes(character)) depth -= 1;
    else if (character === ',' && depth === 0) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(value.slice(start).trim());
  return result;
}

function literal(value) {
  const match = /^"((?:\\.|[^"\\])*)"$/.exec(value.trim());
  if (!match) return null;
  return match[1].replace(/\\(["\\nrt])/g, (_whole, escaped) => ({ n: '\n', r: '\r', t: '\t' }[escaped] ?? escaped));
}

function callKind(name) {
  if (name.includes('Modify')) return { direction: 'write', operation: 'modify' };
  if (name.includes('Set')) return { direction: 'write', operation: 'set' };
  return { direction: 'read', operation: 'get' };
}

// This is intentionally a bounded lexical index, not a Galaxy evaluator. Exact
// literals become field evidence; dynamic arguments remain explicit unknown
// accesses and are never guessed from variable names.
export function indexGalaxyCatalogAccesses(files) {
  const accesses = [];
  for (const file of files) {
    const original = String(file.contents ?? '');
    const masked = maskNonCode(original);
    const ranges = functionRanges(masked);
    for (const match of masked.matchAll(CALL_PATTERN)) {
      let open = match.index + match[0].length;
      while (/\s/.test(masked[open] ?? '')) open += 1;
      if (masked[open] !== '(') continue;
      const close = matchingDelimiter(masked, open);
      if (close < 0) continue;
      const argumentText = original.slice(open + 1, close);
      const args = splitArguments(argumentText, masked.slice(open + 1, close));
      const catalog = CATALOG_TYPES.get(args[0]) ?? null;
      const objectId = literal(args[1] ?? '');
      const path = literal(args[2] ?? '');
      accesses.push({
        catalog, objectId, path, ...callKind(match[1]),
        exact: Boolean(catalog && objectId && path),
        arguments: { catalog: args[0] ?? null, objectId: args[1] ?? null, path: args[2] ?? null },
        function: functionAt(ranges, match.index),
        sourceFile: file.source_file ?? file.sourceFile ?? null,
        sourceSha256: file.sha256 ?? null,
        line: lineAt(original, match.index),
      });
    }
  }
  return accesses;
}

export function fieldAccesses(accesses, catalog, objectId, path) {
  const normalized = value => String(value).replaceAll('.@', '.');
  return accesses.filter(entry => entry.exact && entry.catalog === catalog && entry.objectId === objectId
    && normalized(entry.path) === normalized(path));
}
