import { canonicalEditPath } from './catalog-edit-contract.mjs';

// Rules ship; observed field inventories and all game values stay in the local DB.
export const FIELD_VOCABULARY_VERSION = 3;
export const fieldTemplate = path => String(path).replaceAll('.@', '.').replace(/\[[^\]]*\]/g, '[]');
const scalar = (label, unit = null, note = null) => ({ kind: 'scalar', label, dataType: 'number', ...(unit ? { unit } : {}), ...(note ? { note } : {}) });
const reference = (label, targetCatalog, role, purpose) => ({ kind: 'reference', label, dataType: 'catalog-id', targetCatalog, role, purpose });
const rules = [];
const add = (catalog, pattern, meaning, cls = null) => rules.push({ catalog, pattern, meaning, cls });
const fields = (catalog, entries) => { for (const [path, meaning] of Object.entries(entries)) add(catalog, new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), meaning); };
fields('Unit', {
  LifeMax: scalar('生命上限', '生命点'), LifeStart: scalar('初始生命', '生命点', '修改上限时需核对初始值；不是自动同步关系。'),
  LifeArmor: scalar('生命护甲'), LifeRegenRate: scalar('生命恢复速率', null, 'Catalog 基础速率，不包含全部 Buff。'),
  ShieldsMax: scalar('护盾上限', '护盾点'), ShieldsStart: scalar('初始护盾', '护盾点'), ShieldArmor: scalar('护盾护甲'),
  ShieldRegenRate: scalar('护盾恢复速率'), EnergyMax: scalar('能量上限'), EnergyStart: scalar('初始能量'), EnergyRegenRate: scalar('能量恢复速率'),
  Speed: scalar('基础移动速度', null, '不是包含全部修正的最终移动速度。'), Acceleration: scalar('移动加速度'),
  Sight: scalar('视野范围', '游戏距离'), Radius: scalar('单位半径', '游戏距离'),
  Food: scalar('人口字段', null, '消耗通常以负数表示；正负方向需按实际字段核对。'),
  'CostResource[]': scalar('单位资源费用字段', '对应资源', '保留资源索引；实际支付价格需核对生产命令，缺失不等于零。'),
  RepairTime: scalar('修理时间参数', '游戏时间'),
});
fields('Weapon', {
  Period: scalar('攻击周期', '游戏时间', '是间隔，不是攻速；不自动等于最终攻击间隔或 DPS。'),
  Range: scalar('攻击射程', '游戏距离'), MinScanRange: scalar('最小扫描范围', '游戏距离'),
  DamagePoint: scalar('攻击伤害点时间', '游戏时间'), Backswing: scalar('攻击后摇', '游戏时间'),
  Effect: reference('武器执行效果', 'Effect', 'execution', '继续查看伤害及执行链；不证明每次攻击的触发总次数。'),
  DisplayEffect: reference('武器展示效果', 'Effect', 'display', '仅供展示，不作为真实伤害执行依据。'),
});
for (const [part, catalog, label] of [['Abil','Abil','挂载能力'],['Weapon','Weapon','挂载武器'],['Behavior','Behavior','挂载行为']])
  add('Unit', new RegExp(`^${part}Array(?:\\[\\])?\\.Link$`), reference(label, catalog, 'attachment', '查看该对象属性与子项；挂载不证明当前已解锁或生效。'));
add('Unit', /^CardLayouts(?:\[\])?\.LayoutButtons(?:\[\])?\.Face$/, reference('命令卡展示按钮','Button','display','查看名称与提示；不是数值实现对象。'));
add('Unit', /^CardLayouts(?:\[\])?\.LayoutButtons(?:\[\])?\.AbilCmd$/, {kind:'reference',label:'命令卡能力命令',dataType:'ability-command',targetCatalog:'Abil',role:'command',purpose:'定位能力及命令；不是可直接当成生产 InfoArray 槽位的编号。'});
add('Unit', /^EffectArray(?:\[\])?$/, reference('单位事件效果','Effect','event-execution','查看出生/死亡等索引对应的事件效果，保留事件键。'));
add('Unit', /^TechTreeProducedUnitArray(?:\[\])?$/, reference('科技树生产展示','Unit','display','展示关联，不是实际生产命令或扣费依据。'));
for (const [pattern,label,unit] of [
  [/^Cost(?:\[\])?\.Vital\[\]$/,'技能生命/护盾/能量消耗','对应属性'],[/^Cost(?:\[\])?\.Resource\[\]$/,'技能资源消耗','对应资源'],
  [/^Cost(?:\[\])?\.Cooldown\.TimeUse$/,'技能基础冷却','游戏时间'],[/^Range(?:\[\])?$/,'施法距离','游戏距离'],
  [/^InfoArray(?:\[\])?\.Time$/,'命令生产/研究时间','游戏时间'],[/^InfoArray(?:\[\])?\.Resource\[\]$/,'命令显式资源费用','对应资源'],
  [/^InfoArray(?:\[\])?\.Charge\.(TimeUse|TimeStart)$/,'命令充能时间','游戏时间'],
  [/^InfoArray(?:\[\])?\.Charge\.(CountMax|CountStart|CountUse)$/,'命令充能数量参数',null],
]) add('Abil',pattern,scalar(label,unit,'保留原命令/资源键；不包含所有研究、威望及脚本修正。'));
add('Abil',/^BaseInfo\.Time$/,scalar('复活基础时间','游戏时间'),/^CAbilRevive$/);
add('Abil',/^BaseInfo\.Resource\[\]$/,scalar('复活基础费用','对应资源'),/^CAbilRevive$/);
add('Abil',/^InfoArray(?:\[\])?\.Unit(?:\[\])?$/,reference('命令目标单位','Unit','command-target','查看实际命令关联的单位；保留命令槽位。'));
add('Abil',/^InfoArray(?:\[\])?\.Upgrade(?:\[\])?$/,reference('研究命令目标升级','Upgrade','research-target','查看升级参数和修改地址；不证明研究已完成。'),/^CAbilResearch$/);
add('Abil',/^InfoArray(?:\[\])?\.Button\.DefaultButtonFace$/,reference('研究命令展示按钮','Button','research-presentation','查看研究说明中的精确动态字段引用；显示文字本身不证明玩法效果。'),/^CAbilResearch$/);
add('Abil',/^(Effect(?:\[\])?|InfoArray(?:\[\])?\.Effect)$/,reference('能力执行效果','Effect','execution','继续查看数值承载对象与执行条件。'));
add('Abil',/^Behavior(?:Array)?(?:\[\])?(?:\.Link)?$/,reference('能力关联行为','Behavior','execution','查看行为数值、持续时间和生效条件。'));
add('Effect',/^Amount$/,scalar('单次伤害效果数值','伤害点','不是整次攻击总伤害，亦未计入护甲、重复触发和加成。'),/^CEffectDamage$/);
add('Effect',/^AttributeBonus\[\]$/,scalar('针对属性的伤害加成','伤害点'),/^CEffectDamage$/);
add('Effect',/^SpawnCount$/,scalar('本次生成效果的数量',null,'不证明整个技能/购买流程的最终生成总数。'),/^CEffectCreateUnit$/);
add('Effect',/^SpawnUnit$/,reference('生成的单位','Unit','spawn-target','查看生成目标；条件和执行次数另行核对。'),/^CEffectCreateUnit$/);
add('Effect',/^PeriodCount$/,scalar('周期执行次数'),/^CEffectCreatePersistent$/);
add('Effect',/^PeriodicPeriodArray(?:\[\])?$/,scalar('周期执行间隔','游戏时间'),/^CEffectCreatePersistent$/);
add('Effect',/^AreaArray(?:\[\])?\.Radius$/,scalar('区域半径','游戏距离','保留区域槽位；不是整个技能的唯一作用范围。'),/^CEffect(Damage|EnumArea)$/);
add('Effect',/^AreaArray(?:\[\])?\.Fraction$/,scalar('区域伤害比例参数',null,'结合区域半径和伤害效果解释；不是伤害点数。'),/^CEffectDamage$/);
add('Effect',/^VitalArray(?:\[\])?\.Change$/,scalar('生命/护盾/能量变化量',null,'由数组索引决定属性；保留正负方向。'),/^CEffectModifyUnit$/);
add('Effect',/^VitalArray(?:\[\])?\.ChangeFraction$/,scalar('生命/护盾/能量变化比例',null,'由数组索引决定属性；不是固定变化点数。'),/^CEffectModifyUnit$/);
add('Effect',/^PeriodCount$/,scalar('治疗效果周期计数',null,'不推断完整治疗总量。'),/^CEffectCreateHealer$/);
add('Effect',/^Amount$/,scalar('施力效果参数',null,'不是伤害数值；方向和最终位移需核对其他字段。'),/^CEffectApplyForce$/);
add('Effect',/^(EffectArray(?:\[\])?|ImpactEffect|LaunchEffect|InitialEffect|FinalEffect|ExpireEffect|PeriodicEffectArray(?:\[\])?|(?:CaseArray|AreaArray)(?:\[\])?\.Effect|CaseDefault)$/,reference('后续执行效果','Effect','execution','继续查看效果字段；分支、周期和命中语义仍由具体类及条件决定。'));
add('Effect',/^Behavior(?:Link)?$/,reference('效果关联行为','Behavior','execution','查看被操作行为；添加/移除方向需要核对效果类。'));
add('Effect',/^Weapon$/,reference('效果关联武器','Weapon','execution','查看武器字段及执行效果。'));
fields('Behavior', {
  Duration:scalar('行为持续时间','游戏时间'), Period:scalar('行为周期','游戏时间'),
  'DamageResponse.ModifyFraction':scalar('受伤响应倍率','倍率','不是直接的减伤百分数；需确认响应条件。'),
  'DamageResponse.ModifyLimit':scalar('受伤响应修改上限'), 'DamageResponse.Chance':scalar('受伤响应概率参数',null,'按引擎字段约定核对尺度。'),
  'Modification.QueueCount':scalar('队列数量修正',null,'需核对行为移除条件，不等于解锁后队列数量。'),
  'Modification.QueueSize':scalar('队列容量修正',null,'需核对行为移除条件，不等于解锁后队列容量。'),
});
for (const [path,label] of Object.entries({
  AttackSpeedMultiplier:'攻击速度倍率',MoveSpeedMultiplier:'移动速度倍率',MoveSpeedBonus:'移动速度加值',
  LifeArmorBonus:'生命护甲加成',
  MoveSpeedMaximum:'移动速度上限修正',TimeScale:'时间尺度修正',
  'DamageDealtFraction[]':'造成伤害比例修正','DamageTakenFraction[]':'承受伤害比例修正',
  'DamageTakenScaled[]':'承受伤害缩放参数','DamageDealtUnscaled[]':'造成伤害非缩放参数',
  'VitalRegenArray[]':'属性恢复量修正','VitalMaxArray[]':'属性上限修正',
  'VitalRegenMultiplier[]':'属性恢复倍率','VitalMaxAdditiveMultiplierArray[]':'属性上限加算倍率',
  'VitalDamageLeechArray[].KindArray[]':'伤害吸取属性参数',
})) add('Behavior',new RegExp(`^Modification\\.${path.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`),
  scalar(label,null,'行为修正参数；保留属性/伤害类型索引，核对激活条件与叠加方式，不视作最终值。'),/^CBehavior(Buff|Attribute)$/);
add('Behavior',/^(InitialEffect|PeriodicEffect|FinalEffect|ExpireEffect|DamageResponse\.Handled)$/,reference('行为执行效果','Effect','execution','按初始、周期、结束或受伤事件查看对应效果。'));
add('Behavior',/^Modification\.WeaponArray(?:\[\])?\.Link$/,reference('行为武器修正目标','Weapon','modifier-target','查看被行为影响的武器及激活条件。'));
add('Upgrade',/^EffectArray(?:\[\])?\.Reference$/, {kind:'reference',label:'升级修改的目标字段',dataType:'catalog-field-address',role:'modifier-target',purpose:'定位实际对象及字段；结合同项 Operation 和 Value 理解修改。'});
add('Upgrade',/^EffectArray(?:\[\])?\.Operation$/, {kind:'operation',label:'升级修改操作',dataType:'enum',note:'必须按真实操作解释；未写出时不能猜默认 Add。'});
add('Upgrade',/^EffectArray(?:\[\])?\.Value$/, {kind:'operand',label:'升级操作参数',dataType:'target-dependent',note:'可以是数字、文本键或其他值；结合 Reference/Operation 判断，不直接视作最终数值。'});
add('ArmyCategory',/^Unit$/,reference('兵种资料关联单位','Unit','presentation-target','转到实际单位目录，资料展示不证明可用性。'));
// Conditions are typed separately from execution edges. Unknown shapes remain unknown.
for (const catalog of ['Unit','Abil','Behavior','Effect','Weapon']) {
  add(catalog,/(?:^|\.)TargetFilters$/, {kind:'filter',label:'目标筛选条件',dataType:'target-filter',role:'condition',note:'保留完整筛选表达式；不是执行效果或数值。'});
  add(catalog,/(?:^|\.)Requirements$/,reference('使用/显示要求','Requirement','condition','继续解释解锁/使用条件，不当作执行效果。'));
  add(catalog,/(?:^|\.)(?:RemoveValidatorArray)(?:\[\])?(?:\.Link)?$/,reference('移除条件','Validator','removal-condition','查看何时移除该对象效果；不是启用条件。'));
  add(catalog,/(?:^|\.)(?:Validator|ValidatorArray|DisableValidatorArray)(?:\[\])?(?:\.Link)?$/,reference('校验条件','Validator','condition','按字段方向核对启用/禁用与分支条件，不证明条件已满足。'));
  add(catalog,/^(?:FlagArray|Flags|InfoFlags|SharedFlags|Attributes|PlaneArray|Collide)\[\]$/, {kind:'flag',label:'具名开关/标志',dataType:'flag',note:'保留索引名解释具体开关，不作为普通数值加成。'});
}
add('*',/^@parent$/, {kind:'inheritance',label:'父对象继承',dataType:'catalog-id',role:'inheritance',note:'不是玩法执行关系；按继承与加载覆盖规则处理。'});
add('*',/^(Name|Tooltip|Description|LifeArmorName|ShieldArmorName)$/, {kind:'localization',label:'本地化文本键',dataType:'text-key',note:'用于显示，不是数值执行字段。'});

export function describeField(catalog, cls, path) {
  const template=fieldTemplate(path);
  const rule=rules.find(r=>(r.catalog===catalog || r.catalog==='*') && (!r.cls || r.cls.test(cls ?? '')) && r.pattern.test(template));
  return {catalog, class:cls, template, status:rule?'documented':'unknown',
    ...(rule?{...rule.meaning,evidence:'authored-generic-field-rule'}:{kind:'unknown',dataType:'unknown',label:'尚未解释的字段',note:'字段已保留；不能根据名字或值的外观猜用途、单位或修改方向。'})};
}

// Shared by cached dossier graphs and live object views: only interpretation,
// never object lookup, activation evaluation or a write decision.
export function referenceTarget(meaning, value, ownerId) {
  if(meaning.kind!=='reference' || typeof value!=='string' || !value)return null;
  value=value.replaceAll('##id##',ownerId);
  if(meaning.dataType==='catalog-id')return {catalog:meaning.targetCatalog,objectId:value};
  const parts=value.split(',');
  if(meaning.dataType==='ability-command' && parts.length===2 && parts.every(Boolean))
    return {catalog:'Abil',objectId:parts[0],command:parts[1]};
  if(meaning.dataType==='catalog-field-address' && parts.length>=3 && parts.every(Boolean))
    return {catalog:parts[0],objectId:parts[1],path:parts.slice(2).join(',')};
  return null;
}

const sourceKey=db=>JSON.stringify(db.prepare('SELECT key,value FROM main.meta ORDER BY key').all().filter(r=>!/^(engine|galaxySymbol)/i.test(r.key)));
export function buildFieldVocabulary(db) {
  db.exec('SAVEPOINT field_vocabulary_build');
  try {
    const result=buildInventory(db);
    db.exec('RELEASE field_vocabulary_build');
    return result;
  } catch(error) {
    db.exec('ROLLBACK TO field_vocabulary_build; RELEASE field_vocabulary_build');
    throw error;
  }
}

function buildInventory(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS coop_field_vocabulary(catalog TEXT,class TEXT,template TEXT,record_json TEXT NOT NULL,PRIMARY KEY(catalog,class,template));
    CREATE TABLE IF NOT EXISTS coop_field_vocabulary_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    DELETE FROM coop_field_vocabulary; DELETE FROM coop_field_vocabulary_meta;`);
  const records=new Map();
  for(const r of db.prepare(`SELECT f.catalog,o.class,f.path,count(*) AS occurrences FROM main.catalog_fields f
    JOIN main.catalog_objects o ON o.catalog=f.catalog AND o.object_id=f.object_id GROUP BY f.catalog,o.class,f.path`).iterate()) {
    const template=fieldTemplate(r.path),k=JSON.stringify([r.catalog,r.class,template]);
    if(!records.has(k)) records.set(k,{...describeField(r.catalog,r.class,r.path),observedOccurrences:0});
    records.get(k).observedOccurrences+=r.occurrences;
  }
  const put=db.prepare('INSERT INTO coop_field_vocabulary VALUES (?,?,?,?)');
  const stats={templates:records.size,documented:0,unknown:0,perCatalog:{}};
  for(const [k,r] of [...records].sort(([a],[b])=>a<b?-1:a>b?1:0)) {
    put.run(r.catalog,r.class,r.template,JSON.stringify(r));stats[r.status]++;
    const c=stats.perCatalog[r.catalog]??={templates:0,documented:0,unknown:0};c.templates++;c[r.status]++;
  }
  const meta=db.prepare('INSERT INTO coop_field_vocabulary_meta VALUES (?,?)');
  meta.run('version',String(FIELD_VOCABULARY_VERSION));meta.run('source',sourceKey(db));meta.run('stats',JSON.stringify(stats));
  return stats;
}

export function fieldVocabularyStatus(db) {
  if(!db.prepare("SELECT 1 FROM main.sqlite_master WHERE name='coop_field_vocabulary_meta'").get()) return {status:'missing',expectedVersion:FIELD_VOCABULARY_VERSION};
  const meta=Object.fromEntries(db.prepare('SELECT key,value FROM main.coop_field_vocabulary_meta').all().map(r=>[r.key,r.value]));
  return {status:Number(meta.version)===FIELD_VOCABULARY_VERSION && meta.source===sourceKey(db)?'ready':'stale',version:Number(meta.version),expectedVersion:FIELD_VOCABULARY_VERSION};
}

export function readFieldVocabulary(db,{catalog,cls,offset=0,limit=30}={}) {
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100) throw Error('Invalid field vocabulary pagination.');
  const status=fieldVocabularyStatus(db);if(status.status!=='ready')return status;
  const where='WHERE (? IS NULL OR catalog=?) AND (? IS NULL OR class=?)',args=[catalog??null,catalog??null,cls??null,cls??null];
  const total=db.prepare(`SELECT count(*) n FROM main.coop_field_vocabulary ${where}`).get(...args).n;
  return {...status,total,offset,nextOffset:offset+limit<total?offset+limit:null,entries:db.prepare(`SELECT record_json FROM main.coop_field_vocabulary ${where} ORDER BY catalog,class,template LIMIT ? OFFSET ?`).all(...args,limit,offset).map(r=>JSON.parse(r.record_json))};
}

// One source-only field reader. Parameter views scan cheap rows once and only
// resolve references for the page they actually return. No global live cache.
export function createObjectFieldReader(db,input) {
  const status=fieldVocabularyStatus(db);
  const header={...status,basis:'official-catalog',currentProjectIncluded:false,runtimeEvaluated:false};
  if(status.status!=='ready')return {...header,action:'Rebuild the local semantic index.'};
  const obj=db.prepare('SELECT class FROM main.catalog_objects WHERE catalog=? AND object_id=?').get(input.catalog,input.objectId);
  if(!obj)return {...header,status:'not-indexed'};
  const context={...(input.commanderId?{commanderId:input.commanderId}:{}),...(input.prestigeUpgrade?{prestigeUpgrade:input.prestigeUpgrade}:{})};
  const root={operation:'entity.get',...context,catalog:input.catalog,objectId:input.objectId};
  let scope='';const args=[input.catalog,input.objectId];
  if(input.commandIndex!==undefined) {
    if(input.catalog!=='Abil' || !/^[A-Za-z0-9_]+$/.test(input.commandIndex))throw Error('commandIndex requires an exact Abil command slot.');
    const prefix=`InfoArray[${input.commandIndex}].`;
    if(!db.prepare('SELECT 1 FROM main.catalog_fields WHERE catalog=? AND object_id=? AND substr(path,1,length(?))=? LIMIT 1')
      .get(input.catalog,input.objectId,prefix,prefix))throw Error('Unknown production/research commandIndex for this Abil.');
    scope=" AND (f.path NOT LIKE 'InfoArray[%' OR substr(f.path,1,length(?))=? OR f.path=?)";
    args.push(prefix,prefix,`InfoArray[${input.commandIndex}]`);
    root.commandIndex=input.commandIndex;
  }
  const where=`f.catalog=? AND f.object_id=?${scope} AND NOT (instr(f.path,'[#')>0 AND EXISTS
    (SELECT 1 FROM main.catalog_fields o WHERE o.catalog=f.catalog AND o.object_id=f.object_id AND o.path=replace(f.path,'[#','[')))`;
  const total=db.prepare(`SELECT count(*) n FROM main.catalog_fields f WHERE ${where}`).get(...args).n;
  const lookup=db.prepare('SELECT class FROM main.catalog_objects WHERE catalog=? AND object_id=?');
  const targetPaths=db.prepare('SELECT path FROM main.catalog_fields WHERE catalog=? AND object_id=?');
  const hasText=Boolean(db.prepare("SELECT 1 FROM main.sqlite_master WHERE name='localized_text'").get());
  const text=hasText?db.prepare("SELECT value FROM main.localized_text WHERE text_key=? AND lower(locale) IN ('zhcn','enus') ORDER BY CASE lower(locale) WHEN 'zhcn' THEN 0 ELSE 1 END LIMIT 1"):null;
  const name=(catalog,id)=>{
    const f=db.prepare("SELECT value FROM main.catalog_fields WHERE catalog=? AND object_id=? AND path='Name'").get(catalog,id);
    const key=(f?.value??`${catalog}/Name/${id}`).replaceAll('##id##',id);
    return text?.get(key)?.value?.split(/\s*\/\/\/\s*/)[0]??id;
  };
  const normalizedPath=path=>String(path).replaceAll('.@','.').replaceAll('[#','[');
  const withoutZeroIndices=path=>normalizedPath(path).replaceAll('[0]','');
  const resolveTargetPath=(target,found)=>{
    if(!found || !target.path)return null;
    const paths=targetPaths.all(target.catalog,target.objectId);
    let candidates=paths.filter(f=>normalizedPath(f.path)===normalizedPath(target.path));
    if(candidates.length===0) candidates=paths.filter(f=>withoutZeroIndices(f.path)===withoutZeroIndices(target.path));
    return candidates.length===1?canonicalEditPath(found.class,candidates[0].path):null;
  };
  const dynamicReference=raw=>{
    const parts=raw.split(',');
    if(parts.length<3 || parts.some(part=>!part))return {sourceRef:raw,status:'unresolved-reference-shape'};
    const target={catalog:parts[0],objectId:parts[1],path:parts.slice(2).join(',')};
    const found=lookup.get(target.catalog,target.objectId),targetPath=resolveTargetPath(target,found);
    return {sourceRef:raw,target:{...target,name:name(target.catalog,target.objectId),exists:Boolean(found),fieldResolved:Boolean(targetPath),
      ...(found?{nextQuery:{operation:'entity.get',...context,catalog:target.catalog,objectId:target.objectId,
        ...(targetPath?{path:targetPath}:{topic:'fields'})}}:{})}};
  };
  const presentationFor=(catalog,objectId)=>db.prepare("SELECT path,value,source_file FROM main.catalog_fields WHERE catalog=? AND object_id=? AND path IN ('Tooltip','Description')")
    .all(catalog,objectId).flatMap(f=>{
      const key=f.value?.replaceAll('##id##',objectId),value=key?text?.get(key)?.value:null;
      if(!value)return [];
      const dynamicReferences=[...value.matchAll(/<d\b[^>]*\bref=(['"])([^'"]+)\1/gi)].slice(0,16).map(match=>dynamicReference(match[2]));
      return [{field:f.path,textKey:key,text:value.slice(0,1200),truncated:value.length>1200,
        basis:'localized-display-text',sourceFile:f.source_file,
        ...(dynamicReferences.length?{dynamicReferences}:{}),
        note:'展示说明；动态字段引用仅用于定位候选，仍需读取当前值并核对行为条件，文字本身不证明实际效果。'}];
    });
  const presentation=presentationFor(input.catalog,input.objectId);
  const read=(offset,limit)=>db.prepare(`SELECT path,value,source_file,origin_object_id,inheritance_depth FROM main.catalog_fields f WHERE ${where} ORDER BY path LIMIT ? OFFSET ?`).all(...args,limit,offset);
  // Context belongs to the same field reader in both fields and parameter
  // cards. A raw operand is not an evaluated, level-composed gameplay value.
  const related=db.prepare("SELECT path,value,source_file,origin_object_id,inheritance_depth FROM main.catalog_fields WHERE catalog=? AND object_id=? AND replace(replace(path,'.@','.'),'[#','[')=? ORDER BY CASE WHEN instr(path,'[#')=0 THEN 0 ELSE 1 END,path LIMIT 1");
  const sourceOf=f=>({file:f.source_file,originObjectId:f.origin_object_id,inheritanceDepth:f.inheritance_depth});
  const level=input.catalog==='Upgrade'?related.get(input.catalog,input.objectId,'MaxLevel'):null;
  const upgradeContext=input.catalog==='Upgrade'?{
    valueMeaning:'operation-operand-not-final-gameplay-value',
    maxLevel:level?{path:level.path,baselineValue:level.value,source:sourceOf(level),nextQuery:{...root,path:level.path}}:null,
    currentLevel:null,applicationCount:null,composedValue:null,runtimeEvaluated:false,
    conclusionBoundary:'Value 是升级操作参数，MaxLevel 只是等级上限。当前等级、每级应用次数与脚本驱动未求值；多条相同 Value 不证明最终加成固定，也不证明不按数量叠加。可按请求修改参数，但不能据此改写用户的机制描述。',
  }:null;
  const decorate=f=>{
    const meaning=describeField(input.catalog,obj.class,f.path),path=canonicalEditPath(obj.class,f.path);
    const {commandIndex:_command,...exactRoot}=root;
    const entry={path,sourcePath:f.path,value:f.value,meaning,indices:[...f.path.matchAll(/\[([^\]]*)\]/g)].map(m=>m[1]),
      source:{file:f.source_file,originObjectId:f.origin_object_id,inheritanceDepth:f.inheritance_depth},nextQuery:{...exactRoot,path}};
    if(meaning.kind==='operand'){
      const stem=f.path.replaceAll('.@','.').replaceAll('[#','[').replace(/\.Value$/,'');
      const reference=related.get(input.catalog,input.objectId,stem+'.Reference');
      const operation=related.get(input.catalog,input.objectId,stem+'.Operation');
      entry.modifierContext={reference:reference?.value??null,operation:operation?.value??null,
        ...(upgradeContext?{levelContext:'objectCard.upgradeContext'}:{})};
    }
    if(meaning.kind==='reference') {
      const target=referenceTarget(meaning,f.value,input.objectId);
      if(target) {
        const found=lookup.get(target.catalog,target.objectId);
        const targetPath=resolveTargetPath(target,found);
        const targetPresentation=meaning.role==='research-presentation' && found
          ? presentationFor(target.catalog,target.objectId) : [];
        entry.target={...target,name:name(target.catalog,target.objectId),exists:Boolean(found),...(target.path?{fieldResolved:Boolean(found && targetPath)}:{}),
          ...(targetPresentation.length?{presentation:targetPresentation}:{}),
          ...(found?{nextQuery:{operation:'entity.get',...context,catalog:target.catalog,objectId:target.objectId,
            ...(target.path && targetPath?{path:targetPath}:target.path?{topic:'fields'}:{})}}:{})};
      } else entry.referenceStatus='unresolved-reference-shape';
    }
    return entry;
  };
  return {...header,entity:{catalog:input.catalog,objectId:input.objectId,class:obj.class,name:name(input.catalog,input.objectId)},
    ...(presentation.length?{presentation}:{}),...(upgradeContext?{upgradeContext}:{}),total,root,read,decorate};
}

export function readObjectFieldGuide(db,input) {
  const offset=input.offset??0,limit=input.limit??30;
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw Error('Invalid field guide pagination.');
  const {read,decorate,root,...header}=createObjectFieldReader(db,input);
  if(!read)return header;
  if(input.summaryOnly)return {...header,nextQuery:{...root,topic:'fields'}};
  const total=header.total;
  return {...header,kind:'object-field-guide',offset,nextOffset:offset+limit<total?offset+limit:null,
    coverage:{inventory:'merged-catalog-fields',semantics:'partial',pageComplete:offset+limit>=total,allRuntimeFieldsKnown:false},
    ...(offset+limit<total?{nextQuery:{...root,topic:'fields',offset:offset+limit,limit}}:{}),entries:read(offset,limit).map(decorate),
    guidance:'只沿本次需求所需的字段/引用继续。找到准确字段后读取当前 expect 并核对必要条件与共享范围；字典说明不是可编辑许可，也不证明机制完整。'};
}
