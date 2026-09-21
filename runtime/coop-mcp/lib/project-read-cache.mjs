import {createHash} from 'node:crypto';
import {existsSync,readFileSync,readdirSync,statSync,lstatSync} from 'node:fs';
import path from 'node:path';

// Content, not mtime alone: editors can replace a same-size file and restore its
// timestamp. Official SQLite changes also use the live connection data_version.
export function projectReadRevision(repoRoot,databaseFile) {
  const hash=createHash('sha256');
  const walk=(file)=>{
    hash.update(path.relative(repoRoot,file));
    if(!existsSync(file)){hash.update('<absent>');return;}
    const stat=lstatSync(file);
    if(stat.isSymbolicLink())throw Error(`Linked project artifact cannot be cached: ${path.relative(repoRoot,file)}`);
    if(stat.isDirectory())for(const entry of readdirSync(file,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      if(entry.isSymbolicLink())throw Error(`Linked project artifact cannot be cached: ${entry.name}`);
      walk(path.join(file,entry.name));
    }
    else hash.update(readFileSync(file));
  };
  for(const relative of ['game-a/runtime-baseline.json','game-a/core/GameA.SC2Mod','game-a/patches'])walk(path.join(repoRoot,relative));
  const stat=statSync(databaseFile);
  hash.update(JSON.stringify([databaseFile,stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs]));
  return hash.digest('hex');
}

export function createProjectReadCache({limit=3,open,revision,measure=(_name,read)=>read()}) {
  const pool=new Map();let hits=0,misses=0;
  const version=db=>Number(db.prepare('PRAGMA data_version').get().data_version);
  const discard=key=>{const item=pool.get(key);if(item){pool.delete(key);item.database.close();}};
  function read(context,handler) {
    const current=measure('revision',revision),key=JSON.stringify(context);
    // Changes to core, baseline or applied plans invalidate every scope.
    for(const [k,item] of pool)if(item.revision!==current)discard(k);
    for(let attempt=0;attempt<3;attempt++) {
      let item=pool.get(key);
      if(!item){misses++;item=measure('snapshot-build',()=>open(context));item.revision=current;item.dataVersion??=version(item.database);pool.set(key,item);}
      else hits++;
      item.database.exec('BEGIN');
      try {
        item.database.prepare('SELECT key FROM main.meta LIMIT 1').get();
        if(version(item.database)!==item.dataVersion){item.database.exec('ROLLBACK');discard(key);continue;}
        pool.delete(key);pool.set(key,item);
        return measure('query',()=>handler(item));
      } finally {
        if(pool.get(key)===item)item.database.exec('ROLLBACK');
        while(pool.size>limit)discard(pool.keys().next().value);
      }
    }
    throw Error('Official database changed repeatedly while acquiring a read snapshot; retry after indexing completes.');
  }
  return {read,close:()=>{for(const key of [...pool.keys()])discard(key);},stats:()=>({hits,misses,snapshots:pool.size})};
}
