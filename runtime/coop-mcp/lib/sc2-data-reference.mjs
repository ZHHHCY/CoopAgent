const valueCache = new WeakMap();
const objectFieldCache = new WeakMap();
const upgradeEffectCache = new WeakMap();

function databaseCache(cache, database) {
  let values = cache.get(database);
  if (!values) {
    values = new Map();
    cache.set(database, values);
  }
  return values;
}

function normalizeFieldPath(fieldPath) {
  return fieldPath
    .trim()
    .replaceAll("@", "")
    .replace(/\[#(\d+)\]/g, "[$1]")
    .toLowerCase();
}

function normalizeReference(catalog, objectId, fieldPath) {
  return `${catalog.trim().toLowerCase()},${objectId.trim().toLowerCase()},${normalizeFieldPath(fieldPath)}`;
}

function fieldPathCandidates(fieldPath) {
  const candidates = new Set([fieldPath.trim()]);
  for (const candidate of [...candidates]) {
    candidates.add(candidate.replace(/\[(\d+)\]/g, "[#$1]"));
    candidates.add(candidate.replace(/\[#(\d+)\]/g, "[$1]"));
  }
  for (const candidate of [...candidates]) {
    const lastDot = candidate.lastIndexOf(".");
    const prefix = lastDot < 0 ? "" : candidate.slice(0, lastDot + 1);
    const field = candidate.slice(lastDot + 1);
    if (field.startsWith("@")) {
      candidates.add(`${prefix}${field.slice(1)}`);
    } else {
      candidates.add(`${prefix}@${field}`);
    }
  }
  for (const candidate of [...candidates]) {
    candidates.add(candidate.replace(/\[0\]/g, ""));
    candidates.add(candidate.replace(/\[#0\]/g, ""));
    if (/\.Value$/i.test(candidate)) candidates.add(candidate.replace(/\.Value$/i, ""));
  }
  const vitalNames = ["Life", "Shields", "Energy"];
  const attributeNames = [
    "Light",
    "Armored",
    "Biological",
    "Mechanical",
    "Robotic",
    "Psionic",
    "Massive",
    "Structure",
    "Hover",
    "Heroic",
    "Summoned",
  ];
  for (const candidate of [...candidates]) {
    candidates.add(candidate.replace(
      /(Vital(?:Array|RegenArray|DamageTakenArray)?|Vital)\[(?:#)?([012])\]/gi,
      (_match, prefix, index) => `${prefix}[${vitalNames[Number(index)]}]`,
    ));
    candidates.add(candidate.replace(
      /AttributeBonus\[(?:#)?(\d+)\]/gi,
      (match, index) => attributeNames[Number(index)]
        ? `AttributeBonus[${attributeNames[Number(index)]}]`
        : match,
    ));
    for (let index = 0; index < vitalNames.length; index += 1) {
      const suffix = vitalNames[index];
      candidates.add(candidate
        .replace(new RegExp(`VitalMax\\[(?:#)?${index}\\]`, "gi"), `${suffix}Max`)
        .replace(new RegExp(`VitalStart\\[(?:#)?${index}\\]`, "gi"), `${suffix}Start`)
        .replace(new RegExp(`VitalRegenRate\\[(?:#)?${index}\\]`, "gi"), `${suffix}RegenRate`));
    }
  }
  return [...candidates];
}

function objectNumericFields(database, catalog, objectId) {
  const cache = databaseCache(objectFieldCache, database);
  const cacheKey = `${catalog}\0${objectId}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const exact = new Map();
  const normalized = new Map();
  // catalog_fields has millions of rows. Keep the primary-key prefix bare so
  // SQLite can seek to this one object before aliases are normalized in JS.
  const rows = database.prepare(`
    SELECT path, value
    FROM catalog_fields
    WHERE catalog=? AND object_id=?
    ORDER BY path
  `).all(catalog, objectId);
  for (const row of rows) {
    const value = Number(row.value);
    if (!Number.isFinite(value)) continue;
    exact.set(row.path.toLowerCase(), value);
    const normalizedPath = normalizeFieldPath(row.path);
    const values = normalized.get(normalizedPath) ?? new Set();
    values.add(value);
    normalized.set(normalizedPath, values);
  }
  const fields = { exact, normalized };
  cache.set(cacheKey, fields);
  return fields;
}

function numericCatalogField(database, catalog, objectId, fieldPath) {
  const cache = databaseCache(valueCache, database);
  const cacheKey = normalizeReference(catalog, objectId, fieldPath);
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const fields = objectNumericFields(database, catalog, objectId);
  let result = null;
  for (const candidate of fieldPathCandidates(fieldPath)) {
    if (fields.exact.has(candidate.toLowerCase())) {
      result = fields.exact.get(candidate.toLowerCase());
      break;
    }
  }

  if (result === null) {
    const values = fields.normalized.get(normalizeFieldPath(fieldPath));
    if (values?.size === 1) result = [...values][0];
  }

  cache.set(cacheKey, result);
  return result;
}

function upgradeEffects(database, upgradeId) {
  const cache = databaseCache(upgradeEffectCache, database);
  if (cache.has(upgradeId)) return cache.get(upgradeId);
  const effects = database.prepare(`
    SELECT path, value
    FROM catalog_fields
    WHERE catalog='Upgrade' AND object_id=?
      AND (lower(path) LIKE 'effectarray%.@reference'
        OR lower(path) LIKE 'effectarray%.reference')
    ORDER BY path
  `).all(upgradeId).map((field) => {
    const basePath = field.path.replace(/\.@?Reference$/i, "");
    const operation = database.prepare(`
      SELECT value
      FROM catalog_fields
      WHERE catalog='Upgrade' AND object_id=?
        AND lower(replace(path, '@', ''))=?
    `).get(upgradeId, `${basePath}.Operation`.toLowerCase())?.value ?? "Add";
    const operand = Number(database.prepare(`
      SELECT value
      FROM catalog_fields
      WHERE catalog='Upgrade' AND object_id=? AND lower(path)=?
    `).get(upgradeId, basePath.toLowerCase())?.value);
    const reference = parseCatalogReference(field.value);
    return reference && Number.isFinite(operand)
      ? {
          reference: normalizeReference(
            reference.catalog,
            reference.objectId,
            reference.fieldPath,
          ),
          operation,
          operand,
        }
      : null;
  }).filter(Boolean);
  cache.set(upgradeId, effects);
  return effects;
}

function applyOperation(current, operation, operand) {
  if (!Number.isFinite(operand)) return null;
  switch (operation.toLowerCase()) {
    case "set": return operand;
    case "add": return current === null ? null : current + operand;
    case "subtract": return current === null ? null : current - operand;
    case "multiply": return current === null ? null : current * operand;
    case "divide": return current === null || operand === 0 ? null : current / operand;
    default: return null;
  }
}

function parseCatalogReference(reference) {
  const firstComma = reference.indexOf(",");
  const secondComma = reference.indexOf(",", firstComma + 1);
  if (firstComma <= 0 || secondComma <= firstComma + 1) return null;
  const catalog = reference.slice(0, firstComma).trim();
  const objectId = reference.slice(firstComma + 1, secondComma).trim();
  const fieldPath = reference.slice(secondComma + 1).trim();
  if (!catalog || !objectId || !fieldPath) return null;
  return { catalog, objectId, fieldPath };
}

function referencedValue(database, reference, upgradeIds) {
  const parsed = parseCatalogReference(reference);
  if (!parsed) return null;
  let value = numericCatalogField(
    database,
    parsed.catalog,
    parsed.objectId,
    parsed.fieldPath,
  );
  const normalized = normalizeReference(parsed.catalog, parsed.objectId, parsed.fieldPath);
  for (const upgradeId of upgradeIds) {
    for (const effect of upgradeEffects(database, upgradeId)) {
      if (effect.reference !== normalized) continue;
      value = applyOperation(value, effect.operation, effect.operand);
      if (value === null) return null;
    }
  }
  return value;
}

function upgradeEffectArrayValue(database, macro) {
  const match = /^\$UpgradeEffectArrayValue:([^:]+):([\s\S]+)\$$/i.exec(macro.trim());
  if (!match) return null;
  const parsed = parseCatalogReference(match[2]);
  if (!parsed) return null;
  const normalized = normalizeReference(parsed.catalog, parsed.objectId, parsed.fieldPath);
  const values = [...new Set(upgradeEffects(database, match[1])
    .filter((effect) => effect.reference === normalized)
    .map((effect) => effect.operand)
    .filter(Number.isFinite))];
  return values.length === 1 ? values[0] : null;
}

class ExpressionParser {
  constructor(database, expression, upgradeIds) {
    this.database = database;
    this.expression = expression;
    this.upgradeIds = upgradeIds;
    this.offset = 0;
    this.nodes = 0;
    this.depth = 0;
  }

  parse() {
    if (this.expression.length > 2048) return null;
    const value = this.parseExpression();
    this.skipWhitespace();
    return this.offset === this.expression.length && Number.isFinite(value) ? value : null;
  }

  parseExpression() {
    let value = this.parseUnary();
    if (value === null) return null;
    while (true) {
      this.skipWhitespace();
      const operator = this.expression[this.offset];
      if (!["+", "-", "*", "/"].includes(operator)) return value;
      this.offset += 1;
      const right = this.parseUnary();
      if (right === null || operator === "/" && right === 0) return null;
      if (operator === "+") value += right;
      if (operator === "-") value -= right;
      if (operator === "*") value *= right;
      if (operator === "/") value /= right;
    }
  }

  parseUnary() {
    this.skipWhitespace();
    const operator = this.expression[this.offset];
    if (operator === "+" || operator === "-") {
      this.offset += 1;
      const value = this.parseUnary();
      return value === null ? null : operator === "-" ? -value : value;
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    this.skipWhitespace();
    this.nodes += 1;
    if (this.nodes > 256) return null;
    if (this.expression[this.offset] === "(") {
      this.depth += 1;
      if (this.depth > 32) return null;
      this.offset += 1;
      const value = this.parseExpression();
      this.skipWhitespace();
      if (this.expression[this.offset] !== ")") return null;
      this.offset += 1;
      this.depth -= 1;
      return value;
    }

    const numberMatch = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(
      this.expression.slice(this.offset),
    );
    if (numberMatch) {
      this.offset += numberMatch[0].length;
      return Number(numberMatch[0]);
    }

    if (this.expression[this.offset] === "$") {
      const end = this.expression.indexOf("$", this.offset + 1);
      if (end < 0) return null;
      const macro = this.expression.slice(this.offset, end + 1);
      this.offset = end + 1;
      return upgradeEffectArrayValue(this.database, macro);
    }

    const start = this.offset;
    let commaCount = 0;
    let bracketDepth = 0;
    while (this.offset < this.expression.length) {
      const character = this.expression[this.offset];
      if (character === "[") bracketDepth += 1;
      if (character === "]") bracketDepth = Math.max(0, bracketDepth - 1);
      if (bracketDepth === 0) {
        if (character === ",") commaCount += 1;
        if (commaCount >= 2 && /[\s()+\-*/]/.test(character)) break;
      }
      this.offset += 1;
    }
    const reference = this.expression.slice(start, this.offset).trim();
    if (commaCount < 2) return null;
    return referencedValue(this.database, reference, this.upgradeIds);
  }

  skipWhitespace() {
    while (/\s/.test(this.expression[this.offset] ?? "")) this.offset += 1;
  }
}

export function evaluateSc2DataExpression(database, expression, options = {}) {
  if (!expression) return null;
  const upgradeIds = [...new Set(options.upgradeIds ?? [])].filter(Boolean);
  return new ExpressionParser(database, expression, upgradeIds).parse();
}

function decodeAttribute(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function readAttribute(attributes, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i");
  const match = pattern.exec(attributes);
  return match ? decodeAttribute(match[2]) : null;
}

function formatValue(value, precision) {
  if (!Number.isFinite(value)) return null;
  const rounded = Object.is(value, -0) ? 0 : value;
  if (precision !== null && /^\d+$/.test(precision)) {
    const digits = Math.min(10, Number(precision));
    return rounded.toFixed(digits);
  }
  return String(Number(rounded.toFixed(6)));
}

/**
 * Resolve the numeric <d ref="..."/> expressions embedded in localized SC2 text.
 * Unsupported or missing references stay visible as “未知数值” instead of
 * silently turning a sentence into “造成点伤害”.
 */
export function resolveSc2DataReferences(database, text, options = {}) {
  if (!text) return text ?? "";
  const upgradeIds = [...new Set(options.upgradeIds ?? [])].filter(Boolean);
  return text.replace(/<d\b([^>]*)\/?\s*>/gi, (_tag, attributes) => {
    let expression = readAttribute(attributes, "ref");
    if (!expression) {
      const time = readAttribute(attributes, "time");
      const nestedReference = /^\[d\s+ref=(["'])([\s\S]+)\1\s*\/\]$/i.exec(time ?? "");
      expression = nestedReference?.[2] ?? time;
    }
    if (!expression) return "未知数值";
    const value = evaluateSc2DataExpression(database, expression, { upgradeIds });
    return formatValue(value, readAttribute(attributes, "precision")) ?? "未知数值";
  }).replace(/<\/d\s*>/gi, "");
}
