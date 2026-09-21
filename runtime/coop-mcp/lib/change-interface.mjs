import {createHash} from 'node:crypto';
import {compactPlanResult} from './plan-delivery-view.mjs';

function inputError(message,fields=[]){
  const error=new Error(message);
  error.details={code:'invalid-change-input',stage:'input',fields,reference:'docs/scalar-capabilities.md'};
  return error;
}
export function validateChangeInput(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw inputError('change requires an object.');
  const keys=Object.keys(input);
  if('preparationId' in input){
    if(keys.length!==1||typeof input.preparationId!=='string'||!input.preparationId.trim())
      throw inputError('Supply preparationId alone to resume; do not combine it with new content or dryRun.',['preparationId']);
    return;
  }
  if('dryRun' in input&&typeof input.dryRun!=='boolean')throw inputError('dryRun must be a boolean.',['dryRun']);
  if('plan' in input){
    if(!input.plan||typeof input.plan!=='object'||Array.isArray(input.plan)||keys.some(k=>!['plan','dryRun'].includes(k)))
      throw inputError('Supply a full plan object (and optional dryRun), or short change fields, not both.',['plan']);
    return;
  }
  const allowed=['id','summary','scope','isolation','operations','dependsOn','conflictsWith','dryRun'];
  const unknown=keys.filter(k=>!allowed.includes(k));
  if(unknown.length)throw inputError('Unknown short change fields. Advanced fields belong in a full plan; nothing was discarded.',unknown);
  const missing=['id','summary','scope','isolation','operations'].filter(k=>input[k]===undefined);
  if(missing.length)throw inputError('Supply id, summary, explicit scope/isolation and nonempty operations, or a full plan.',missing);
  if(typeof input.id!=='string'||!input.id.trim()||typeof input.summary!=='string'||!input.summary.trim())
    throw inputError('id and summary must be nonempty strings.',['id','summary']);
  if(input.summary.length>120)throw inputError('Short change summary must be at most 120 characters; it also supplies the PatchPlan title. Use a full plan for separate title and userSummary.',['summary']);
  for(const k of ['scope','isolation'])if(!input[k]||typeof input[k]!=='object'||Array.isArray(input[k]))throw inputError(k+' must be an explicit object.',[k]);
  if(!Array.isArray(input.operations)||!input.operations.length||input.operations.some(op=>!op||typeof op!=='object'||Array.isArray(op)))
    throw inputError('operations must contain one or more explicit operation objects.',['operations']);
  for(const k of ['dependsOn','conflictsWith'])if(k in input&&(!Array.isArray(input[k])||input[k].some(id=>typeof id!=='string'||!id.trim())))
    throw inputError(k+' must be an array of plan IDs.',[k]);
}

// The envelope is bookkeeping. Targets, scope, isolation, dependencies and
// operations remain explicit design choices; the executor remains authoritative.
export function changePlan(input, baseline) {
  validateChangeInput(input);
  if (input.plan) return structuredClone(input.plan);
  if (!input.id || !input.summary || !input.scope || !input.isolation || !input.operations?.length)
    throw Error('Supply id, summary, explicit scope/isolation and nonempty operations, or a full plan.');
  return {
    formatVersion:2, id:input.id, title:input.summary, target:'game-a.core',
    compatibility:{sc2DataBuild:baseline.sc2.dataBuild,runtimeContract:baseline.schemaVersion},
    userSummary:{text:input.summary},scope:structuredClone(input.scope),isolation:structuredClone(input.isolation),
    operations:structuredClone(input.operations),dependsOn:input.dependsOn??[],conflictsWith:input.conflictsWith??[],
  };
}

export function createChangeInterface({core,baseline,check=()=>{}}) {
  // Repeated identical requests in this server reuse the same prepared bytes.
  // The durable submission service still checks staleness/cancellation and owns
  // idempotent application; callers can also resume by preparationId after restart.
  const preparedByContent=new Map();
  return async input=>{
    validateChangeInput(input);
    async function submit(preparationId,planId,signature){
      try{return compactPlanResult(await core.submitPlan({preparationId}));}
      catch(error){
        const detail=error.details??error.submissionDetails??{};
        const stale=error.code==='preparation-stale'||detail.code==='preparation-stale'||detail.state==='stale';
        if(stale&&signature)preparedByContent.delete(signature);
        // An observation failure may follow a committed write. Never label this
        // "not applied" or automatically retry under a newly generated plan ID.
        error.details={...detail,changeRecovery:{stage:'submit',preparationId,planId:planId??null,
          applicationState:detail.state??'unknown',
          action:stale?'reinspect-current-values-and-prepare':'inspect-project-status-before-retry',
          ...(stale?{}:{resumeInput:{preparationId}}),reference:'docs/scalar-capabilities.md'}};
        throw error;
      }
    }
    if(input.preparationId)return submit(input.preparationId);
    const plan=changePlan(input,await baseline());
    const signature=createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    let prepared=preparedByContent.get(signature);
    if(!prepared){
      try{
        await check(plan);
        prepared=await core.preparePlan({plan});
      }catch(error){
        error.details={...(error.details??error.submissionDetails??{}),changeRecovery:{stage:'prepare',planId:plan.id,
          submittedByThisCall:false,action:'correct-the-specific-diagnostic-without-changing-user-scope',reference:'docs/scalar-capabilities.md'}};
        throw error;
      }
      if(!prepared.preparationId)throw Error('Preparation did not return a bound preparationId; nothing submitted.');
      preparedByContent.set(signature,prepared);
    }
    if(input.dryRun)return compactPlanResult(prepared);
    // Explicit change authorization replaces the model's second tool call, not
    // preflight, selection, scope checks, receipts or transactional application.
    return submit(prepared.preparationId,plan.id,signature);
  };
}
