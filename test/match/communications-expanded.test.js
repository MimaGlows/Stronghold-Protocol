import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, give, chessOfTier } from './harness.js';
import { PHASE } from '../../shared/constants.js';
import { validateC2S } from '../../shared/protocol.js';
function fixture(t){const h=makeMatch({humans:2,mode:'coop',fake:true}).start().toPrep(1);t.after(()=>h.m.dispose());const m=h.m,me=h.ps('p_0'),other=h.ps('p_1');return {h,m,me,other,send:q=>{me.communicationTimes=[];return m.handle(me.playerId,{t:'g.ping',round:m.round,phase:m.phase,target:q});}};}

test('sold-out shared equipment cannot be pinged as an available choice',t=>{
  const {m,me,send}=fixture(t);m.phase=PHASE.SP_DRAFT;
  const id=Object.keys(m.gd.raw.items).find(id=>Number.isFinite(m.itemPool.cap(id)));
  assert.ok(id);
  m.sp={family:'shop',cards:[{idx:0,id,kind:'item',name:'equipment'}],taken:{},picks:{},order:[me.playerId],idx:0};
  const q={kind:'choice',playerId:me.playerId,idx:0};assert.deepEqual(send(q),{ok:true});
  const available=m.itemPool.canGain.bind(m.itemPool);m.itemPool.canGain=item=>item===id?false:available(item);
  assert.equal(send(q).error,'BAD_TARGET');assert.deepEqual(m.sp.picks,{});
});
test('all visible choice families are intentions, never card selection, with stale choices rejected',t=>{
  const {m,me,other,send,h}=fixture(t);m.phase=PHASE.SP_DRAFT;
  for(const family of ['bounty','supply','shop','tactic']){
    m.sp={family,cards:[{idx:0,id:'choice_'+family,name:'候选'+family}],taken:{},picks:{},order:[other.playerId,me.playerId],idx:0};
    const before=JSON.stringify(m.sp),q={kind:'choice',playerId:me.playerId,idx:0};assert.equal(validateC2S({t:'g.ping',round:m.round,phase:m.phase,target:q}),null);
    assert.deepEqual(send(q),{ok:true});assert.equal(JSON.stringify(m.sp),before);assert.equal(h.lastBc('m.communication').display.name,'候选'+family);
    m.sp.taken[0]=other.playerId;assert.equal(send(q).error,'WRONG_PHASE');
  }
  m.phase=PHASE.PREP;me.personalChoice={id:'personal_1',round:m.round,cards:[{idx:0,id:'tactic',name:'个人机变'}]};
  assert.deepEqual(send({kind:'choice',playerId:me.playerId,idx:0,choiceId:'personal_1'}),{ok:true});
  assert.equal(send({kind:'choice',playerId:me.playerId,idx:0,choiceId:'old'}).error,'WRONG_PHASE');
});
test('combat operator target validates battle, ownership and observed field, without accepting coordinates',t=>{
  const {m,me,other,send,h}=fixture(t),id=chessOfTier(1)[0],piece=give(m,other,id,'board',[9,2]);
  m.phase=PHASE.COMBAT;m.fields=[{fieldId:'n:'+other.playerId,battleId:'battle_1',kind:'normal',players:[other.playerId],spec:{players:[{playerId:other.playerId,units:[{uid:piece.uid,chessId:id,kind:'op'}]}]}}];
  const q={kind:'battle-piece',playerId:other.playerId,uid:piece.uid,battleId:'battle_1'};
  assert.equal(send(q).error,'BAD_TARGET');m.watchers.set(me.playerId,m.fields[0].fieldId);
  assert.deepEqual(send(q),{ok:true});assert.equal(h.lastBc('m.communication').location.uid,piece.uid);
  assert.equal(send({...q,battleId:'old'}).error,'BAD_TARGET');assert.equal(send({...q,playerId:me.playerId}).error,'BAD_TARGET');
  assert.ok(validateC2S({t:'g.ping',round:m.round,phase:m.phase,target:{...q,x:2}}));
});
test('strategy intention is accepted while another player has the turn and changes no focus/pick',t=>{
  const {m,me,other,send}=fixture(t);m.phase=PHASE.BAND_DRAFT;m.draft={picks:{},order:[other.playerId,me.playerId],idx:0};
  m.round=0;
  const band=m.gd.bandIds().find(id=>!m.bandTaken(id,me.playerId)),before=JSON.stringify(m.draft);
  assert.equal(validateC2S({t:'g.ping',round:0,phase:m.phase,target:{kind:'band-offer',playerId:me.playerId,bandId:band}}),null);
  assert.deepEqual(send({kind:'band-offer',playerId:me.playerId,bandId:band}),{ok:true});assert.equal(JSON.stringify(m.draft),before);
});
