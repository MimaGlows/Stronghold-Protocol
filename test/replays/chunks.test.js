import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ReplayArchive } from '../../server/replays/archive.js';
import { createReplayCache, chunkAt } from '../../public/js/replay/chunks.js';
import { prepSnapshot } from '../../public/js/ui/prepSnapshot.js';
import { playbackCompatibility } from '../../server/replays/compatibility.js';

function record() {
  return {v:1,id:randomUUID(),key:'a'.repeat(48),version:'old-ui',status:'ready',startedAt:1,endedAt:2,durationMs:25000,errors:[],nodes:[],events:[],publicTrack:[],communications:[],pauses:[],fields:[{
    id:'battle_1',fieldId:'n:p',players:['p'],kind:'normal',at:0,speed:1,endGt:25,spec:{v:1,stageId:'stage',rect:{}},meta:{units:[{id:1,ownerId:'p',uid:5}]},
    frames:Array.from({length:251},(_,i)=>({gt:i/10,snap:{fieldId:'n:p',units:[[1,2,3,10,10,0,0,0,0]]},ev:i===30?[['spawn',{id:2,ownerId:'p',uid:6}]]:i===60?[['fx','form',2,3,{id:1,form:'alt'}]]:[]}))
  }]};
}
test('chunks preserve every frame, carry spawn/form state, authenticate and survive UI-only updates',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sp-chunks-')),a=new ReplayArchive(dir,{error(){}},{version:'new-ui'});
  t.after(async()=>{await a.close();fs.rmSync(dir,{recursive:true,force:true});});
  const r=record();a.write(r);const before=fs.readFileSync(a.file(r.id));
  assert.equal(a.get(r.id,'b'.repeat(48),{tracks:true}),null);
  const index=a.get(r.id,r.key,{tracks:true});assert.equal(index.status,'ready');assert.equal(index.key,undefined);
  assert.equal(index.fields[0].frames,undefined);assert.equal(index.fields[0].chunks.length,3);
  const frames=[];for(const c of index.fields[0].chunks){assert.ok(c.to-c.from<=10);assert.ok(c.bytes<=8*1024*1024);
    const part=a.get(r.id,r.key,{tracks:true,field:0,chunk:c.index});frames.push(...part.frames);
    if(c.index===1){assert.ok(part.meta.units.some(u=>u.id===2));assert.equal(part.restoreEvents[0][4].form,'alt');}
  }
  assert.deepEqual(frames,r.fields[0].frames);assert.deepEqual(fs.readFileSync(a.file(r.id)),before);
  assert.equal(a.get(r.id,r.key,{tracks:true,field:0,chunk:999}),null);
  assert.equal(chunkAt(index.fields[0],10),1);
  a.expire(r,'retention');assert.equal(fs.existsSync(path.join(dir,r.id+'.tracks')),false);
});
test('unsupported formats stay intact and reported incompatible, never version-expired',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sp-incompatible-')),a=new ReplayArchive(dir,{error(){}});
  t.after(async()=>{await a.close();fs.rmSync(dir,{recursive:true,force:true});});
  const r=record();r.fields[0].spec.v=2;a.write(r);const before=fs.readFileSync(a.file(r.id));
  assert.equal(a.get(r.id,r.key).status,'incompatible');assert.equal(a.get(r.id,r.key).incompatibilityReason,'field-schema');
  assert.deepEqual(fs.readFileSync(a.file(r.id)),before);assert.equal(playbackCompatibility(record()),null);
});
test('cache bounds, LRU eviction and cancellation cleanup; prep snapshot includes all units',()=>{
  const c=createReplayCache(20);c.put('a',{id:1},10);c.put('b',{id:2},10);c.get('a');c.put('c',{id:3},10);
  assert.equal(c.get('b'),null);assert.equal(c.stats().bytes,20);assert.throws(()=>c.put('d',{},21));c.clear();assert.equal(c.stats().bytes,0);
  const snap=prepSnapshot({fieldId:'n:p',units:[{id:1,x:3,y:9,maxHp:5},{id:2,x:4,y:8},null]});
  assert.deepEqual(snap.units.map(u=>u.slice(0,5)),[[1,3,9,5,5],[2,4,8,1,1]]);
});

test('legacy pending inputs cannot use the v0.2.4 engine while complete old frames remain playable', async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sp-generation-')),a=new ReplayArchive(dir,{error(){}});
  t.after(async()=>{await a.close();fs.rmSync(dir,{recursive:true,force:true});});
  assert.notEqual(a.simulationVersion,'acdd070fcac25c9c824d');
  assert.equal(a.generationCompatible({version:'4dc8f887537e1e9effeb'}),false);
  assert.equal(a.generationCompatible({simulationVersion:'acdd070fcac25c9c824d'}),false);
  assert.equal(a.generationCompatible({simulationVersion:a.simulationVersion}),true);
  const r=record();r.simulationVersion='acdd070fcac25c9c824d';a.write(r);
  assert.equal(a.get(r.id,r.key,{tracks:true}).status,'ready');
});
