import test from 'node:test';
import assert from 'node:assert/strict';
import {masteryPanelExperiment,evaluateMasteryPanel} from '../lib/mastery-panel-probe.mjs';
import {generateProbe} from '../lib/sc2-catalog-probe.mjs';
import {inspectMasteryPoint} from '../lib/mastery-point-editor.mjs';
import {DOMParser} from '@xmldom/xmldom';
test('mastery experiment observes native identity values and unchanged sibling/limit without setter calls',()=>{
  const baseline=masteryPanelExperiment('baseline'),patched=masteryPanelExperiment('keyed');
  assert.equal(Object.keys(baseline.files).length,0);
  const source=generateProbe({runId:'review',bankName:'CoopMasteryReview',queries:patched.queries});
  assert.match(source,/UserDataGetFixed\("MasteryUpgrades", "ArtanisMastery1", "PointIncrement", 1\)/);
  assert.match(source,/UserDataGetGameLink\("MasteryUpgrades", "ArtanisMastery1", "TalentData", 1\)/);
  assert.doesNotMatch(source,/UserDataSet|CatalogFieldValueSet/);
  const success=patched.queries.map(q=>({...q,status:'complete',...(q.kind==='array'?{count:6}:{value:String(patched.expected[q.id])})}));
  assert.equal(evaluateMasteryPanel(success,patched,true).status,'pass');
  success.find(q=>q.id==='artanis-user-1').value='3';
  assert.equal(evaluateMasteryPanel(success,patched,true).status,'fail');
  assert.equal(evaluateMasteryPanel(success,patched,false).status,'inconclusive');
});

test('mastery adapter rejects multiple Fixed records, changed field identity and ambiguous core records',()=>{
  const xml=s=>new DOMParser().parseFromString(s,'application/xml').documentElement;
  const source='<CUser id="MasteryUpgrades"><Instances Id="ArtanisMastery1"><Fixed Fixed="3"><Field Id="PointIncrement"/></Fixed></Instances></CUser>';
  const path='Instances[0:ArtanisMastery1].Fixed[0:PointIncrement].@Fixed';
  assert.equal(inspectMasteryPoint(xml(source),null,path).writeSupport.supported,true);
  for(const changed of [source.replace('</Instances>','<Fixed Fixed="2"><Field Id="PointIncrement" Index="1"/></Fixed></Instances>'),source.replace('Id="PointIncrement"','Id="OtherField"')])assert.equal(inspectMasteryPoint(xml(changed),null,path).writeSupport.supported,false);
  assert.equal(inspectMasteryPoint(xml(source),xml(source),path).writeSupport.supported,false,'Id-only core override did not pass engine experiment');
});
