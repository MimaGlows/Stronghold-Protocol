import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultCustom,checkCustom,customRoomName,customScore,MATCH_LIMIT_MS } from '../shared/custom.js';
import { Match } from '../server/match/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { DATA } from './match/harness.js';
import { decorateBattle,captureWhitebird,scaleSpawns } from '../server/match/custom.js';
import { GameData } from '../server/match/gamedata.js';
import { Unit } from '../server/sim/units.js';
import { privacyRecord } from '../shared/matchPrivacy.js';
import { Room } from '../server/lobby.js';
import { makeBattle } from './helpers/battleHarness.js';
import { generateDraft } from '../server/match/choices.js';
import { createRng } from '../server/sim/rng.js';
import { uniteBattleOpts } from '../server/match/unite.js';
import { FakeBattle } from './match/fakeBattle.js';

function fixture(config={},n=4,difficulty='NORMAL',options={}){
  const scheduler=new VirtualScheduler();let ends=0,result;
  const m=new Match({mode:'custom',difficulty,customConfig:{...defaultCustom(),...config},seed:123,data:DATA,scheduler,
    seats:Array.from({length:n},(_,seat)=>({seat,playerId:`p${seat}`,name:`P${seat}`,doctorCode:`100${seat}`,connected:true})),
    send(){},broadcast(){},onEnd(r){ends++;result=r;},...options});
  return {m,scheduler,get ends(){return ends;},get result(){return result;}};
}
test('custom options validate all endpoints, names, exclusivity and unknown fields',()=>{
  assert.ok(checkCustom(defaultCustom(),DATA.bonds));assert.equal(checkCustom({...defaultCustom(),redeploy:-1}),null);
  assert.equal(checkCustom({...defaultCustom(),oneLife:true,lastStand:true}),null);
  assert.equal(checkCustom({...defaultCustom(),enemyCount:1001}),null);
  assert.equal(checkCustom({...defaultCustom(),requiredBonds:['absent']},DATA.bonds),null);
  assert.ok(checkCustom({...defaultCustom(),redeploy:0,capacity:6}));assert.equal(customRoomName('一二三四五六七八九十'), '一二三四五六七八九十');assert.equal(customRoomName('一二三四五六七八九十一'),null);
});
test('four difficulty anchors and whitebird invariance across combinations',()=>{
  for(const [d,b] of Object.entries({FUNNY:200,NORMAL:400,HARD:600,ABYSS:800})){
    assert.equal(customScore(defaultCustom(),d).score,b);
    for(let bits=0;bits<32;bits++){const c={...defaultCustom(),wildfire:!!(bits&1),tourist:!!(bits&2),noLeakCap:!!(bits&4),unite:bits&8?200:60,oneLife:!!(bits&16)};assert.deepEqual(customScore({...c,whitebird:true},d),customScore({...c,whitebird:false},d));}
  }
});
test('room capacity does not alter ordinary four seats',()=>{assert.equal(new Room('AAAA','coop','NORMAL',0).seats.length,4);assert.equal(new Room('ABCDE','custom','NORMAL',0).custom.capacity,4);});
test('up to two required core and one add-on bonds stay active without removing all random bans',()=>{
  const ids=[...Object.keys(DATA.bonds).filter(id=>Number(DATA.bonds[id].weight)>0&&DATA.bonds[id].isCore).slice(0,2),...Object.keys(DATA.bonds).filter(id=>Number(DATA.bonds[id].weight)>0&&!DATA.bonds[id].isCore).slice(0,1)];
  const {m}=fixture({requiredBonds:ids});assert.ok(ids.every(id=>!m.disabledBonds.includes(id)&&!m.staticInactiveBonds.includes(id)));assert.ok(m.disabledBonds.length>0);m.dispose();
});
test('custom setup rerolls preserve required bonds',()=>{
  const ids=[...Object.keys(DATA.bonds).filter(id=>Number(DATA.bonds[id].weight)>0&&DATA.bonds[id].isCore).slice(0,2),...Object.keys(DATA.bonds).filter(id=>Number(DATA.bonds[id].weight)>0&&!DATA.bonds[id].isCore).slice(0,1)],{m}=fixture({requiredBonds:ids},1);
  m.start();for(let i=0;i<3;i++){m.completeSetupReroll();assert.ok(ids.every(id=>!m.disabledBonds.includes(id)&&!m.staticInactiveBonds.includes(id)));}m.dispose();
});
test('default supply retains stock; supply 12 quadruples every stock including overrides',()=>{
  const native=new GameData(DATA,'mode_multi_normal');for(const supply of [3,12]){const {m}=fixture({supply});for(const id of native.visibleChess)assert.equal(m.gd.poolCopies(id),native.poolCopies(id)*(supply/3));m.dispose();}
});
test('100 minute deadline includes pause and finishes once with no victory',()=>{
  const {m,scheduler,...unused}=fixture();void unused;
  m.armDurationLimit();m.phase='PREP';m.paused=true;scheduler.advance(MATCH_LIMIT_MS-1);assert.equal(m.ended,false);scheduler.advance(1);assert.equal(m.outcome.reason,'duration_limit');assert.equal(m.outcome.victory,false);assert.equal(m._durationTimer,null);m.dispose();
});
test('ordinary solo match has same hard deadline, independent from phase deadlines',()=>{
  const scheduler=new VirtualScheduler();const m=new Match({mode:'solo',difficulty:'FUNNY',data:DATA,scheduler,seats:[{seat:0,playerId:'p',name:'P'}],send(){},broadcast(){},onEnd(){}});
  m.start();assert.equal(m.durationDeadline-m.durationStartedAt,MATCH_LIMIT_MS);m.setDeadline(0);scheduler.advance(MATCH_LIMIT_MS);assert.equal(m.outcome.reason,'duration_limit');m.dispose();
});
test('quantity doubles each enemy action but never duplicates boss bodies',()=>{
  const list=[{enemyKey:'a',count:10},{enemyKey:'b',count:20},{enemyKey:'boss',tag:'boss',count:1}];assert.deepEqual(scaleSpawns(list,2).map(s=>s.count),[20,40,1]);assert.equal(scaleSpawns(list,.1).reduce((n,s)=>n+s.count,0),4);
});
test('whitebird recycles at 13/18, preserves first age and uses original unboosted snapshot',()=>{
  const {m}=fixture({whitebird:true});m.round=1;m.lastResults=new Map([['p0',{leaked:[{enemyKey:'enemy_1041_lazerd_2',mods:{hpMul:2},counted:true}]}]]);captureWhitebird(m);assert.equal(m.customBank.length,1);
  const opts={kind:'normal',players:[{playerId:'p0'}],spawns:[],flags:{}};m.round=12;assert.equal(decorateBattle(m,opts).spawns.length,0);m.round=13;let s=decorateBattle(m,opts).spawns[0];assert.equal(s.mods.whitebirdBoost,2.2);assert.equal(m.customBank.length,1);assert.deepEqual(decorateBattle(m,opts).spawns,decorateBattle(m,opts).spawns);
  m.lastResults=new Map([['p0',{leaked:[{enemyKey:s.enemyKey,mods:s.mods,counted:true}]}]]);captureWhitebird(m);assert.equal(m.customBank[0].firstRound,1);m.round=18;s=decorateBattle(m,opts).spawns[0];assert.equal(s.mods.whitebirdBoost,2.7);assert.equal(s.mods.hpMul,2);m.dispose();
});
test('normal and non-triggered extra R15 have waves; R19 is a supported deterministic boss',()=>{
  const a=fixture({extraRounds:true}),b=fixture({extraRounds:true});assert.equal(a.m.extraBossId,b.m.extraBossId);a.m.startRound(15);assert.ok(a.m.wave?.spawns.length);assert.equal(a.m.bossWaves,null);assert.equal(a.m.publicView().hiddenRound,null);a.m.startRound(19);assert.ok(a.m.bossWaves[0].wave.spawns.length);assert.equal(a.m.publicView().bossId,null);assert.equal(a.m.publicView().bossRound,19);assert.deepEqual(a.m.nextEnemiesFor(a.m.order[0]),[]);a.m.dispose();b.m.dispose();
});
test('extra rounds continue after both earlier bosses and finish exactly once at R19',()=>{
  FakeBattle.reset();FakeBattle.script=()=>({duration:1,bossDps:1e9});
  const f=fixture({extraRounds:true},2,'NORMAL',{BattleClass:FakeBattle}),{m,scheduler}=f;m.start();m.armDurationLimit();
  for(let step=0;!m.ended&&step<50000;step++){
    for(const p of m.order){if(m.phase==='INFO_CHECK')m.handle(p.playerId,{t:'g.infoReady'});
      if(m.phase==='BAND_DRAFT'&&m.draftTurn()===p.playerId)m.handle(p.playerId,{t:'g.band',bandId:m.gd.bandIds()[0]});
      if(m.phase==='SP_DRAFT'&&m.spTurn()===p.playerId){const idx=m.sp.cards.find(c=>m.sp.taken[c.idx]==null)?.idx;if(idx!=null)m.handle(p.playerId,{t:'g.choice',idx});}
      if(m.phase==='PREP'&&!p.ready){p.resolveTemp();m.handle(p.playerId,{t:'g.ready',ready:true});}}
    if(!scheduler.runNext())break;
  }
  assert.equal(f.ends,1);assert.equal(m.round,19);assert.equal(f.result.victory,true);assert.ok(FakeBattle.instances.some(b=>b.round===15));assert.ok(FakeBattle.instances.some(b=>b.round===18));m.dispose();FakeBattle.reset();
});
test('fractional gold accumulates, while income already scaled and sale never multiplied',()=>{
  const {m}=fixture({gold:50});const p=m.order[0];p.funds=0;assert.equal(p.addFunds(1,{reason:'effect'}),0);assert.equal(p.addFunds(1,{reason:'effect'}),1);assert.equal(p.addFunds(4,{reason:'sell'}),4);m.dispose();
});
test('fractional layers carry from prep through separate combat rounds',()=>{
  const {m}=fixture({layers:50}),p=m.order[0],id=m.gd.bondIds[0];p.addLayers(id,1);assert.equal(p.customRemainders[`layers:${id}`],50);
  const h=makeBattle({players:[p.battleInput()],content:'none',flags:{layerGainsEnabled:true,custom:{layers:.5}}});assert.equal(h.b.addLayers(p.playerId,id,1),1);
  m.phase='COMBAT';m.fields=[{players:[p.playerId],live:true}];m._finishCombat(()=>({perPlayer:{[p.playerId]:h.b._pp(p.playerId)}}));assert.equal(p.customRemainders[`layers:${id}`],0);
  const next=makeBattle({players:[p.battleInput()],content:'none',flags:{layerGainsEnabled:true,custom:{layers:.5}}});assert.equal(next.b.addLayers(p.playerId,id,1),0);assert.equal(next.b.addLayers(p.playerId,id,1),1);m.dispose();
});
test('custom boss reinforcements scale while bodies and parts remain single',()=>{
  for(const count of [.5,2,10]){const h=makeBattle({content:'none',flags:{customQueue:true,custom:{count}},units:[]});
    for(let i=0;i<2;i++)h.b.spawnEnemy('enemy_1007_slime',{mods:{customSummon:true}});
    assert.equal(h.b.enemies.length,Math.floor(count*2));
    h.b.spawnEnemy('enemy_1007_slime',{tag:'part',mods:{customSummon:true}});h.b.spawnEnemy('enemy_1007_slime',{tag:'boss',mods:{customSummon:true}});assert.equal(h.b.enemies.length,Math.floor(count*2)+2);}
});
test('stat multipliers apply above native clamps; zero redeployment multiplier remains zero',()=>{
  const u=new Unit({id:1,side:'ally',kind:'op',base:{maxHp:100,atk:100,def:100,res:10,aspd:100,bat:2},customStats:{allyHp:3,allyAtk:4,allyAspd:4,redeploy:0}});
  assert.equal(u.s.maxHp,300);assert.equal(u.s.atk,400);assert.equal(u.s.def,150);assert.equal(u.s.res,30);assert.equal(u.s.interval,.5);assert.equal(u.s.redeployMul,0);assert.equal(u.s.defIgnorePct,.4);
});
test('public match identity redaction preserves archive input and removes nested codes',()=>{
  const r={result:{matchPrivacy:true,players:[{name:'P',doctorCode:'1000'}]},participants:[{name:'P',doctorCode:'1000'}]};const p=privacyRecord(r);assert.equal(p.result.players[0].doctorCode,undefined);assert.equal(p.participants[0].doctorCode,undefined);assert.equal(r.participants[0].doctorCode,'1000');
});
test('600 living enemies keep excess spawns pending and count all 700 at timeout',()=>{
  const h=makeBattle({enemies:[{key:'enemy_1007_slime',count:700}],flags:{customQueue:true},units:[],content:'none'});
  h.step();assert.equal(h.b.total,700);assert.equal(h.b.aliveEnemies().length,600);assert.equal(h.b._pending.length,100);
  h.b.forceEnd('timeout');const r=h.b.result();assert.equal(r.perPlayer.p1.leaked.length,700);assert.equal(r.errors,0);
});
test('five and six player bounty drafts contain nine cards with three extra targets',()=>{
  for(const n of [5,6]){const {m}=fixture({},n);const choices={...m.gd.choices,schedule:{...m.gd.choices.schedule,[m.modeId]:{rounds:{3:{cards:6,families:[{family:'bounty',weight:1}],bountyDraft:'initial'}}}}};
    Object.defineProperty(m.gd,'choices',{value:choices});const d=generateDraft(m.gd,createRng(7),3);assert.equal(d.cards.length,9);assert.deepEqual(d.cards.slice(6).map(c=>c.coin),[1,2,2]);m.dispose();}
});
test('six-player beacons bypass exhausted stock without adding held stock or duplicate rewards',()=>{
  const {m}=fixture({},6);m.itemPool.canGain=()=>false;m.startRound(10);
  const id='chess_item_5_04_e_a';assert.equal(m.itemPool.held(id),0);for(const p of m.order)assert.equal(p.hand.filter(x=>x?.id===id).length,1);
  m.startRound(10);for(const p of m.order)assert.equal(p.hand.filter(x=>x?.id===id).length,1);m.dispose();
});
test('six-player boss pool is twice four-player baseline and five remains native',()=>{
  const gd=new GameData(DATA,'mode_multi_normal');for(const n of [5,6]){const {m}=fixture({},n);assert.equal(m.gd.bossPoolHp('boss_1',n),gd.bossPoolHp('boss_1',Math.min(n,4))*(n===6?2:1));m.dispose();}
});
test('wildfire removes damaged/downed carry for assisting operators and preserves summons',()=>{
  const {m}=fixture({wildfire:true});const p=m.order[0];p.board.set('9:2',{uid:1,kind:'chess'});p.board.set('9:3',{uid:2,kind:'token'});
  m.lastResults=new Map([[p.playerId,{unitsEnd:[{uid:1,alive:false,sp:50},{uid:2,alive:true,sp:10}]}]]);
  let carry;p.battleInput=opts=>{carry=opts.carry;return {playerId:p.playerId,units:[]};};
  uniteBattleOpts(m,{helpers:[p],leaked:[]},60);assert.equal(carry.has(1),false);assert.equal(carry.get(2).sp,10);m.dispose();
});
test('carnival switches on the actual second-pool draft, keeps that pool and scales elites',()=>{
  const {m}=fixture({carnival:true,enemyCount:200});m.startRound(1);const opts={kind:'normal',spawns:[],players:[{playerId:'p0'}],flags:{}};let o=decorateBattle(m,opts);assert.equal(DATA.enemies[o.spawns[0].enemyKey].rank,'ELITE');assert.equal(o.spawns[0].count,2);
  const choices=m.gd.choices;Object.defineProperty(m.gd,'choices',{value:{...choices,schedule:{...choices.schedule,[m.modeId]:{rounds:{6:{bountyDraft:'boss'},11:{bountyDraft:'hunter'}}}}}});
  m.round=6;m.sp={family:'bounty'};m.phase=PHASE_FOR_TEST;m.enterPrep=()=>{};m.finishSpDraft();assert.equal(m.carnivalPool,'boss');
  for(const round of [6,7,8,11,12]){m.round=round;o=decorateBattle(m,opts);assert.equal(o.spawns[0].enemyKey,'enemy_10118_ymgprc');assert.equal(o.spawns[0].count,2);assert.deepEqual(decorateBattle(m,opts).spawns,o.spawns);}
  m.phase=PHASE_FOR_TEST;m.round=11;m.sp={family:'bounty'};m.finishSpDraft();assert.equal(m.carnivalPool,'boss');m.dispose();
});
const PHASE_FOR_TEST='SP_DRAFT';
test('debt divides scaled future waves between maximum-life ties without scaling twice',()=>{
  const {m}=fixture({debt:true,enemyCount:200});m.startRound(2);m.order[3].eliminate(1);m.order[0].lp=28;m.order[1].lp=28;m.order[2].lp=20;
  const a=decorateBattle(m,{kind:'normal',spawns:[],players:[{playerId:'p0'}],flags:{}}),b=decorateBattle(m,{kind:'normal',spawns:[],players:[{playerId:'p1'}],flags:{}});
  const expected=m.wave.spawns.reduce((n,s)=>n+(s.count??1),0)*2;assert.equal([...a.spawns,...b.spawns].reduce((n,s)=>n+s.count,0),expected);assert.ok(a.spawns.every(s=>s.sourcePlayerId==='p3'));m.dispose();
});
