import test from 'node:test';
import assert from 'node:assert/strict';
import {Match} from '../server/match/Match.js';
import {VirtualScheduler} from '../server/match/scheduler.js';
import {getData} from '../server/data.js';
import {defaultCustom,customScore} from '../shared/custom.js';
import {decorateBattle,captureWhitebird,customScoreContext} from '../server/match/custom.js';
import {makeBattle} from './helpers/battleHarness.js';
const DATA=getData();
function fixture(settings={}){return new Match({mode:'custom',difficulty:'NORMAL',seed:23,data:DATA,customConfig:{...defaultCustom(),...settings},seats:Array.from({length:4},(_,seat)=>({seat,playerId:`p${seat}`,name:`P${seat}`,connected:true})),scheduler:new VirtualScheduler(),send(){},broadcast(){},onEnd(){}});}
function killAndCount(spawns){const h=makeBattle({content:'none',units:[],enemies:[]});let expected=0;for(const s of spawns)for(let i=0;i<(s.count??1);i++){const e=h.b.spawnEnemy(s.enemyKey,{mods:s.mods,ownerPlayerId:'p1',bounty:s.bounty?{...s.bounty,ownerPlayerId:'p1'}:null});expected+=s.bounty?.coins||0;h.b.kill(e);h.b.kill(e);}assert.equal(h.b.result().perPlayer.p1.coins,expected);return expected;}
const opts=id=>({kind:'normal',spawns:[],players:[{playerId:id}],flags:{}});
test('both carnival pools pay every scaled elite once at 10%, 100%, 200% and 1000%',()=>{
  for(const count of [10,100,200,1000])for(const pool of ['initial','boss']){const m=fixture({carnival:true,enemyCount:count});m.startRound(pool==='initial'?1:9);m.carnivalPool=pool;const list=decorateBattle(m,opts('p0')).spawns;for(const s of list){assert.equal(DATA.enemies[s.enemyKey].rank,'ELITE');assert.ok(s.bounty.coins>0);assert.equal(s.mods.bountyCoins,s.bounty.coins);}assert.equal(killAndCount(list),list.reduce((n,s)=>n+s.count*s.bounty.coins,0));m.dispose();}
});
test('debt preserves scaled native and carnival bounties and pays the receiving battlefield',()=>{
  const m=fixture({carnival:true,debt:true,enemyCount:200});m.startRound(2);const card=m.gd.choices.cards.bounty.find(c=>c.draftPool==='initial'&&c.payout==='kill'&&DATA.enemies[c.enemyKey]?.rank==='ELITE');m.order[3].bounties=[{id:'debt-target',card:{...card,count:2},roundsLeft:3}];m.order[3].eliminate(1);m.order[0].lp=40;m.order[1].lp=20;m.order[2].lp=10;
  const list=decorateBattle(m,opts('p0')).spawns.filter(s=>s.sourcePlayerId==='p3'&&s.bounty);assert.ok(list.some(s=>s.mods.bountyId==='debt-target'));assert.ok(list.some(s=>s.mods.customCarnival));assert.ok(list.every(s=>s.bounty.ownerPlayerId==='p0'&&s.mods.bountyCoins===s.bounty.coins));assert.ok(killAndCount(list)>0);m.dispose();
});
test('whitebird preserves unpaid carnival and native bounties through repeated leaks without scaling twice',()=>{
  const m=fixture({carnival:true,whitebird:true,enemyCount:200});m.startRound(2);const card=m.gd.choices.cards.bounty.find(c=>c.draftPool==='initial'&&c.payout==='kill');m.order[0].bounties=[{id:'native-target',card,roundsLeft:1}];
  const carnival=decorateBattle(m,opts('p0')).spawns;const leaks=carnival.flatMap(s=>Array.from({length:s.count},()=>({enemyKey:s.enemyKey,mods:s.mods,counted:true,tag:'bounty'})));leaks.push({enemyKey:card.enemyKey,mods:{bountyId:'native-target'},counted:true,tag:'bounty'});m.lastResults=new Map([['p0',{leaked:leaks,coins:0}]]);captureWhitebird(m);m.order[0].bounties=[];
  for(const round of [13,18]){m.startRound(round);const list=decorateBattle(m,opts('p0')).spawns.filter(s=>s.mods?.whitebirdRound===2);assert.equal(list.length,leaks.length);assert.ok(list.every(s=>s.bounty?.coins>0));assert.ok(killAndCount(list)>0);m.lastResults=new Map([['p0',{leaked:list.map(s=>({enemyKey:s.enemyKey,mods:s.mods,counted:true,tag:'bounty'}))}]]);captureWhitebird(m);}
  m.round=18;m.whitebirdCapturedRound=null;m.lastResults=new Map([['p0',{leaked:[],coins:100}]]);captureWhitebird(m);assert.deepEqual(m.customBank,[]);m.dispose();
});
test('v3 income compensation preserves neutral baselines, pressure monotonicity and whitebird independence',()=>{
  const ctx=customScoreContext(DATA,'NORMAL',4);ctx.coreIds=new Set(ctx.coreIds);
  for(const [difficulty,score]of [['FUNNY',200],['NORMAL',400],['HARD',600],['ABYSS',800]])assert.equal(customScore(defaultCustom(),difficulty).score,score);
  const c={...defaultCustom(),carnival:true};assert.ok(customScore(c,'NORMAL',ctx).score<customScore(c,'NORMAL',{...ctx,modelVersion:2}).score);assert.ok(customScore(c,'NORMAL',ctx).bountyEstimate.carnival>0);
  let previous=0;for(const count of [10,50,100,200,500,1000]){const v={...c,enemyCount:count,debt:true,wildfire:true};const a=customScore(v,'NORMAL',ctx);assert.ok(a.score>previous);previous=a.score;assert.deepEqual(customScore({...v,whitebird:true},'NORMAL',ctx),a);}assert.equal(customScore(c,'NORMAL',ctx).version,3);
});
test('collected bounty coins join next preparation once and use the configured gold multiplier',()=>{
  const m=fixture({carnival:true,enemyCount:200,gold:500});m.startRound(1);for(const player of m.order)player.lp=28;const list=decorateBattle(m,opts('p0')).spawns,coins=killAndCount(list),p=m.order[0],before=p.funds;m.lastResults=new Map(m.order.map(p=>[p.playerId,{perfect:true,leaked:[],coins:p.playerId==='p0'?coins:0,killed:0,layerGains:{}}]));m.settle();assert.equal(p.pendingFunds,coins);p.startRound(2);assert.equal(p.funds-before,(m.gd.income(2)+coins)*5);assert.equal(p.pendingFunds,0);m.dispose();
});

