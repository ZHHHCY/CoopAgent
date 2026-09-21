export const SCALAR_SEARCH_OPERATIONS = ['commander.resolve', 'commander.get', 'entity.resolve',
  'entity.get', 'requirement.explain', 'patches.for_target', 'galaxy.context'];

export function normalizeScalarSearchOperation(input) {
  if (input.operation !== undefined) return { ...input };
  const allowed = new Set(['operation','catalog','objectId','path','commanderId','prestigeUpgrade','include','detailLevel']);
  const exact = ['catalog','objectId','path'].every(key => typeof input[key] === 'string' && input[key].trim().length > 0);
  if (!exact || Object.keys(input).some(key => !allowed.has(key))) {
    throw new Error('Missing operation: specify a search operation. Only an unambiguous catalog + objectId + path read can omit operation (entity.get).');
  }
  return { ...input, operation: 'entity.get' };
}

export function scalarBatchQueries(input) {
  return input.queries.map(query=>{
    const commanderId=query.commanderId??input.commanderId;
    const prestigeUpgrade=query.prestigeUpgrade??(query.commanderId&&query.commanderId!==input.commanderId?undefined:input.prestigeUpgrade);
    return {...query,...(commanderId?{commanderId}:{}),...(prestigeUpgrade?{prestigeUpgrade}:{})};
  });
}

// Agent response selection is separate from the shared UI/data projection.
// An exact field must not accidentally trigger a whole-object graph through full.
export function scalarSearchInput(input) {
  input = normalizeScalarSearchOperation(input);
  if(input.operation==='commander.get')return {...input,responseProfile:'scalar-card'};
  if (input.operation !== 'entity.get') return { ...input };
  const exact = typeof input.path === 'string' && input.path.trim().length > 0;
  const selected = input.include !== undefined;
  const query = { ...input };
  // Select the read model before fetching data, not by deleting large sections
  // after legacy graph/field projections have already been constructed.
  query.responseProfile = 'scalar-card';
  if(input.limit===undefined && !exact)query.limit=input.topic==='influences'?8:input.group?20:15;
  if (exact || selected) query.detailLevel = 'overview';
  if (exact && input.topic !== 'influences') {
    const include = new Set(input.include ?? []);
    // With path, fields means evidence for this field, not unrelated siblings.
    if (include.delete('fields')) include.add('effectiveField');
    if (!selected && ['direction', 'maxDepth', 'relationFamily', 'includeFields']
      .some(key => input[key] !== undefined)) include.add('relationships');
    query.include = [...include];
  }
  return query;
}

export function executeScalarSearch(search, input) {
  input = normalizeScalarSearchOperation(input);
  const selected=scalarSearchInput(input);
  let query=selected;
  for(;;) {
    const result=scalarSearchView(search.execute(query),input);
    const bytes=Buffer.byteLength(JSON.stringify(result));
    if(bytes<=24000)return query===selected?result:{...result,outputLimit:{reason:'response-byte-budget',requestedLimit:selected.limit??30,returnedLimit:query.limit}};
    // Re-read a smaller genuine page. The data source owns offsets/totals and
    // context; never truncate JSON, edit guards or an arbitrary subtree.
    const pageable=result.objectCard?.entries||result.masteryEvidence?.effects||result.upgradeEffects?.effects||result.fieldInfluences?.entries||result.officialFacts?.entries||result.fields;
    const limit=query.limit??30;
    if(pageable?.length>1 && limit>1){query={...query,limit:Math.max(1,Math.floor(limit/2))};continue;}
    return {operation:input.operation,status:'response-too-large',bytes,
      message:'This result cannot fit safely in one tool response. Narrow to an exact field, one group, or one relationship family; no complete evidence was delivered.',
      ...(result.objectCard?.groups?{groups:result.objectCard.groups}:{}),
      ...(result.officialFacts?.sections?{sections:result.officialFacts.sections}:{}),
      query:input};
  }
}

// Budget the whole batch, not just each field. Return complete field evidence
// or an explicit continuation, never a sliced edit guard or truncated JSON.
export function pageScalarSearchBatch(queries,results,{byteLimit=24000}={}) {
  const size=value=>Buffer.byteLength(JSON.stringify(value));
  let count=results.length;
  const page=()=>({...shareBatchContext(results.slice(0,count).map((result,index)=>({input:queries[index],...result}))),
    total:queries.length,returned:count,complete:count===queries.length,
    ...(count<queries.length?{nextQuery:{queries:queries.slice(count)},message:'Only returned fields were delivered. Continue with nextQuery for the remaining fields.'}:{})});
  while(count>0){const output=page();if(size(output)<=byteLimit)return output;count--;}
  // A single large result plus continuation can exceed the envelope even if
  // its original individual search fitted. Point to that exact read explicitly.
  const output={results:[{input:queries[0],status:'response-too-large',nextQuery:{operation:'entity.get',...queries[0]},
    message:'Read this exact field separately; no field evidence was delivered for this item.'}],
    total:queries.length,returned:1,complete:false,...(queries.length>1?{nextQuery:{queries:queries.slice(1)}}:{})};
  if(size(output)>byteLimit)return {status:'response-too-large',complete:false,message:'Input identifiers exceed the response budget. Use individual exact-field searches.'};
  return output;
}

// Factor only identical context/interpretation, never values, edits, guards,
// dependencies, truncation or targets. The page is losslessly expandable.
const SHARED_BATCH_PATHS=[['database'],['currentProject'],['valueContext'],
  ...['coverage','taskPolicy','note','setRisk'].map(key=>['fieldInfluences',key])];
function shareBatchContext(results) {
  if(results.length<2)return {results};
  const output=structuredClone(results),shared={};
  for(const parts of SHARED_BATCH_PATHS) {
    const get=row=>parts.reduce((value,key)=>value?.[key],row);
    const value=get(results[0]),serialized=JSON.stringify(value);
    if(value===undefined || serialized.length<64 || !results.every(row=>JSON.stringify(get(row))===serialized))continue;
    let parent=shared;for(const key of parts.slice(0,-1))parent=parent[key]??=( {} );parent[parts.at(-1)]=value;
    for(const row of output){let parent=row;for(const key of parts.slice(0,-1))parent=parent[key];delete parent[parts.at(-1)];}
  }
  return Object.keys(shared).length?{shared,sharedMeaning:'Shared context applies to every result; each result retains its own values, scope-sensitive edits and guards.',results:output}:{results};
}

export function expandScalarSearchBatchResult(page,result) {
  const output=structuredClone(result);
  for(const parts of SHARED_BATCH_PATHS) {
    const value=parts.reduce((value,key)=>value?.[key],page.shared);
    if(value===undefined)continue;
    let parent=output;for(const key of parts.slice(0,-1))parent=parent[key]??={};
    if(parent[parts.at(-1)]===undefined)parent[parts.at(-1)]=structuredClone(value);
  }
  return output;
}

function compactDatabase(database) {
  if (!database) return database;
  const { engineCatalog, ...rest } = database;
  // Counts and identical baseline descriptions are available in project_status.
  return { ...rest, ...(engineCatalog ? { engineCatalog: {
    mode: engineCatalog.mode, coverage: engineCatalog.coverage, unobserved: engineCatalog.unobserved,
    commanderRuntimeEvaluated: engineCatalog.commanderRuntimeEvaluated,
  } } : {}) };
}

// Preserve edit guards, provenance and uncertainty; omit repeated policy prose.
export function scalarSearchView(result, input = {}) {
  const view = { ...result };
  if (view.database) view.database = compactDatabase(view.database);
  if(view.officialFacts?.semanticIndex) {
    const {stats,...semanticIndex}=view.officialFacts.semanticIndex;
    view.officialFacts={...view.officialFacts,semanticIndex};
  }
  if(view.objectCard?.entries) {
    const sources=[...(view.objectCard.sources??[])],indices=new Map(sources.map((source,i)=>[JSON.stringify(source),i]));
    const internSource=entry=>{
      const {source,alsoVia,...rest}=entry;
      if(source) {
        const key=JSON.stringify(source);
        if(!indices.has(key)){indices.set(key,sources.length);sources.push(source);}
        rest.sourceIndex=indices.get(key);
      }
      if(alsoVia)rest.alsoVia=alsoVia.map(internSource);
      return rest;
    };
    const entries=view.objectCard.entries.map(entry=>{
      entry=internSource(entry);
      if(!entry.meaning)return entry;
      const {catalog,class:cls,template,evidence,...meaning}=entry.meaning;
      return {...entry,meaning};
    });
    view.objectCard={...view.objectCard,entries,sources};
  }
  if (view.currentProject) {
    const { baseline, localObjectCount, affectedObjectCount, ...context } = view.currentProject;
    view.currentProject = context;
  }
  if (view.editState) {
    view.editState = { ...view.editState };
    delete view.editState.authoringRoute;
    if (view.editState.edit) {
      const { recommended, ...edit } = view.editState.edit;
      view.editState.edit = edit;
    }
    if (view.editState.scopeNote && !['Upgrade','Commander','User'].includes(view.entity?.catalog)) view.editState.scopeNote =
      'catalogEdit writes the Catalog layer; commanderId alone does not isolate that write.';
  }
  delete view.guidance;
  if (!view.objectCard && view.operation === 'entity.get' && input.topic === 'fields') view.responseMode = 'object-field-guide';
  if (!view.objectCard && view.operation === 'entity.get' && input.topic === 'parameters') view.responseMode = 'object-parameters';
  if (view.operation==='entity.get' && !input.path && input.fieldPrefix===undefined && input.include===undefined
      && input.detailLevel!=='full' && ['commander-directory','unit-directory','object-details'].includes(view.officialFacts?.kind)) {
    for(const key of ['fields','totalFields','offset','nextOffset','truncated']) delete view[key];
    view.responseMode=view.officialFacts.kind;
  }
  if (view.responseMode === 'commander-entry') return view;
  if (view.operation === 'entity.get' && !input.path && input.include !== undefined && !input.include.includes('fields')) {
    // Shared UI projection adds fields for pathless calls; the MCP caller has
    // explicitly chosen other parts. Their own pagination remains untouched.
    for (const key of ['fields', 'totalFields', 'offset', 'nextOffset', 'truncated']) delete view[key];
    view.responseMode = 'selected-parts';
  }
  if (view.operation === 'entity.get' && input.path && input.topic !== 'influences') {
    view.requestedPath = input.path;
    view.responseMode = 'exact-field';
  }
  return view;
}
