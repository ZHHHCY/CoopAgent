import { createObjectFieldReader, describeField, referenceTarget } from './field-vocabulary.mjs';

const numeric = value => typeof value==='string' && /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value));
const conditionRoles = new Set(['condition','removal-condition']);
const navigationRoles = new Set(['execution','event-execution','attachment','command','command-target','research-target','research-presentation','modifier-target','spawn-target']);
const SCAN_LIMIT = 5000;
export const OBJECT_PARAMETER_GROUPS = {
  attributes:'本体数值', production:'生产/研究命令', abilities:'技能', weapons:'武器',
  behaviors:'被动/行为', effects:'执行效果', upgrades:'升级修改', forms:'形态', conditions:'条件', internal:'内部/通用入口',
};
const directoryGroups={skills:'abilities',weapons:'weapons',passives:'behaviors',internalAbilities:'internal',forms:'forms',production:'production',upgrades:'upgrades'};

// A view over the one field interpreter, not another dictionary. Only the
// selected page gets source decoration, localized names and target lookups.
export function readObjectParameters(db,input,context={}) {
  const offset=input.offset??0,limit=input.limit??30;
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw Error('Invalid parameter pagination.');
  if(input.group!==undefined && !Object.hasOwn(OBJECT_PARAMETER_GROUPS,input.group))throw Error('Unknown object parameter group.');
  const reader=createObjectFieldReader(db,input);
  const {read,decorate,root,...metadata}=reader;
  if(!read)return metadata;
  const rows=read(0,SCAN_LIMIT);
  const onThisObject=[],continueVia=[],conditions=[];
  let unknownFields=0,nonNumericParameters=0,displayReferences=0;
  for(const row of rows) {
    const meaning=describeField(input.catalog,metadata.entity.class,row.path);
    if(meaning.status==='unknown')unknownFields++;
    if(['scalar','operand'].includes(meaning.kind)) {
      if(!numeric(row.value)){nonNumericParameters++;continue;}
      onThisObject.push({section:'onThisObject',row,meaning});
    } else if(meaning.kind==='filter') {
      conditions.push({section:'conditions',row,meaning});
    } else if(meaning.kind==='reference') {
      if(['display','presentation-target'].includes(meaning.role)){displayReferences++;continue;}
      const section=conditionRoles.has(meaning.role)?'conditions':navigationRoles.has(meaning.role)?'continueVia':null;
      if(section)(section==='conditions'?conditions:continueVia).push({section,row,meaning});
    }
  }
  // Names and non-local production/modifier/form entries enrich one link list.
  // Do not duplicate attributes or expand cached effect graphs on a node read.
  for(const group of ['skills','weapons','passives','internalAbilities','forms','production','upgrades']) {
    for(const item of context.directory?.[group]??[]) {
      const existing=continueVia.find(d=>{
        if(!d.row)return false;
        const t=referenceTarget(d.meaning,d.row.value,input.objectId);
        return t?.catalog===item.target.catalog && t.objectId===item.target.objectId && item.commandIndex===undefined;
      });
      if(existing){existing.presentation=item;existing.group=directoryGroups[group];}
      else continueVia.push({section:'continueVia',presentation:item,group:directoryGroups[group]});
    }
  }
  // Several Unit card buttons may point at the same attached Abil. There is
  // only one next ID query; retain every command/path as evidence on that link.
  const uniqueLinks=[],linkKeys=new Map();
  for(const descriptor of continueVia) {
    const target=descriptor.row?referenceTarget(descriptor.meaning,descriptor.row.value,input.objectId):null;
    const canGroup=target && input.catalog==='Unit' && ['attachment','command'].includes(descriptor.meaning.role);
    const key=canGroup?JSON.stringify([target.catalog,target.objectId]):null;
    const previous=key?linkKeys.get(key):null;
    if(previous)(previous.additionalReferences??=[]).push(descriptor);
    else {uniqueLinks.push(descriptor);if(key)linkKeys.set(key,descriptor);}
  }
  const queryContext={...(input.commanderId?{commanderId:input.commanderId}:{}),...(input.prestigeUpgrade?{prestigeUpgrade:input.prestigeUpgrade}:{})};
  const groupOf=d=>{
    if(d.group)return d.group;
    if(d.section==='onThisObject')return 'attributes';
    if(d.section==='conditions')return 'conditions';
    const target=referenceTarget(d.meaning,d.row.value,input.objectId);
    if(d.meaning.role==='modifier-target'||d.meaning.role==='research-target')return 'upgrades';
    return {Abil:'abilities',Weapon:'weapons',Behavior:'behaviors',Effect:'effects',Unit:'forms'}[target?.catalog]??'internal';
  };
  const materialize=d=>{
    if(!d.row) {
      const p=d.presentation;
      return {section:d.section,label:p.name,role:p.role,group:d.group,target:p.target,status:p.status,
        ...(p.via?{via:p.via}:{}),...(p.commandIndex!==undefined?{commandIndex:p.commandIndex}:{}),
        ...(p.nextQuery?{nextQuery:{...p.nextQuery,...queryContext}}:{}),
        ...(p.conditionQuery?{conditionQuery:{...p.conditionQuery,...queryContext}}:{}),
        basis:'indexed-commander-directory',conditionsEvaluated:false};
    }
    const entry=decorate(d.row),meaning=d.meaning;
    if(meaning.kind==='filter')return {section:'conditions',label:meaning.label,role:meaning.role,
      baselineValue:entry.value,path:entry.path,source:entry.source,nextQuery:entry.nextQuery};
    if(d.section==='onThisObject') {
      const candidate={section:d.section,label:meaning.label,path:entry.path,sourcePath:entry.sourcePath,
        baselineValue:entry.value,meaning,source:entry.source,nextQuery:entry.nextQuery};
      if(entry.modifierContext)candidate.modifierContext=entry.modifierContext;
      return candidate;
    }
    const {nextQuery,...target}=entry.target??{};
    return {section:d.section,group:groupOf(d),label:d.presentation?.name??meaning.label,role:meaning.role,purpose:meaning.purpose,
      via:{catalog:input.catalog,objectId:input.objectId,path:entry.path,sourcePath:entry.sourcePath},source:entry.source,
      ...(entry.target?{target:{...target,...(d.presentation?{name:d.presentation.name}:{})}}:{}),
      status:entry.target?.exists?'linked':'unresolved',...(nextQuery?{nextQuery}:{}),
      ...(d.additionalReferences?{alsoVia:d.additionalReferences.map(r=>({sourcePath:r.row.path,role:r.meaning.role,
        ...(referenceTarget(r.meaning,r.row.value,input.objectId)?.command?{command:referenceTarget(r.meaning,r.row.value,input.objectId).command}:{}),
        source:{file:r.row.source_file,originObjectId:r.row.origin_object_id,inheritanceDepth:r.row.inheritance_depth}}))}:{})};
  };
  const allEntries=[...onThisObject,...conditions,...uniqueLinks],scanComplete=rows.length===metadata.total;
  const groups=Object.entries(OBJECT_PARAMETER_GROUPS).map(([group,label])=>({group,label,total:allEntries.filter(d=>groupOf(d)===group).length,
    nextQuery:{...root,topic:'parameters',group}})).filter(g=>g.total>0);
  // The group index is never paginated with the fields. Every relevant branch
  // stays discoverable even when hundreds of scalar fields precede it.
  const entries=input.group?allEntries.filter(d=>groupOf(d)===input.group):groups.flatMap(g=>allEntries.filter(d=>groupOf(d)===g.group));
  const header={status:'partial',kind:'object-parameters',basis:'official-catalog',currentProjectIncluded:false,
    entity:metadata.entity,writeEligibility:'not-checked',...(input.commandIndex!==undefined?{commandIndex:input.commandIndex}:{}),
    ...(metadata.presentation?{presentation:metadata.presentation}:{}),
    ...(metadata.upgradeContext?{upgradeContext:metadata.upgradeContext}:{}),
    groups,...(input.group?{group:input.group}:{}),
    counts:{onThisObject:onThisObject.length,continueVia:uniqueLinks.length,conditions:conditions.length},
    coverage:{scannedFields:rows.length,totalFields:metadata.total,scanComplete,countsBasis:'scanned-fields-and-indexed-directory',
      unknownFields,nonNumericParameters,displayReferencesExcluded:displayReferences,runtimeEvaluated:false,
      ...(context.status?{directoryStatus:context.status}:{}),...(context.directory?.coverage?{directory:context.directory.coverage}:{}),
      note:'空列表不证明无参数。基线候选不是当前值、修改许可或已生效条件。'},
    fieldsQuery:{...root,topic:'fields',...(!scanComplete?{offset:rows.length}:{})},
    ...(context.directory?.otherModifierCandidates?{otherModifierCandidates:context.directory.otherModifierCandidates}:{})};
  // Internal compatibility only; MCP uses paginated entries in both modes.
  if(input.summaryOnly)return {...header,
    onThisObject:onThisObject.slice(0,5).map(materialize),continueVia:uniqueLinks.slice(0,5).map(materialize),conditions:conditions.slice(0,5).map(materialize),
    truncated:[onThisObject,uniqueLinks,conditions].some(xs=>xs.length>5),nextQuery:{...root,topic:'parameters'}};
  return {...header,total:entries.length,offset,nextOffset:offset+limit<entries.length?offset+limit:null,
    entries:entries.slice(offset,offset+limit).map(materialize),
    ...(offset+limit<entries.length?{nextQuery:{...root,topic:'parameters',...(input.group?{group:input.group}:{}),offset:offset+limit,limit}}:{})};
}
