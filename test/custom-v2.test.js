import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {defaultCustom,checkCustom,customScore,CUSTOM_CAPACITIES} from '../shared/custom.js';
import {Match} from '../server/match/Match.js';
import {VirtualScheduler} from '../server/match/scheduler.js';
import {GameData} from '../server/match/gamedata.js';
import {DATA} from './match/harness.js';
import {FakeBattle} from './match/fakeBattle.js';
import {awardFate,decorateBattle} from '../server/match/custom.js';
import {startServer} from '../server/index.js';
import {TestClient} from './helpers/wsClient.js';
import {CONTRACT_PATHS} from '../public/js/ui/customContracts.js';
import {generateDraft} from '../server/match/choices.js';
import {createRng} from '../server/sim/rng.js';
function match(c={},n=4){const scheduler=new VirtualScheduler();const m=new Match({mode:'custom',difficulty:'NORMAL',seed:23,data:DATA,customConfig:{...defaultCustom(),...c},seats:Array.from({length:n},(_,seat)=>({seat,playerId:`p${seat}`,name:`P${seat}`,connected:true})),scheduler,BattleClass:FakeBattle,send(){},broadcast(){},onEnd(){}});return {m,scheduler};}
test('v2 capacities are discrete; v1 records remain readable with fate disabled',()=>{assert.deepEqual(CUSTOM_CAPACITIES,[1,4,5,6]);for(const capacity of CUSTOM_CAPACITIES)assert.ok(checkCustom({...defaultCustom(),capacity}));for(const capacity of [0,2,3,7])assert.equal(checkCustom({...defaultCustom(),capacity}),null);const c=checkCustom({version:1,capacity:4});assert.equal(c.version,1);assert.equal(c.fateWager,false);assert.equal(Object.keys(CONTRACT_PATHS).length,10);});
test('required bond limits are enforced on live configs, while stored legacy configs remain readable',()=>{const core=Object.keys(DATA.bonds).filter(id=>DATA.bonds[id].isCore&&DATA.bonds[id].weight>0),addon=Object.keys(DATA.bonds).filter(id=>!DATA.bonds[id].isCore&&DATA.bonds[id].weight>0);assert.ok(checkCustom({...defaultCustom(),requiredBonds:[...core.slice(0,2),addon[0]]},DATA.bonds));for(const requiredBonds of [core.slice(0,3),addon.slice(0,2),[...core.slice(0,2),...addon.slice(0,2)]])assert.equal(checkCustom({...defaultCustom(),requiredBonds},DATA.bonds),null);assert.ok(checkCustom({...defaultCustom(),version:1,requiredBonds:[...core,...addon]},null,{legacy:true}));assert.equal(checkCustom({...defaultCustom(),version:1,requiredBonds:[...core,...addon]},DATA.bonds),null);});
test('six-player beacons use grant round, so only the R14 reward transfers immediately even when used later',()=>{
  for(const grantRound of [10,12,14]){const {m}=match({extraRounds:true},6);m.phase='PREP';m.round=15;const p=m.order[0],original=m.gd.goldenIdOf(m.gd.visibleChess.find(id=>m.gd.chess(id)?.tier===3));const target=p.acquireChess(original),item=p.acquireItem('chess_item_5_04_e_a',{system:true,customBeaconRound:grantRound});assert.equal(p.pieceView(item).meta.customBeaconRound,grantRound);assert.ok(p.equip(item.uid,target.uid).ok);const received=m.order.slice(1).flatMap(p=>[...p.hand,...p.temp]).filter(x=>x?.id===original).length;if(grantRound===14){assert.equal(received,1);assert.equal(p.effects.filter(e=>e.key==='effect:builtin_gift').length,0);}else{assert.equal(received,0);assert.equal(p.effects.filter(e=>e.key==='effect:builtin_gift').length,1);}m.dispose();}
});
test('five/six-player extra bounty cards retain actual I/II/II targets even when the base six already use them',()=>{
  for(const n of [5,6]){const {m}=match({},n),choices=m.gd.choices;Object.defineProperty(m.gd,'choices',{value:{...choices,schedule:{...choices.schedule,[m.modeId]:{rounds:{9:{families:[{family:'bounty',weight:1}],cards:6,bountyDraft:'boss'}}}}}});for(let seed=0;seed<40;seed++){const d=generateDraft(m.gd,createRng(seed),9);assert.equal(d.cards.length,9);for(const [i,c]of d.cards.slice(6).entries()){const source=choices.cards.bounty.find(b=>b.effectId===c.id);assert.equal(source.tier,[1,2,2][i]);assert.equal(c.coin,[1,2,2][i]);assert.equal(c.enemyKey,source.enemyKey);}}m.dispose();}
});
test('one to six participants select their native enemy baseline and preserve custom rounds',()=>{
  for(let n=1;n<=6;n++){const {m}=match({},n),native=new GameData(DATA,`mode_${n===1?'single':'multi'}_normal`);assert.equal(m.initialPlayerCount,n);assert.equal(m.baselineKind,n===1?'single':'multi');for(const r of [1,8,14])assert.deepEqual(m.gd.enemyScale(r),native.enemyScale(Math.min(r,n===1?native.lastRound:r)));assert.equal(m.gd.bossRound,14);m.dispose();}
});
test('fate scoring is versioned and whitebird cannot affect its factor',()=>{const c={...defaultCustom(),fateWager:true};const a=customScore(c,'NORMAL');assert.equal(a.version,3);assert.ok(a.score<400);assert.equal(a.factors.find(f=>f.key==='fateWager').factor,(28/(28+7))**.35);for(const oneLife of [false,true])for(const tourist of [false,true])for(const wildfire of [false,true]){const v={...c,oneLife,tourist,wildfire};assert.deepEqual(customScore({...v,whitebird:true},'NORMAL'),customScore(v,'NORMAL'));}});
test('fate grants once to living players including a zero-life tourist, never revives dead players',()=>{const {m}=match({fateWager:true,tourist:true});m.round=2;m.order[3].eliminate(1);m.order[0].lp=0;const ids=m.alivePlayers().map(p=>p.playerId);m.lastResults=new Map(ids.map(id=>[id,{perfect:true,leaked:[]}]));const lives=m.order.map(p=>p.lp);assert.equal(awardFate(m,ids),true);assert.equal(m.order[0].lp,1);assert.equal(m.order[1].lp,lives[1]+1);assert.equal(m.order[3].alive,false);assert.equal(awardFate(m,ids),false);m.dispose();});
test('fate refuses leaks, missing players, synthetic results and failures',()=>{for(const kind of ['leak','missing','synthetic','failed']){const {m}=match({fateWager:true},2);m.round=1;const ids=['p0','p1'];m.lastResults=new Map(ids.map(id=>[id,{perfect:true,leaked:[]}]));if(kind==='leak')m.lastResults.get('p0').leaked=[{counted:true}];if(kind==='missing')m.lastResults.delete('p1');if(kind==='synthetic')m.lastResults.get('p0').synthetic=true;assert.equal(awardFate(m,ids,kind!=='failed'),false);m.dispose();}});
test('zero-life tourists contribute minus ten at boss merge and nonpositive totals lose immediately',()=>{for(const lp of [0,10,12]){const {m,scheduler}=match({tourist:true},2);m.startRound(14);m.order[0].lp=lp;m.order[1].lp=0;m.startFinalAssault(false);assert.equal(m.teamLp,lp===0?-20:lp-10);if(lp<=10){assert.equal(m.ended,true);assert.equal(m.outcome.victory,false);}else{assert.equal(m.ended,false);m._teamLpLoss(2);m._bossTick(m.runner);scheduler.advance(20000);assert.equal(m.ended,true);assert.equal(m.outcome.victory,false);}m.dispose();}});
test('hidden war removes public and private previews while live battle identity remains usable',()=>{const {m}=match({hiddenWar:true});m.start();let v=m.publicView();assert.equal(v.hiddenWar,true);assert.deepEqual(v.disabledBonds,[]);assert.deepEqual(v.factions,[]);assert.equal(v.bossId,null);m.startRound(14);assert.deepEqual(m.nextEnemiesFor(m.order[0]),[]);assert.deepEqual(m.prepFieldMeta(m.order[0]).nextEnemies,[]);v=m.publicView();assert.equal(v.bossId,null);m.phase='FINAL_ASSAULT';assert.ok(m.publicView().bossId);m.dispose();});
test('debt preserves future boss reinforcements, excludes bodies and does not multiply twice',()=>{const {m}=match({debt:true,enemyCount:200});m.order[3].eliminate(2);m.startRound(14);m.order[0].lp=30;m.order[1].lp=10;m.order[2].lp=20;const opts={kind:'boss',spawns:[],players:[{playerId:'p0',side:'L'},{playerId:'p1',side:'R'}],flags:{}};const o=decorateBattle(m,opts);assert.ok(o.spawns.length>0);assert.ok(o.spawns.every(s=>s.tag!=='boss'&&s.tag!=='part'&&s.sourcePlayerId==='p3'&&s.ownerPlayerId==='p0'));assert.deepEqual(decorateBattle(m,opts).spawns,o.spawns);m.dispose();});
test('fate boss payout follows merged life shares and survives a second sync without another reward',()=>{
  const {m}=match({fateWager:true,tourist:true},2);m.startRound(14);m.order[0].lp=12;m.order[1].lp=0;m.startFinalAssault(false);assert.equal(m.teamLp,2);m.bossPool.hp=0;
  m._finishFinal(false,f=>({perPlayer:Object.fromEntries(f.players.map(id=>[id,{perfect:true,leaked:[],coins:0,killed:0,damageDealt:0}])),errors:0}));
  assert.deepEqual(m.order.map(p=>p.lp),[3,1]);assert.equal(m.teamLp,4);m._syncTeamLp();assert.deepEqual(m.order.map(p=>p.lp),[3,1]);assert.equal(awardFate(m,['p0','p1']),false);m.dispose();
});
test('debt continues in every later normal round and highest life can change between rounds',()=>{
  const {m}=match({debt:true,enemyCount:200});m.order[3].eliminate(1);
  for(const round of [2,7,13]){m.startRound(round);m.order[0].lp=round===7?10:30;m.order[1].lp=round===7?30:10;m.order[2].lp=5;const id=round===7?'p1':'p0';const a=decorateBattle(m,{kind:'normal',spawns:[],players:[{playerId:id}],flags:{}});assert.equal(a.spawns.reduce((n,s)=>n+s.count,0),m.wave.spawns.reduce((n,s)=>n+(s.count??1),0)*2);assert.ok(a.spawns.every(s=>s.sourcePlayerId==='p3'));}m.dispose();
});
test('custom invitation and transition are atomic; full targets preserve party and stale sources fail',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sp-custom-v2-')),server=await startServer({port:0,quiet:true,profileDir:dir}),clients=[];
  const open=async(name)=>{const c=await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`);clients.push(c);c.welcome=await c.hello(name);return c;};
  const session=c=>server.registry.byId(c.welcome.playerId);
  try{const a=await open('VTwoA#0001'),b=await open('VTwoB#0001');await a.request({t:'room.create',mode:'custom',difficulty:'NORMAL'});const room=server.lobby.roomOf(session(a));await a.request({t:'social.add',identity:'VTwoB#0001'});assert.equal((await a.request({t:'social.invite',identity:'VTwoB#0001'})).t,'ok');const invitation=await b.waitFor('social.invite');
    const parties=server.lobby.matchmakingService.parties,p=parties.ensure(session(b),'NORMAL'),source={roomCode:null,roomRevision:0,partyId:p.id,partyRevision:p.revision};
    const config={...room.custom,capacity:1};assert.equal(server.lobby.setCustom(session(a),{config,name:room.customName,revision:room.customRevision}).ok,true);
    assert.equal((await b.request({t:'social.inviteRespond',inviteId:invitation.inviteId,accept:true,replaceCurrent:true,source})).t,'error');assert.equal(parties.of(session(b)),p);
    server.lobby.setCustom(session(a),{config:{...config,capacity:4},name:room.customName,revision:room.customRevision});
    const bad={...source,partyRevision:source.partyRevision+1};assert.equal((await b.request({t:'social.inviteRespond',inviteId:invitation.inviteId,accept:true,replaceCurrent:true,source:bad})).code,'MATCH_STALE');assert.equal(parties.of(session(b)),p);
    assert.equal((await b.request({t:'social.inviteRespond',inviteId:invitation.inviteId,accept:true,replaceCurrent:true,source})).t,'ok');assert.equal(server.lobby.roomOf(session(b)),room);assert.equal(parties.of(session(b)),null);
    server.lobby.setCustom(session(a),{config:{...room.custom,capacity:6},name:room.customName,revision:room.customRevision});server.lobby.chooseSeat(session(b),{seat:5,revision:room.customRevision});server.lobby.ready(session(b),{ready:true});assert.equal(server.lobby.setCustom(session(a),{config:{...room.custom,capacity:4},name:room.customName,revision:room.customRevision}).ok,true);assert.equal(room.seats[1].playerId,b.welcome.playerId);assert.equal(room.seats[1].ready,false);
    server.lobby.chooseSeat(session(b),{seat:3,revision:room.customRevision});const small=server.lobby.setCustom(session(a),{config:{...room.custom,capacity:1},name:room.customName,revision:room.customRevision});assert.ok(small.error);server.lobby.leave(session(b));assert.equal(server.lobby.setCustom(session(a),{config:{...room.custom,capacity:1},name:room.customName,revision:room.customRevision}).ok,true);
  }finally{await Promise.all(clients.map(c=>c.close()));await server.close();fs.rmSync(dir,{recursive:true,force:true});}
});


