import test from 'node:test';
import assert from 'node:assert/strict';
import {Match} from '../server/match/Match.js';
import {defaultCustom,MATCH_LIMIT_MS} from '../shared/custom.js';
import {VirtualScheduler} from '../server/match/scheduler.js';
import {GameData} from '../server/match/gamedata.js';
import {DATA} from './match/harness.js';
import {FakeBattle} from './match/fakeBattle.js';
import {FieldRunner} from '../server/match/fields.js';
import {liveLp} from '../public/js/ui/hud.js';
import {observeTarget,cameraLayers} from '../public/js/battle/observe.js';
import {Battle} from '../server/sim/Battle.js';


function fixture(config={},n=4,difficulty='ABYSS',extra={}){
  const scheduler=new VirtualScheduler({instantCombat:false}),messages=[];let ended=0,result;
  const m=new Match({mode:'custom',difficulty,customConfig:{...defaultCustom(),capacity:n>4?n:4,...config},seed:123,data:DATA,scheduler,
    seats:Array.from({length:n},(_,seat)=>({seat,playerId:`p${seat}`,name:`P${seat}`,connected:true})),
    BattleClass:FakeBattle,clientCombat:false,send(){},broadcast(msg){messages.push({at:scheduler.now(),msg});},onEnd(r){ended++;result=r;},...extra});
  for(const p of m.order)p.lp=30;
  return {m,scheduler,messages,get ended(){return ended;},get result(){return result;}};
}
const bossResult=f=>({perPlayer:Object.fromEntries(f.players.map(id=>[id,{perfect:true,leaked:[],killed:0,damageDealt:0,coins:0}])),errors:0});
test('R19 wins once even when original hidden-core eligibility is satisfied, and never returns to R15',()=>{
  for(const hiddenReached of [false,true]){
    const f=fixture({extraRounds:true,debt:true,fateWager:true}),{m,scheduler}=f;
    m.hiddenReached=hiddenReached;m.hiddenLayerSum=10000;m.startRound(19);m.startFinalAssault(false);m.bossPool.hp=0;
    m._finishFinal(false,bossResult);m._finishFinal(false,bossResult);scheduler.advance(20000);
    assert.equal(m.round,19);assert.equal(f.ended,1);assert.equal(f.result.victory,true);m.startRound(15);assert.equal(m.round,19);m.dispose();
  }
});
test('only R14 unlocks a core once; a failed custom core ends instead of advancing',()=>{
  const f=fixture({extraRounds:true}),{m,scheduler}=f;m.startRound(14);m.hiddenLayerSum=10000;m.startFinalAssault(false);m.bossPool.hp=0;m._finishFinal(false,bossResult);scheduler.advance(20000);
  assert.equal(m.round,15);assert.equal(m.hiddenReached,true);m.startFinalAssault(true);m._finalEnding='forced';m._finishFinal(true,bossResult);scheduler.advance(20000);
  assert.equal(f.ended,1);assert.equal(f.result.victory,false);assert.equal(m.round,15);m.dispose();
});
test('old boss callbacks cannot advance a changed phase or bypass the hard duration limit',()=>{
  for(const kind of ['phase','deadline']){const f=fixture({extraRounds:true}),{m,scheduler}=f;m.armDurationLimit();m.startRound(19);m.startFinalAssault(false);m.bossPool.hp=0;m._finishFinal(false,bossResult);
    if(kind==='phase'){m.phase='PREP';scheduler.advance(20000);assert.equal(f.ended,0);assert.equal(m.round,19);}
    else{m.finish({victory:false,reason:'duration_limit'});scheduler.advance(MATCH_LIMIT_MS);assert.equal(f.ended,1);assert.equal(f.result.reason,'duration_limit');}
    m.dispose();}
});
test('all four difficulties and one to six players use the last ordinary wave for extra ordinary rounds',()=>{
  for(const difficulty of ['FUNNY','NORMAL','HARD','ABYSS'])for(let n=1;n<=6;n++){
    const {m}=fixture({extraRounds:true},n,difficulty),native=new GameData(DATA,`mode_${n===1?'single':'multi'}_${difficulty.toLowerCase()}`),base=n===1?native.bossRound-1:13;
    for(const round of [15,16,17,18]){m.startRound(round);assert.equal(m.wave.templateId,native.roundCfg(base).template);assert.deepEqual(m.gd.enemyScale(round),native.enemyScale(base));assert.ok(m.wave.spawns.length>0);}
    m.dispose();
  }
});
test('neutral co-op custom ABYSS R1-14 spawns and actual enemy attributes match ordinary rooms',()=>{
  for(const n of [2,3,4]){
    const a=fixture({},n),b=fixture({},n,'ABYSS',{mode:'coop',customConfig:null});
    for(let round=1;round<=14;round++){
      a.m.startRound(round);b.m.startRound(round);assert.deepEqual(a.m.gd.enemyScale(round),b.m.gd.enemyScale(round));
      const aw=a.m.wave||a.m.bossWaves[0].wave,bw=b.m.wave||b.m.bossWaves[0].wave;assert.deepEqual(aw.spawns,bw.spawns);assert.deepEqual(aw.overrides,bw.overrides);
      // Normal, special and bounty-sized enemies use the same engine normalization, not only matching modifiers.
      if(round<14){const pa=a.m._normalOpts(a.m.order[0]),pb=b.m._normalOpts(b.m.order[0]);
        const sa=new Battle({...pa,data:a.m.ds,content:a.m.battleContent}),sb=new Battle({...pb,data:b.m.ds,content:a.m.battleContent});
        for(const spawn of aw.spawns){const ea=sa.spawnEnemy(spawn.enemyKey,spawn),eb=sb.spawnEnemy(spawn.enemyKey,spawn);assert.deepEqual(ea.s,eb.s);}
      }
    }a.m.dispose();b.m.dispose();
  }
});
test('custom and private matchmaking prohibit all setup reroll entrypoints; ordinary rooms remain available',()=>{
  for(const extra of [{},{mode:'coop',customConfig:null,matchPrivacy:true},{mode:'coop',customConfig:null,matchingPreferences:[]}]){
    const {m}=fixture({},2,'NORMAL',extra);m.start();assert.equal(m.publicView().canRerollSetup,false);assert.equal(m.requestSetupReroll('p0',0).error,'MATCH_LOCKED');assert.equal(m.voteSetupReroll(m.order[1],1,true).error,'MATCH_LOCKED');assert.equal(m.completeSetupReroll().error,'MATCH_LOCKED');m.dispose();
  }
  const {m}=fixture({},2,'NORMAL',{mode:'coop',customConfig:null});m.start();assert.equal(m.publicView().canRerollSetup,true);assert.equal(m.requestSetupReroll('p0',0).ok,true);m.dispose();
});
test('hidden war allows prep scouting while retaining intelligence redaction and ordinary live-field permissions',()=>{
  const {m}=fixture({hiddenWar:true});m.order[1].bandId=m.gd.bandIds()[0];m.startRound(1);assert.equal(m.watch(m.order[0],'n:p1').ok,true);assert.deepEqual(m.nextEnemiesFor(m.order[1]),[]);assert.ok(m.prepFieldMeta(m.order[1]).effects.every(e=>e.iconKind!=='band'));
  m.fields=[{fieldId:'n:p0',kind:'normal',players:['p0'],live:true},{fieldId:'n:p1',kind:'normal',players:['p1'],live:true}];assert.equal(m.watch(m.order[0],'n:p1').error,'WRONG_PHASE');
  m.fields[0].live=false;m._sendField=()=>{};assert.equal(m.watch(m.order[0],'n:p1').ok,true);m.order[0].alive=false;assert.equal(m.watch(m.order[0],'n:p1').ok,true);m.dispose();
});
test('server-run life preview changes publish within 200ms without idle rebroadcast, using contract caps',()=>{
  for(const config of [{},{noLeakCap:true},{whitebird:true},{tourist:true}]){
    const f=fixture(config,2),{m,scheduler,messages}=f;m.startRound(1);m.setDeadline(0);m.phase='COMBAT';let leaks=0;
    const battle={finished:false,time:0,step(){this.time+=1/30;},drainEvents(){return [];},snapshot(){return {units:[],gt:this.time};},get _perPlayer(){return {p0:{leaked:Array.from({length:leaks},()=>({counted:true}))}};},leakedCount:0};
    const field={fieldId:'n:p0',kind:'normal',players:['p0'],live:true,battle};m.fields=[field];m.watchers.clear();const runner=new FieldRunner(m,[field],{onDone(){}});runner.start();scheduler.advance(500);messages.length=0;
    const at=scheduler.now();leaks=12;battle.leakedCount=12;scheduler.advance(200);
    const loss=config.whitebird?0:config.noLeakCap?12:10;const view=m.publicView();assert.equal(view.players[0].pendingLp||0,loss);
    if(loss){const first=messages.find(r=>r.msg.players[0].pendingLp===loss);assert.ok(first);assert.ok(first.at-at<=200);}
    const before=messages.length;scheduler.advance(500);assert.equal(messages.length,before);
    assert.equal(liveLp(null,{phase:'COMBAT',round:1,lp:5,leaks:config.whitebird?0:12,cap:view.lifePreview.cap}).pending,config.whitebird?0:5);
    runner.stop();m.dispose();
  }
});
test('same unite field uses camera halves; distinct fields retain second-step observation targets',()=>{
  const pub={phase:'UNITE',players:[{playerId:'a',alive:true},{playerId:'b',alive:true},{playerId:'c',alive:true}],fields:[{fieldId:'u:a',players:['a','b'],kind:'unite',live:true},{fieldId:'u:c',players:['c'],kind:'unite',live:true}]};
  assert.ok(observeTarget(pub.players[1],pub,'a').reason);assert.equal(observeTarget(pub.players[2],pub,'a').fieldId,'u:c');assert.deepEqual(cameraLayers({...pub.fields[0],sides:{a:'L',b:'R'}},pub,'a').map(l=>l.key),['L','ALL','R']);
});
