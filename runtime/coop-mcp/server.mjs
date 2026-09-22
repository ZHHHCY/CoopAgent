import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { createCoopAgentCore, DEFAULT_REPO_ROOT } from './lib/coop-agent-core.mjs';
import { createCoopSearch, RELATIONSHIP_FAMILIES } from './lib/coop-search.mjs';
import { createAgentTaskStore, taskContextFromEnvironment } from '../../scripts/lib/agent-task.mjs';
import { executeScalarSearch, normalizeScalarSearchOperation, SCALAR_SEARCH_OPERATIONS, pageScalarSearchBatch, scalarBatchQueries } from './lib/scalar-search-view.mjs';
import { solveScalar, checkScalarCalculations, SCALAR_TRANSFORMS, SCALAR_MEANINGS } from './lib/scalar-solve.mjs';
import { readScopedBatch } from './lib/scoped-read-batch.mjs';
import { compactPlanResult } from './lib/plan-delivery-view.mjs';

// Numeric changes use the same executor contract as other host entry points.
const core = createCoopAgentCore();
const search = createCoopSearch({reuseSnapshots:true});
process.once('exit',()=>search.close());
const tasks = createAgentTaskStore(DEFAULT_REPO_ROOT);
const taskContext = taskContextFromEnvironment();
const server = new McpServer({ name: 'coop', version: '0.2.0' });
const calculations = new Map();
const handle = fn => async (input = {}) => {
  try {
    if (taskContext) tasks.guard(taskContext);
    const value = await fn(input);
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 'error',
      error: error.message, details: error.details ?? error.submissionDetails ?? {} }) }] };
  }
};
server.registerTool('project_status', {
  description: 'Read current Map Runtime baseline, database, applied changes and backend submission status.',
  annotations: { readOnlyHint: true },
}, handle(async () => ({ ...await core.projectStatus(), developmentFocus: 'scalar-changes' })));
server.registerTool('search', {
  description: 'Read game data. Resolve names with known commanderId/catalog; entity.get takes confirmed IDs. Default entity.get returns objectCard groups/entries with official baseline values and related nextQuery entries. Exact path reads provide current editState, fieldInfluences and usageEvidence. These describe fields and bounded evidence, not simulated gameplay totals. Related entries, unknown usage and incomplete coverage do not require extra investigation by themselves. Read only facts needed for this question or edit. Preserve production commandIndex. Use topic=fields for unclassified fields; commander.get for selected commander sections; galaxy.context for a specific script question. Query syntax is in the shared Skill search.md.',
  inputSchema: {
    harnessCloseout: z.object({stage:z.string(),reason:z.string(),message:z.string(),
      allowedNextActions:z.array(z.string()),checkpointRequired:z.boolean()}).optional()
      .describe('Host-internal finalization redirect; never set this in a model request.'),
    operation: z.enum(SCALAR_SEARCH_OPERATIONS).optional().describe('Specify the operation. galaxy.context reads a bounded exact function body from the locally extracted source. May be omitted only for an unambiguous exact catalog + objectId + path read; normalized to entity.get, never a mutation.'),
    group: z.enum(['attributes','production','abilities','weapons','behaviors','effects','upgrades','forms','conditions','internal']).optional().describe('Object-card group from objectCard.groups[].nextQuery. Filters parameters without hiding the group index. Do not combine with fields, path, fieldPrefix, include or graph options.'),
    commandIndex: z.string().min(1).optional().describe('Exact Abil production/research InfoArray slot from a returned nextQuery, e.g. Train4. Works in default, parameters and fields cards. Do not combine with path, fieldPrefix or include; exact field nextQuery already contains its slot.'),
    topic: z.enum(['overview', 'fields', 'parameters', 'influences', 'mastery', 'identity', 'upgradeEffects', 'production', 'abilities', 'modifiers', 'units', 'buildings', 'forms', 'levelPerks', 'prestiges', 'masteries', 'panelAbilities', 'panelTraits', 'panelCaster', 'defaultUpgrades', 'research']).optional().describe('identity on Unit joins current production/morph chains, commander sources and button restrictions; directory membership alone is not playable identity. upgradeEffects on Upgrade reads current operands and research/child levels, optionally filtered by exact reference. mastery joins current per-point gameplay and separate panel sources. influences reads modifiers and may combine with path. No fieldPrefix/include with topic; path only with influences.'),
    reference:z.object({catalog:z.string().min(1),objectId:z.string().min(1),path:z.string().min(1).optional()}).optional().describe('Only with entity.get topic=upgradeEffects: match EffectArray Reference by exact target catalog/objectId and optional target field, avoiding manual large-array scans.'),
    prestigeUpgrade: z.string().min(1).optional().describe('Actual primaryUpgrade from commander.get(topic=prestiges).officialFacts.entries, not the display id; selects conditional editing context.'),
    commanderId: z.string().min(1).optional().describe('Preserve the resolved commanderId in name resolution, navigation and scoped values. This context is not proof of object ownership.'), query: z.string().min(1).optional().describe('Use the user name for resolve operations, with known commanderId/catalog. Do not invent English IDs; follow candidates or directoryQuery when ambiguous.'),
    catalog: z.string().min(1).optional().describe('Use the typed catalog from commander.get effectTargets or entity.resolve. Omit with commanderId + a commander entry ID to retrieve its effect targets, not editable fields.'),
    objectId: z.string().min(1).optional().describe('entity.get accepts a typed object ID, or a commander.get levelPerk/mastery/prestige entry ID with commanderId and no catalog. Never assume an entry ID is an Upgrade. requirement.explain requires a real Requirement ID.'),
    path: z.string().min(1).optional().describe('Exact field; includes case-sensitive @attribute when needed. Takes precedence over full: no automatic whole-object expansion.'),
    fieldPrefix: z.string().optional().describe('Discover field names by prefix without path, e.g. CostResource or EffectArray. Page using nextOffset.'), target: z.string().optional(),
    detailLevel: z.enum(['overview', 'full']).optional().describe('Default overview. Full expands an object only without path or explicit include; not needed for exact edits.'),
    include: z.array(z.enum(['fields', 'effectiveField', 'relationships', 'unitArrays'])).optional().describe('Explicit parts override full. With path, fields/effectiveField expands evidence for that field only. Relationships and unitArrays are opt-in.'),
    direction: z.enum(['incoming', 'outgoing', 'both']).optional(),
    relationFamily: z.enum(RELATIONSHIP_FAMILIES).optional(), includeFields: z.boolean().optional(),
    maxDepth: z.number().int().min(1).max(4).optional(), limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional().describe('entity.get field-page offset. Follow nextOffset when truncated; full does not mean unpaginated.'),
  }, annotations: { readOnlyHint: true },
}, handle(async input => {
  if (input.harnessCloseout) return { status: 'harness-closeout', ...input.harnessCloseout };
  const inferred = input.operation === undefined;
  input = normalizeScalarSearchOperation(input);
  const result = await executeScalarSearch(search, input);
  if (inferred) result.inputNormalization = { operation: 'entity.get', reason: 'exact-field-read-without-operation' };
  if (taskContext) result.evidenceKey = tasks.observe({ ...taskContext, input, output: result });
  return result;
}));
server.registerTool('search_batch', {
  description:'Read up to 32 known exact fields. Top-level commanderId/prestigeUpgrade provide defaults; each result retains its resolved scope. shared applies to every result; values and edit guards remain per-item. complete=false means some requested items were not delivered: follow nextQuery only if those items are still needed. Reuse existing evidence. No writes.',
  inputSchema:{harnessCloseout:z.object({stage:z.string(),reason:z.string(),message:z.string(),
    allowedNextActions:z.array(z.string()),checkpointRequired:z.boolean()}).optional()
    .describe('Host-internal finalization redirect; never set this in a model request.'),commanderId:z.string().min(1).optional(),prestigeUpgrade:z.string().min(1).optional(),queries:z.array(z.object({catalog:z.string().min(1),objectId:z.string().min(1),path:z.string().min(1),
    commanderId:z.string().min(1).optional(),prestigeUpgrade:z.string().min(1).optional()})).min(1).max(32).optional()},
  annotations:{readOnlyHint:true},
},handle(input=>{
  if(input.harnessCloseout)return {status:'harness-closeout',...input.harnessCloseout};
  if(!input.queries)throw Error('search_batch requires queries');
  const queries=scalarBatchQueries(input);
  const results=readScopedBatch(search,queries,query=>{
    const exact={...query,operation:'entity.get'};
    const result=executeScalarSearch(search,exact);
    return result;
  });
  const output=pageScalarSearchBatch(queries,results);
  if(taskContext)output.evidenceKey=tasks.observe({...taskContext,input:{operation:'entity.batch',queries},output});
  return output;
}));
server.registerTool('scalar_solve', {
  description: 'Compute a requested scalar change from exact current Map Runtime facts. Reads Catalog overrides and the selected prestige, computes the desired value, and inversely solves an existing Upgrade modifier. Returns executable expect/value/path plus a checked equation; never applies. Use for set, relative changes, percentages and damage reduction. Unknown runtime conditions are not guessed. Batch independent targets in changes.',
  inputSchema: {
    changes: z.array(z.object({
      commanderId: z.string().min(1), prestigeUpgrade: z.string().min(1).optional().describe('Actual primaryUpgrade from commander.get.prestiges, not the display id.'),
      target: z.object({ catalog: z.string().min(1), objectId: z.string().min(1), path: z.string().min(1) }),
      basis: z.enum(['current', 'catalog']).optional().describe('current includes the selected prestige and existing scoped Set. catalog means the base field, for explicit base-value requests.'),
      meaning: z.enum(SCALAR_MEANINGS).optional().describe('number: raw field; damage-reduction-percent: 40 means incoming fraction 0.6; bonus-percent: 20 means 0.2; supply-cost: positive supply maps to negative Unit.Food.'),
      transform: z.object({ kind: z.enum(SCALAR_TRANSFORMS), value: z.number() }),
      roundingDecimals: z.number().int().min(0).max(8).optional().describe('Only when rounding is intended; no implicit rounding. Half away from zero.'),
    })).min(1).max(32),
  }, annotations: { readOnlyHint: true },
}, handle(input => {
  const results = readScopedBatch(search,input.changes,change => {
      const result = solveScalar(search,change);
      calculations.set(JSON.stringify(change.target) + change.commanderId + (change.prestigeUpgrade ?? ''), { input: change, result });
      return result;
  });
  const output = { results };
  if (taskContext) output.evidenceKey = tasks.observe({ ...taskContext, input: { operation: 'scalar.solve', ...input }, output });
  return output;
}));
server.registerTool('plan_prepare', {
  description: 'Save and rehearse a PatchPlan implementing the numeric outcome and necessary supporting edits. Use formatVersion=2 and reuse solver operations/requiredDependsOn. Declare evidence-based scope/isolation; no implicit defaults. The envelope below and Skill plan.md suffice for ordinary scalar plans; read full contract only for an unresolved supporting operation/diagnostic. Full executor Schema and scope/precondition checks remain authoritative. Never applies.',
  // This is a permissive description of the shared v1/v2 envelope, not a new
  // operation whitelist or validator. Unknown operation/extension fields pass
  // intact to the existing versioned Schema and atomic executor.
  inputSchema: { plan: z.object({
    formatVersion:z.number().int().describe('Use 2 for new plans; executor retains v1 compatibility.'),
    id:z.string().describe('Unique kebab-case plan ID.'),title:z.string(),target:z.string().describe('game-a.core'),
    compatibility:z.object({sc2DataBuild:z.string().describe('From project/database evidence.'),runtimeContract:z.number().optional().describe('Map Runtime contract, currently 2.')}).passthrough(),
    userSummary:z.object({text:z.string().describe('One concise user-visible outcome.')}).passthrough().optional(),
    scope:z.object({kind:z.string().describe('Actual scope, e.g. commander; never broaden beyond the request.'),commanderId:z.string().optional()}).passthrough().optional(),
    isolation:z.object({strategy:z.string().describe('Actual strategy: player-upgrade, direct-private, private-clone, player-runtime or global. Choose from evidence, not convenience.'),
      owner:z.object({catalog:z.string(),object:z.string()}).passthrough().optional()}).passthrough().optional(),
    dependsOn:z.array(z.string()).optional().describe('Union of requiredDependsOn from current/solver evidence.'),conflictsWith:z.array(z.string()).optional(),
    operations:z.array(z.record(z.string(),z.unknown())).describe('Reuse solver operation, with unique opId per operation. Keep kind/catalog/object/path/expect/value and conditions; supporting operations remain allowed.'),
  }).passthrough() },
}, handle(async input => {
  checkScalarCalculations(search, input.plan, calculations.values());
  return compactPlanResult(await core.preparePlan(input));
}));
server.registerTool('target_confirm', {
  description: 'Optional early clarification of WHAT to change, before researching HOW. After minimal lookup, ask when names/levels conflict, several targets fit, or intended effects differ. Use player language, not implementation choices. Persists the candidate and ends this run; all further calls are blocked until the user answers. Skip for clear requests.',
  inputSchema: {
    question: z.string().min(1).max(800), target: z.string().min(1).max(800),
    currentEffect: z.string().min(1).max(800), proposedEffect: z.string().min(1).max(800),
    reason: z.string().min(1).max(800), evidenceKeys: z.array(z.string().min(1)).max(16).optional(),
  },
}, handle(input => {
  if (!taskContext) throw Error('Target confirmation requires an active host task');
  return tasks.requestConfirmation({ ...taskContext, ...input });
}));
server.registerTool('task_checkpoint', {
  description: 'Deliver with disposition=deliver: summary is the complete answer shown verbatim before the host stops generation. Answer questions directly. delivery records complete/partial/no_change/unresolved and relevant completed effects, omissions and verification; backend application/Receipt facts remain separate. Optional evidenceKeys must copy returned evidenceKey values; omit if unused. disposition=continue/blocked saves unfinished progress.',
  inputSchema: {
    stage: z.enum(['scope', 'draft', 'verify']), summary: z.string().min(1).max(4000)
      .describe('The complete user-facing answer, displayed verbatim. Address the user directly. Internal facts, hypotheses and delivery metadata belong in the other fields.'),
    facts: z.array(z.string().min(1).max(600)).max(16).optional(),
    hypotheses: z.array(z.string().min(1).max(600)).max(8).optional(),
    evidenceKeys: z.array(z.string().min(1).max(100)).max(16).optional(),
    remaining: z.array(z.string().min(1).max(600)).max(12).optional(),
    nextAction: z.string().min(1).max(400), disposition: z.enum(['continue', 'blocked', 'deliver']),
    delivery: z.object({
      outcome: z.enum(['complete', 'partial', 'no_change', 'unresolved']),
      completed: z.array(z.string().min(1).max(800)).max(24).optional(),
      omitted: z.array(z.string().min(1).max(800)).max(24).optional(),
      verification: z.object({ level: z.enum(['not_checked', 'static_checked', 'runtime_checked']),
        notes: z.string().min(1).max(1200).optional() }).optional(),
    }).optional(),
  },
}, handle(input => {
  if (!taskContext) throw Error('Task checkpoint requires an active host turn');
  return tasks.checkpoint({ ...taskContext, ...input });
}));
server.registerTool('plan_submit', {
  description: 'Select ONE final prepared plan for this delivery turn. The plan may cover a coherent subset of independent user requests, but every operation required to make that subset scope-correct and atomic must be included. Record other requested effects as omissions in the delivery checkpoint. Later user feedback opens a new turn and a new plan that depends on applied prior work. Returns application status, not gameplay verification. Never starts the editor or game.',
  inputSchema: { preparationId: z.string().min(1) },
}, handle(async input => {
  return compactPlanResult(await core.submitPlan(input));
}));
await server.connect(new StdioServerTransport());
