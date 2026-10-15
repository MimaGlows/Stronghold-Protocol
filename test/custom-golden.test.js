import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { makeBattle } from './helpers/battleHarness.js';
import { defaultCustom,customScore } from '../shared/custom.js';
const file=new URL('./golden/custom-v1.json',import.meta.url);
const configurations={baseline:{},fastRedeploy:{redeploy:0,allyHp:50},enemyPressure:{enemyHp:300,enemyAtk:250,enemyAspd:200,enemyCount:200},allyPressure:{allyHp:250,allyAtk:300,allyAspd:200}};
function samples(){
  const rows=[];
  for(const [name,settings]of Object.entries(configurations))for(const seed of [7,31,101]){
    const c={...defaultCustom(),...settings},h=makeBattle({seed,timeLimit:60,units:[{chessId:'chess_char_1_01_a',row:10,col:4},{chessId:'chess_char_1_02_a',row:10,col:6}],
      enemies:[{key:'enemy_1041_lazerd_2',count:Math.round(4*c.enemyCount/100),interval:2}],
      flags:{customQueue:true,custom:{enemyHp:c.enemyHp/100,enemyAtk:c.enemyAtk/100,enemyAspd:c.enemyAspd/100,allyHp:c.allyHp/100,allyAtk:c.allyAtk/100,allyAspd:c.allyAspd/100,redeploy:c.redeploy/100,layers:1}}});
    h.run(60);const r=h.result();assert.equal(r.errors,0);
    rows.push({name,seed,score:customScore(c,'NORMAL',{modelVersion:2}).score,digest:createHash('sha256').update(JSON.stringify(r)).digest('hex'),time:r.time,kills:r.killed,leaks:r.perPlayer.p1.leaked.length});
  }
  return rows;
}
test('custom reference lineups: twelve fixed samples preserve versioned deterministic results',()=>{
  const rows=samples();if(process.env.SP_UPDATE_CUSTOM==='1')fs.writeFileSync(file,JSON.stringify({version:1,rows},null,2)+'\n');
  assert.deepEqual(rows,JSON.parse(fs.readFileSync(file,'utf8')).rows);
});
