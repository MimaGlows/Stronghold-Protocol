import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Match} from '../server/match/Match.js';
import {GameData} from '../server/match/gamedata.js';
import {VirtualScheduler} from '../server/match/scheduler.js';
import {decorateBattle,roundEscalation} from '../server/match/custom.js';
import {defaultCustom} from '../shared/custom.js';
import {buildQuitRecord,compactRecord} from '../shared/stats.js';
import {privacyRecord} from '../shared/matchPrivacy.js';
import {matchInfoModel} from '../public/js/ui/matchInfo.js';
import {MatchRecorder} from '../server/replays/recorder.js';
import {startServer} from '../server/index.js';
import {TestClient} from './helpers/wsClient.js';
import {DATA} from './match/harness.js';
import {FakeBattle} from './match/fakeBattle.js';

function fixture(c={},n=4,difficulty='NORMAL'){
  const m=new Match({mode:'custom',difficulty,customConfig:{...defaultCustom(),capacity:n>4?n:4,...c},seed:123,data:DATA,scheduler:new VirtualScheduler({instantCombat:false}),
    seats:Array.from({length:n},(_,seat)=>({seat,playerId:'p'+seat,name:'Repair'+seat,doctorCode:'100'+seat,connected:true})),
    BattleClass:FakeBattle,clientCombat:false,send(){},broadcast(){},onEnd(){}});
  for(const p of m.order)p.lp=30;return m;
}
test('actual boss start applies native baseline, six-player rule, HP and R19 escalation once',()=>{
  for(const d of ['FUNNY','NORMAL','HARD','ABYSS'])for(let n=1;n<=6;n++)for(const hp of [50,100,200,300])for(const r of [14,19]){
    const m=fixture({enemyHp:hp,extraRounds:true},n,d),native=new GameData(DATA,`mode_${n===1?'single':'multi'}_${d.toLowerCase()}`);
    m.startRound(r);m.startFinalAssault(false);
    assert.equal(m.bossPool.maxHp,Math.max(1,Math.round(native.bossPoolHp(m.bossId,n===6?4:n)*(n===6?2:1)*hp/100*roundEscalation(r))),`${d}/${n}/${hp}/R${r}`);
    m.dispose();
  }
});
test('extended waves reuse the complete last ordinary composition, including faction picks',()=>{
  for(const d of ['FUNNY','NORMAL','HARD','ABYSS'])for(let n=1;n<=6;n++){
    const m=fixture({extraRounds:true},n,d),native=new GameData(DATA,`mode_${n===1?'single':'multi'}_${d.toLowerCase()}`),base=native.bossRound-1;
    m.startRound(base);const wave=m.wave;
    assert.ok(wave.pick);
    for(const r of [15,16,17,18]){m.startRound(r);assert.deepEqual(m.wave.pick,wave.pick);assert.deepEqual(m.wave.spawns,wave.spawns);assert.deepEqual(m.gd.enemyScale(r),native.enemyScale(base));}
    m.startRound(19);assert.ok(m.bossWaves.every(g=>g.wave.pick));m.dispose();
  }
});
test('single custom retains R14/R19 structure with native standard last wave and single core threshold',()=>{
  const m=fixture({},1,'FUNNY'),native=new GameData(DATA,'mode_single_funny');
  assert.equal(m.gd.isSolo,true);assert.equal(m.gd.bossRound,14);assert.equal(m.gd.lastRound,14);assert.equal(m.soloUntimed,false);
  for(const r of [8,9,10,13])assert.equal(m.gd.roundCfg(r).template,native.roundCfg(8).template);
  m.dispose();const x=fixture({},1);assert.equal(x.gd.hiddenCore.single,350);assert.equal(x.gd.isSolo,true);x.dispose();
});
test('tourist authoritative and both projected life values clamp at zero',()=>{
  const m=fixture({tourist:true});m.startRound(1);m.order[0].lp=1;
  m.lastResults=new Map(m.order.map((p,i)=>[p.playerId,{leaked:i===0?Array.from({length:5},()=>({counted:true})):[],perfect:i!==0,coins:0,layerGains:{}}]));m.settle(null,null);
  assert.equal(m.order[0].lp,0);assert.equal(m.order[0].privateView().lp,0);assert.equal(m.publicView().players[0].lp,0);assert.equal(m.order[0].alive,true);m.dispose();
});
test('debt remainder rotation balances the real R13 odd spawn actions without losing bounty identity',()=>{
  const m=fixture({debt:true});m.order[3].eliminate(1);m.order[2].lp=10;m.startRound(13);
  const rows=m.order.slice(0,2).map(p=>decorateBattle(m,{kind:'normal',spawns:[],players:[{playerId:p.playerId}],flags:{}}).spawns.filter(s=>s.sourcePlayerId==='p3'));
  const counts=rows.map(xs=>xs.reduce((n,s)=>n+s.count,0));assert.deepEqual(counts,[16,16]);m.dispose();
});
test('quit metadata and execution version survive normalization and list compaction',()=>{
  const m=fixture({enemyHp:200});m.startRound(2);
  const rec=buildQuitRecord({me:{playerId:'p0'},room:{mode:'custom'},match:{public:m.publicView()}},{live:{active:true,sawStart:true,startedAt:0,aliveRound:2},now:5000});
  assert.equal(rec.customConfig.enemyHp,200);assert.equal(rec.customEvaluation.score,m.customEvaluation.score);assert.equal(rec.initialPlayerCount,4);assert.equal(rec.customRulesVersion,2);
  assert.equal(compactRecord(rec).customRulesVersion,2);m.dispose();
});
test('legacy matching flag redacts nested replay identities without altering durable ownership',()=>{
  const raw={isMatchingMatch:true,participants:[{name:'Repair',doctorCode:'1234'}],result:{players:[{doctorCode:'1234'}]}};
  assert.equal(privacyRecord(raw).participants[0].doctorCode,undefined);assert.equal(privacyRecord(raw).result.players[0].doctorCode,undefined);assert.equal(raw.participants[0].doctorCode,'1234');
});
test('hidden-war info models cannot reconstruct static disabled bonds',()=>{
  const gd=new GameData(DATA,'mode_multi_funny'),model=matchInfoModel({hiddenWar:true},{mode:gd.mode,bonds:Object.values(DATA.bonds)});
  assert.equal(model.hidden,true);assert.deepEqual(model.core,[]);assert.deepEqual(model.banned,[]);assert.equal(model.sets.off.size,0);
});
test('real backfill projects private identities, expires conflicting invitations and saves settings atomically',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sp-repair-protocol-')),clients=[];
  const server=await startServer({port:0,host:'127.0.0.1',quiet:true,recording:false,profileDir:path.join(dir,'profiles'),matchmakingDir:path.join(dir,'matching'),matchmakingWaitMs:1});
  t.after(async()=>{await Promise.all(clients.map(c=>c.terminate()));await server.close();fs.rmSync(dir,{recursive:true,force:true});});
  const player=async name=>{const c=await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`);c.id=(await c.hello(name)).playerId;clients.push(c);return c;};
  const session=c=>server.registry.byId(c.id),request=async(c,x)=>{const r=await c.request(x);assert.equal(r.t,'ok',JSON.stringify(r));return r;};
  const h=await player('RepairHost#1001'),q=await player('RepairQueue#1002');await request(h,{t:'room.create',mode:'coop',difficulty:'NORMAL'});const room=server.lobby.roomOf(session(h));
  await request(h,{t:'matching.setEnabled',on:true,bond:null,revision:room.matchingRevision});await request(q,{t:'matching.prepare',difficulty:'NORMAL',bond:null,revision:0,partyId:null});
  await new Promise(r=>setTimeout(r,20));server.lobby.matchmakingService.parties.pump();assert.equal(room.matchPrivacy,true);await request(h,{t:'room.start'});
  assert.equal(room.match.matchPrivacy,true);assert.ok(room.match.publicView().players.every(p=>!p.doctorCode));
  const rec=new MatchRecorder(room.match,{version:'repair',simulationVersion:'repair'}).record;assert.ok(privacyRecord(rec).participants.every(p=>!p.doctorCode));
  const a=await player('FixInviteA#1003'),b=await player('FixInviteB#1004'),g=await player('FixInviteG#1005');
  for(const c of [a,b]){await request(c,{t:'social.add',identity:'FixInviteG#1005'});await request(c,{t:'matching.invite',identity:'FixInviteG#1005',difficulty:'NORMAL'});}
  const parties=server.lobby.matchmakingService.parties,invites=[...parties.invites.values()].filter(i=>i.to==='FixInviteG#1005');assert.equal(invites.length,2);
  await request(g,{t:'matching.inviteRespond',inviteId:invites[0].id,accept:true});assert.equal([...parties.invites.values()].filter(i=>i.to==='FixInviteG#1005').length,0);
  assert.equal(parties.of(session(g)).members.length,2);assert.equal(parties.of(session(g)).id,invites[0].partyId);
  const c=await player('RepairCustom#1006');await request(c,{t:'room.create',mode:'custom',difficulty:'NORMAL'});const custom=server.lobby.roomOf(session(c)),revision=custom.customRevision;
  await request(c,{t:'room.custom',config:custom.custom,name:'设置测试',difficulty:'HARD',revision});assert.equal(custom.difficulty,'HARD');assert.equal(custom.customName,'设置测试');
  assert.equal((await c.request({t:'room.custom',config:custom.custom,name:'过期',difficulty:'FUNNY',revision})).code,'MATCH_STALE');assert.equal(custom.difficulty,'HARD');assert.equal(custom.customName,'设置测试');
  assert.equal(Object.keys(custom.toState().scoreContexts).length,4);
});
