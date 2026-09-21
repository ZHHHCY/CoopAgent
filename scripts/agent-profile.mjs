#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {buildAgentProfile} from './lib/agent-profile.mjs';
const args=process.argv.slice(2),profile=args[args.indexOf('--profile')+1],output=args[args.indexOf('--output')+1];
if(!args.includes('--profile')||!args.includes('--output')||!profile||!output)throw Error('Usage: node scripts/agent-profile.mjs --profile workflow|capabilities|parameters --output <config.json>');
const config=buildAgentProfile(JSON.parse(await fs.readFile('opencode.json','utf8')),{profile});
await fs.mkdir(path.dirname(path.resolve(output)),{recursive:true});
await fs.writeFile(output,JSON.stringify(config,null,2)+'\n');
console.log(JSON.stringify({profile,config:path.resolve(output)}));
