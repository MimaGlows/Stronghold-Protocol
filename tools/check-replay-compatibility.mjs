// Read-only upgrade audit. Never instantiates ReplayArchive or changes old archives.
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { playbackCompatibility, simulationVersion } from '../server/replays/compatibility.js';
import { replayVersion } from '../server/replays/version.js';
const args=process.argv.slice(2),arg=(name)=>args[args.indexOf(name)+1];
if(!args.includes('--dir'))throw new Error('--dir required');
const dir=path.resolve(arg('--dir')),build=replayVersion(),engine=simulationVersion();
const report={checkedAt:new Date().toISOString(),build,simulationVersion:engine,counts:{},entries:[]};
for(const name of fs.readdirSync(dir).filter(n=>n.endsWith('.json.gz'))){
  const buffer=fs.readFileSync(path.join(dir,name));let entry;
  try{const r=JSON.parse(gunzipSync(buffer));const reason=['ready','partial'].includes(r.status)?playbackCompatibility(r):r.status==='processing'&&!(r.simulationVersion? r.simulationVersion===engine:r.version===build||(r.version==='4dc8f887537e1e9effeb'&&engine==='acdd070fcac25c9c824d'))?'generation-code':r.incompatibilityReason||r.expiryReason||null;
    entry={id:r.id,status:reason&&['ready','partial','processing'].includes(r.status)?'incompatible':r.status,reason,originalVersion:r.version,frames:r.fields.reduce((n,f)=>n+(f.frames?.length||0),0),durationMs:r.durationMs,sha256:createHash('sha256').update(buffer).digest('hex')};
  }catch{entry={id:name,status:'invalid',reason:'archive-decode'};}
  report.counts[entry.status]=(report.counts[entry.status]||0)+1;report.entries.push(entry);
}
const json=JSON.stringify(report,null,2);if(args.includes('--out'))fs.writeFileSync(path.resolve(arg('--out')),json+'\n');
console.log(JSON.stringify({counts:report.counts,build,simulationVersion:engine}));
