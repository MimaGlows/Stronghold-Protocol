import {test} from 'node:test';
import assert from 'node:assert/strict';
import {matchingTransition,installMatchingPresentation,matchingPresentation} from '../../public/js/ui/matchingPresentation.js';
import {store} from '../../public/js/store.js';
import {audio} from '../../public/js/audio.js';

const account=(phase,attemptId='try1')=>({identity:'甲#0001',party:phase ? {id:'party1',phase,attemptId,members:[]} : null});
test('matching presentation distinguishes confirmed success, cancel, leave and resync',()=>{
  assert.deepEqual(matchingTransition(account('idle',null),account('searching')),{kind:'start',id:'try1'});
  assert.equal(matchingTransition(account('searching'),account('extended')),null);
  assert.equal(matchingTransition(account('searching'),account('searching')),null);
  assert.deepEqual(matchingTransition(account('searching'),account('playing',null)),{kind:'success',id:'try1'});
  assert.deepEqual(matchingTransition(account('extended'),account('backfilled')),{kind:'success',id:'try1'});
  assert.deepEqual(matchingTransition(account('searching'),account('idle',null)),{kind:'end',id:'try1'});
  assert.deepEqual(matchingTransition(account('idle',null),account(null)),{kind:'leave',id:'party1'});
  assert.equal(matchingTransition(account('playing',null),account(null)),null);
  assert.equal(matchingTransition(account('searching'),{...account(null),identity:'乙#0002'}),null);
});
test('one native cue per attempt, no timer/settings replay, success outlives route changes',t=>{
  const saved=store.get(),sfx=audio.sfx,calls=[];audio.sfx=name=>calls.push(name);
  store.set({matching:account('idle',null)});
  const off=installMatchingPresentation();t.after(()=>{off();audio.sfx=sfx;store.set(saved);matchingPresentation.set({success:null});});
  store.set({matching:account('searching')});store.set({matching:account('searching')});
  store.set({room:{seats:[{playerId:'a',name:'甲'},{playerId:'b',name:'乙'}]}});
  store.set({matching:account('extended')});store.set({matching:account('playing',null)});
  store.set({matching:account('playing',null)});
  assert.deepEqual(calls,['start','matchSucceed']);assert.equal(matchingPresentation.get().success.members.length,2);
  store.set({matching:account('idle',null)});store.set({matching:account('searching','try2')});store.set({matching:account('idle',null)});store.set({matching:account('idle',null)});
  assert.deepEqual(calls,['start','matchSucceed','start','matchCancel']);
  store.set({matching:account('searching','try3')});store.set({matching:account('backfilled','try3')});
  store.set({matching:account('idle',null)});store.set({matching:account(null)});
  assert.deepEqual(calls.slice(-2),['start','matchSucceed'],'backfill cleanup does not play a cancel after success');
  const before=calls.length;store.set({matching:{...account('idle',null),identity:'乙#0002'}});
  assert.equal(calls.length,before);assert.equal(matchingPresentation.get().success,null,'account switch clears previous feedback');
});
