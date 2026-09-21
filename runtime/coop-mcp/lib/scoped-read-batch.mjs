// Reuse one existing, consistent read snapshot for each explicit scope in a
// synchronous batch. No cache survives a call; commanders/prestiges never mix.
// Errors remain per-item, and input ordering remains stable across scopes.
export function readScopedBatch(search, inputs, read) {
  const groups=new Map(),results=new Array(inputs.length);
  for(const [index,input] of inputs.entries()) {
    const context={commanderId:input.commanderId,...(input.prestigeUpgrade?{prestigeUpgrade:input.prestigeUpgrade}:{})};
    const key=JSON.stringify(context);
    if(!groups.has(key))groups.set(key,{context,items:[]});
    groups.get(key).items.push({input,index});
  }
  const failed=(input,error)=>({status:'unsupported',target:input.target,error:error.message});
  for(const {context,items} of groups.values()) {
    try {
      const snapshot=search.withProjectDatabase(context,()=>({results:items.map(({input})=>{
        try{return read(input);}catch(error){return failed(input,error);}
      })}));
      items.forEach(({index},i)=>{results[index]={...(snapshot.database?{database:snapshot.database}:{}),...snapshot.results[i]};});
    } catch(error) {for(const {input,index} of items)results[index]=failed(input,error);}
  }
  return results;
}
