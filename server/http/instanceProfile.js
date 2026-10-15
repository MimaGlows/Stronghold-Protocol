import path from 'node:path';
import {ROOT} from './config.js';
/** Installation settings are separate from the common release bytes. */
export function instanceScript(root=ROOT){
  const name=path.basename(root),experimental=name==='Stronghold-Protocol-Matchmaking';
  const namespace=experimental?'sp.matchmaking':name==='Stronghold-Protocol-3001'?'sp.3001':'sp';
  const profile=JSON.stringify({namespace,experimental});
  const migration=namespace==='sp.3001'?'for(const kind of ["localStorage","sessionStorage"]){try{const s=globalThis[kind],marker="sp.3001.migration.v1";if(s.getItem(marker))continue;for(const key of Object.keys(s)){if(key.startsWith("sp.")&&!key.startsWith("sp.3001.")){const next="sp.3001."+key.slice(3);if(s.getItem(next)===null)s.setItem(next,s.getItem(key));}}s.setItem(marker,"1");}catch{}}':'';
  return 'globalThis.__SP_INSTANCE__='+profile+';'+migration;
}
