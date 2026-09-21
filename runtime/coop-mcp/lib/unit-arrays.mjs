// Shared ordinal/explicit Unit array projection for official and current data.
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const scalarValue = (value) => /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) ? Number(value) : value === "true" ? true : value === "false" ? false : value;

const UNIT_ARRAY_PROPERTIES = new Set([
  "AbilCmd",
  "Column",
  "Face",
  "Link",
  "Requirements",
  "Row",
  "Type",
  "value",
]);

function createArraySlot(index, origin) {
  return {
    index,
    origin,
    patchable: origin === "explicit",
    attributes: {},
    sourcePaths: [],
  };
}

function assignArraySlotField(slot, property, field) {
  if (!UNIT_ARRAY_PROPERTIES.has(property)) return;
  slot.attributes[property] = scalarValue(field.value);
  if (!slot.sourcePaths.includes(field.path)) slot.sourcePaths.push(field.path);
}

function finishArrayProjection(pathValue, slots) {
  const ordered = [...slots.values()]
    .sort((left, right) => left.index - right.index)
    .map((slot) => ({
      ...slot,
      sourcePaths: [...slot.sourcePaths].sort((left, right) => left.localeCompare(right)),
    }));
  const highest = ordered.length > 0 ? ordered.at(-1).index : -1;
  return {
    collectionPath: pathValue,
    occupiedCount: ordered.length,
    nextFreeIndex: highest + 1,
    slots: ordered,
  };
}

function projectSimpleUnitArray(fields, collectionName, propertyName) {
  const implicit = new Map();
  const explicit = new Map();
  const pattern = new RegExp(
    `^${escapeRegex(collectionName)}(?:\\[(#?)(\\d+)\\])?\\.(?:@)?${escapeRegex(propertyName)}$`,
    "i",
  );
  for (const field of fields) {
    const match = pattern.exec(field.path);
    if (!match) continue;
    const ordinal = match[2] === undefined ? 0 : Number(match[2]);
    const target = match[1] === "#" || match[2] === undefined ? implicit : explicit;
    const slot = target.get(ordinal) ?? createArraySlot(
      ordinal,
      target === implicit ? "implicit" : "explicit",
    );
    assignArraySlotField(slot, propertyName, field);
    target.set(ordinal, slot);
  }
  const slots = new Map(implicit);
  for (const [index, override] of explicit) {
    const prior = slots.get(index);
    if (!prior) {
      slots.set(index, override);
      continue;
    }
    slots.set(index, {
      ...prior,
      origin: "implicit-with-explicit-override",
      patchable: true,
      attributes: { ...prior.attributes, ...override.attributes },
      sourcePaths: [...prior.sourcePaths, ...override.sourcePaths],
    });
  }
  return finishArrayProjection(collectionName, slots);
}

function projectUnitCommandCards(fields) {
  const pattern = /^CardLayouts(?:\[(#?)(\d+)\])?\.LayoutButtons(?:\[(#?)(\d+)\])?\.(?:@)?(AbilCmd|Face|Type|Requirements|Row|Column)$/i;
  const fragments = new Map();
  for (const field of fields) {
    const match = pattern.exec(field.path);
    if (!match) continue;
    const cardIndex = match[2] === undefined ? 0 : Number(match[2]);
    const outerKind = match[1] === "#" || match[2] === undefined ? "implicit" : "explicit";
    const fragmentKey = `${cardIndex}:${outerKind}`;
    const fragment = fragments.get(fragmentKey) ?? {
      cardIndex,
      outerKind,
      implicit: new Map(),
      explicit: new Map(),
    };
    const buttonIndex = match[4] === undefined ? 0 : Number(match[4]);
    const target = match[3] === "#" || match[4] === undefined
      ? fragment.implicit
      : fragment.explicit;
    const slot = target.get(buttonIndex) ?? createArraySlot(
      buttonIndex,
      target === fragment.implicit ? "implicit" : "explicit",
    );
    assignArraySlotField(slot, match[5], field);
    target.set(buttonIndex, slot);
    fragments.set(fragmentKey, fragment);
  }

  const cards = [];
  const cardIndexes = [...new Set([...fragments.values()].map((fragment) => fragment.cardIndex))]
    .sort((left, right) => left - right);
  for (const cardIndex of cardIndexes) {
    const slots = new Map();
    let nextImplicit = 0;
    for (const outerKind of ["implicit", "explicit"]) {
      const fragment = fragments.get(`${cardIndex}:${outerKind}`);
      if (!fragment) continue;
      for (const [, item] of [...fragment.implicit.entries()].sort(([left], [right]) => left - right)) {
        const slot = {
          ...item,
          index: nextImplicit,
          origin: "implicit",
          patchable: false,
        };
        slots.set(nextImplicit, slot);
        nextImplicit += 1;
      }
      for (const [index, override] of fragment.explicit) {
        const prior = slots.get(index);
        slots.set(index, prior ? {
          ...prior,
          origin: "implicit-with-explicit-override",
          patchable: true,
          attributes: { ...prior.attributes, ...override.attributes },
          sourcePaths: [...prior.sourcePaths, ...override.sourcePaths],
        } : override);
        nextImplicit = Math.max(nextImplicit, index + 1);
      }
    }
    cards.push({
      cardIndex,
      ...finishArrayProjection(`CardLayouts[${cardIndex}].LayoutButtons`, slots),
    });
  }
  return cards;
}

export function projectUnitArrayFields(fields) {
  return { abilities: projectSimpleUnitArray(fields, "AbilArray", "Link"), commandCards: projectUnitCommandCards(fields),
    semantics: { numericSlotsRequired: true, ordinalPathsPatchable: false,
      note: "Use nextFreeIndex for catalog.insert; linked IDs belong in Link or AbilCmd, never in index." } };
}

export function normalizeUnitArrayFields(fields) {
  const result = new Map(fields);
  const projection = projectUnitArrayFields([...fields.values()].sort((a,b) => a.path.localeCompare(b.path)));
  for (const collection of [projection.abilities, ...projection.commandCards]) {
    for (const slot of collection.slots) {
      const originals = slot.sourcePaths.map((p) => fields.get(p));
      for (const field of originals) result.delete(field.path);
      for (const [property, value] of Object.entries(slot.attributes)) {
        const source = originals.filter((f) => f.path.endsWith("." + property) || f.path.endsWith(".@" + property)).at(-1);
        const fieldPath = collection.collectionPath + "[" + slot.index + "].@" + property;
        result.set(fieldPath, { ...source, path: fieldPath, value: String(value) });
      }
    }
  }
  return result;
}
