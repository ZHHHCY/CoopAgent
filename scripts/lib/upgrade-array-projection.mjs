// Upgrade EffectArray is a positional array. Resolve its layout before flattening
// paths: unindexed entries append after inherited slots; explicit indices patch
// those slots. Keep direct overrides separate so provenance/inheritance survives.
export function normalizeUpgradeArrays({ objects, definitions, children, merge, flatten }) {
  const layouts = new Map();
  const sources = new Map();
  function resolve(id, visiting = new Set()) {
    if (layouts.has(id)) return layouts.get(id);
    const object = objects.get(id);
    if (!object) return 0;
    if (visiting.has(id)) throw new Error(`Upgrade array inheritance cycle: ${[...visiting, id].join(' -> ')}`);
    const next = new Set(visiting).add(id);
    const parent = object.getAttribute('parent');
    const defaultId = `@default:${object.tagName}`;
    let length = parent && objects.has(parent) ? resolve(parent, next)
      : id !== defaultId && objects.has(defaultId) ? resolve(defaultId, next) : 0;
    const direct = new Map();
    const fieldSources = new Map();
    for (const { element, sourceFile } of definitions.get(id) ?? []) {
      for (const incoming of children(element).filter(node => node.tagName === 'EffectArray')) {
        const indexText = incoming.hasAttribute('index') ? incoming.getAttribute('index') : String(length);
        if (!/^\d+$/.test(indexText) || !Number.isSafeInteger(Number(indexText))) {
          throw new Error(`Invalid Upgrade EffectArray index: ${id}/${indexText}`);
        }
        const index = Number(indexText);
        length = Math.max(length, index + 1);
        const node = incoming.cloneNode(true);
        node.setAttribute('index', String(index));
        const prefix = `EffectArray[${index}]`;
        // Tombstones must remain in the authoring XML. Removing the DOM node
        // would resurrect an inherited item and shift later appended entries.
        if (node.getAttribute('removed') === '1' || direct.get(index)?.getAttribute('removed') === '1') {
          direct.set(index, node);
          for (const key of fieldSources.keys()) if (key === prefix || key.startsWith(prefix + '.')) fieldSources.delete(key);
        } else if (direct.has(index)) merge(direct.get(index), node);
        else direct.set(index, node);
        const wrapper = element.cloneNode(false);
        wrapper.appendChild(node.cloneNode(true));
        for (const field of flatten(wrapper).fields.values()) {
          if (field.path === prefix || field.path.startsWith(prefix + '.')) fieldSources.set(field.path, sourceFile);
        }
      }
    }
    for (const node of children(object).filter(node => node.tagName === 'EffectArray')) object.removeChild(node);
    for (const [, node] of [...direct].sort(([a], [b]) => a - b)) object.appendChild(node);
    sources.set(id, fieldSources);
    layouts.set(id, length);
    return length;
  }
  for (const id of objects.keys()) resolve(id);
  return sources;
}
