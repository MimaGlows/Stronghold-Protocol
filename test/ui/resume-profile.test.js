import test from 'node:test';
import assert from 'node:assert/strict';
import { profileResumeItems, resumeProfile } from '../../public/js/ui/resumeProfile.js';

test('recovery offers only the current complete pseudoaccount, not other tokens or local archives', () => {
  assert.deepEqual(profileResumeItems('Doctor#0123', {code:'ABCD'}), [{id:'Doctor#0123',name:'Doctor#0123',code:'ABCD'}]);
  assert.deepEqual(profileResumeItems('Doctor', null), []);
  assert.deepEqual(profileResumeItems('Doctor#0123', null)[0].code, '');
});
test('recovery delegates to existing identity initialization and account entry', async () => {
  const item=profileResumeItems('Doctor#0123')[0],calls=[];
  const identity={loadName:()=>item.name,init:async()=>calls.push('init')};
  assert.equal(await resumeProfile(item,identity,name=>{calls.push(name);return true;}),true);
  assert.deepEqual(calls,['init','Doctor#0123']);
});
test('account changes while initializing invalidate the selected recovery', async () => {
  const item=profileResumeItems('Doctor#0123')[0];let name=item.name,entered=false;
  const identity={loadName:()=>name,init:async()=>{name='Doctor#4567';}};
  assert.equal(await resumeProfile(item,identity,()=>{entered=true;return true;}),false);
  assert.equal(entered,false);
});
