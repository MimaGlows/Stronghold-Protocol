import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {instanceScript} from '../server/http/instanceProfile.js';
class Storage{constructor(values={}){Object.assign(this,values);}getItem(k){return this[k]??null;}setItem(k,v){this[k]=String(v);}removeItem(k){delete this[k];}}
test('three installations share code while retaining independent browser profiles',()=>{
  for(const [name,namespace,experimental]of [['Stronghold-Protocol-3000','sp',false],['Stronghold-Protocol-3001','sp.3001',false],['Stronghold-Protocol-Matchmaking','sp.matchmaking',true]]){const ctx={localStorage:new Storage(),sessionStorage:new Storage()};vm.runInNewContext(instanceScript('/workspace/'+name),ctx);assert.equal(ctx.__SP_INSTANCE__.namespace,namespace);assert.equal(ctx.__SP_INSTANCE__.experimental,experimental);}
});
test('3001 migration is origin-local, preserves newer choices, and never resurrects cleared sessions',()=>{
  const ctx={localStorage:new Storage({'sp.name':'Legacy#1234','sp.pref.settings':'legacy','sp.3001.pref.settings':'current'}),sessionStorage:new Storage({'sp.entered':'1','sp.token':'old-token'})};
  const code=instanceScript('/workspace/Stronghold-Protocol-3001');vm.runInNewContext(code,ctx);assert.equal(ctx.localStorage.getItem('sp.3001.name'),'Legacy#1234');assert.equal(ctx.localStorage.getItem('sp.3001.pref.settings'),'current');assert.equal(ctx.sessionStorage.getItem('sp.3001.entered'),'1');ctx.sessionStorage.removeItem('sp.3001.entered');ctx.sessionStorage.removeItem('sp.3001.token');vm.runInNewContext(code,ctx);assert.equal(ctx.sessionStorage.getItem('sp.3001.entered'),null);assert.equal(ctx.sessionStorage.getItem('sp.3001.token'),null);
});
test('blocked storage cannot prevent the profile bootstrap from completing',()=>{
  const ctx={};Object.defineProperty(ctx,'localStorage',{get(){throw Error('blocked');}});Object.defineProperty(ctx,'sessionStorage',{get(){throw Error('blocked');}});vm.runInNewContext(instanceScript('/workspace/Stronghold-Protocol-3001'),ctx);assert.equal(ctx.__SP_INSTANCE__.namespace,'sp.3001');
});
