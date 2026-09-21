// Narrow B97579 adapter, verified by native UserData reads in experiment
// 8fd288b1-0b2a-4fc6-abca-6033d7f68fe1. The index AND identity are preconditions.
const children = (node, tag) => Array.from(node?.childNodes ?? []).filter(n => n.nodeType === 1 && n.tagName === tag);
export function masteryPointSelector(path) {
  const m = /^Instances\[(0|[1-9]\d*):([A-Za-z][A-Za-z0-9_]*)\]\.Fixed\[0:PointIncrement\]\.@Fixed$/.exec(path);
  return m ? { index: Number(m[1]), instanceId: m[2], physicalPath: `Instances[${m[1]}].Fixed[0].@Fixed` } : null;
}
export function masteryPointPath(index, instanceId) {
  return `Instances[${index}:${instanceId}].Fixed[0:PointIncrement].@Fixed`;
}
export function inspectMasteryPoint(base, core, path) {
  const selector = masteryPointSelector(path);
  if (!selector) return null;
  const fail = message => ({exists: false, value: null, source: 'unknown', writeSupport: {supported: false, reason: 'mastery-identity-mismatch', message}});
  if (base?.tagName !== 'CUser' || base.getAttribute('id') !== 'MasteryUpgrades' || base.hasAttribute('parent')) return fail('Mastery PointIncrement requires a direct MasteryUpgrades baseline.');
  const instances = children(base, 'Instances');
  if (instances.some(n => n.hasAttribute('index'))) return fail('Indexed baseline User instances require separate layout validation.');
  const instance = instances[selector.index];
  if (!instance || instance.getAttribute('Id') !== selector.instanceId || instances.filter(n => n.getAttribute('Id') === selector.instanceId).length !== 1) return fail('Mastery instance position and Id do not match the fixed baseline. Refresh the mastery query.');
  const validFixed = node => {
    const fixed = children(node, 'Fixed'), fields = children(fixed[0], 'Field');
    return fixed.length === 1 && (!fixed[0].hasAttribute('index') || fixed[0].getAttribute('index') === '0')
      && fields.length === 1 && fields[0].getAttribute('Id') === 'PointIncrement'
      && (!fields[0].hasAttribute('Index') || fields[0].getAttribute('Index') === '0')
      && fixed[0].hasAttribute('Fixed') && !fixed[0].hasAttribute('removed') ? fixed[0] : null;
  };
  const baseline = validFixed(instance);
  if (!baseline) return fail('Only a single PointIncrement Fixed field at index 0 has verified sparse-write semantics.');
  if (core && (core.tagName !== 'CUser' || core.getAttribute('id') !== 'MasteryUpgrades' || core.hasAttribute('parent') || core.hasAttribute('removed'))) return fail('Mastery core object identity/inheritance is not supported.');
  const locals = children(core, 'Instances').filter(n => n.getAttribute('index') === String(selector.index) || n.getAttribute('Id') === selector.instanceId);
  if (locals.length > 1 || locals.some(n => n.getAttribute('index') !== String(selector.index) || n.getAttribute('Id') !== selector.instanceId || n.hasAttribute('removed'))) return fail('Existing User override does not preserve this instance position and Id.');
  const local = locals[0] ? validFixed(locals[0]) : null;
  if (locals[0] && !local) return fail('Existing mastery instance override has an unverified Fixed layout.');
  const owners=children(instance,'User').filter(n=>n.getAttribute('Type')==='PlayerCommanders'&&children(n,'Field').some(f=>f.getAttribute('Id')==='Commander'));
  return {exists: true, value: (local ?? baseline).getAttribute('Fixed'), source: local ? 'core' : 'official', writeSupport: {supported: true, reason: null}, selector,
    ownerCommanderId: owners.length===1 ? owners[0].getAttribute('Instance') : null};
}
export function writeMasteryPoint(document, object, selector, value) {
  let instance = children(object, 'Instances').find(n => n.getAttribute('index') === String(selector.index));
  if (!instance) { instance = document.createElement('Instances'); instance.setAttribute('index', String(selector.index)); instance.setAttribute('Id', selector.instanceId); object.appendChild(instance); }
  let fixed = children(instance, 'Fixed')[0];
  if (!fixed) { fixed = document.createElement('Fixed'); fixed.setAttribute('index', '0'); const field = document.createElement('Field'); field.setAttribute('Id', 'PointIncrement'); fixed.appendChild(field); instance.appendChild(fixed); }
  fixed.setAttribute('Fixed', String(value));
}
