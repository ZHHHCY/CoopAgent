// Original test definitions, no extracted assets. These fixed B97579 samples
// exercise identity-keyed UserData and ordinal Commander metadata separately.
import { DOMParser } from '@xmldom/xmldom';
export function masteryPanelExperiment(mode, userXml = null) {
  if(!['baseline','keyed','indexed-keyed'].includes(mode))throw Error('Mastery panel probe mode must be baseline, keyed or indexed-keyed.');
  const instances = userXml ? Array.from(new DOMParser().parseFromString(userXml,'application/xml').documentElement.childNodes).filter(n=>n.nodeType===1&&n.tagName==='Instances') : [];
  if(mode==='indexed-keyed'&&!instances.length)throw Error('indexed-keyed requires local baseline User XML.');
  const samples=[['Artanis',3,4,0.5,'MasteryArtanisShieldOvercharge'],['Zagara',1,1.5,1,'MasteryZagaraHealthAndEnergyRegen'],
    ['Vorazun',2,2.5,2,'MasteryVorazunDarkPylonRadius'],['Abathur',2,2.5,10,'MasteryAbathurToxicNestDamageAndRespawn'],
    ['Alarak',1,2,0.5,'MasteryAlarakAutoAttackDamage'],['Dehaka',1,1.5,3,'MasteryDehakaConsumeHealing']];
  const queries=[],expected={},user=[],commander=[];
  for(const [id,before,after,sibling,talent] of samples) {
    const value=mode==='baseline'?before:after;
    const add=(suffix,query,want)=>{const key=`${id.toLowerCase()}-${suffix}`;queries.push({id:key,...query});expected[key]=want;};
    for(const [index,want] of [[1,value],[2,sibling]])add(`user-${index}`,{kind:'user-fixed',catalog:'User',entry:'MasteryUpgrades',instance:`${id}Mastery${index}`,field:'PointIncrement'},want);
    add('user-talent',{kind:'user-link',catalog:'User',entry:'MasteryUpgrades',instance:`${id}Mastery1`,field:'TalentData'},talent);
    for(const [index,want] of [[0,value],[1,sibling]])add(`commander-${index}`,{kind:'value',catalog:'Commander',entry:id,field:`MasteryTalentArray[${index}].ValuePerRank`},want);
    add('max-rank',{kind:'value',catalog:'Commander',entry:id,field:'MasteryTalentArray[0].MaxRank'},30);
    add('talent',{kind:'value',catalog:'Commander',entry:id,field:'MasteryTalentArray[0].Talent'},talent);
    add('talents',{kind:'array',catalog:'Commander',entry:id,field:'MasteryTalentArray',member:'Talent'},{count:6});
    const ordinal=instances.findIndex(n=>n.getAttribute('Id')===`${id}Mastery1`);
    if(mode==='indexed-keyed'&&ordinal<0)throw Error(`Missing native identity ${id}Mastery1`);
    user.push(`<Instances${mode==='indexed-keyed'?` index="${ordinal}"`:''} Id="${id}Mastery1"><Fixed${mode==='indexed-keyed'?' index="0"':''} Fixed="${after}"><Field Id="PointIncrement"/></Fixed></Instances>`);
    commander.push(`<CCommander id="${id}"><MasteryTalentArray index="0"><ValuePerRank value="${after}"/></MasteryTalentArray></CCommander>`);
  }
  const files=mode==='baseline'?{}:{
    'Base.SC2Data/GameData.xml':'<Includes><Catalog path="GameData/UserData.xml"/><Catalog path="GameData/CommanderData.xml"/></Includes>',
    'Base.SC2Data/GameData/UserData.xml':`<Catalog><CUser id="MasteryUpgrades">${user.join('')}</CUser></Catalog>`,
    'Base.SC2Data/GameData/CommanderData.xml':`<Catalog>${commander.join('')}</Catalog>`,
  };
  return {revision:2,mode,queries,files,expected,
    boundary:'Tests native UserData lookup and Commander Catalog after map-layer XML merging, not frontend rendering or gameplay mastery activation.'};
}

export function evaluateMasteryPanel(results,experiment,usable) {
  const checks=Object.entries(experiment.expected).map(([id,expected])=>{
    const result=results.find(r=>r.id===id),value=result?.kind==='array'?{count:result.count}:result?.value;
    const matches=typeof expected==='number'?value!==''&&value!==undefined&&Number.isFinite(Number(value))&&Math.abs(Number(value)-expected)<1e-5:
      JSON.stringify(value)===JSON.stringify(expected);
    return {id,expected,value,status:usable&&result?.status==='complete'?(matches?'pass':'fail'):'inconclusive'};
  });
  return {status:!usable||checks.some(c=>c.status==='inconclusive')?'inconclusive':checks.every(c=>c.status==='pass')?'pass':'fail',checks};
}
