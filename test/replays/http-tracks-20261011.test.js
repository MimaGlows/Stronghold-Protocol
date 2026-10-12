import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';import WebSocket from 'ws';import {once} from 'node:events';import {startServer} from '../../server/index.js';
test('HTTP chunk index/fragment retains capabilities; 70 KiB Cookie HTTP and WS work, >64 KiB WS closes',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sp-tracks-http-')),s=await startServer({host:'127.0.0.1',port:0,quiet:true,replayDir:dir});let ws;
  t.after(async()=>{ws?.terminate();await s.close();fs.rmSync(dir,{recursive:true,force:true});});
  const r={v:1,id:randomUUID(),key:'a'.repeat(48),status:'ready',version:'old-ui',participants:[],nodes:[],events:[],pauses:[],publicTrack:[],communications:[],fields:[{id:'test',fieldId:'n:p',at:0,speed:1,players:['p'],spec:{v:1},meta:{units:[]},frames:[{gt:0,snap:{units:[]},ev:[]}]}]};s.replays.write(r);
  let response=await fetch(s.url+'/api/shared-replays/'+r.shareCode+'?tracks=1');assert.equal(response.status,200);const index=await response.json();assert.equal(index.key,undefined);assert.equal(index.fields[0].frames,undefined);assert.equal(index.fields[0].chunks.length,1);
  response=await fetch(s.url+'/api/shared-replays/'+r.shareCode+'?tracks=1&field=0&chunk=0');assert.equal(response.status,200);assert.equal((await response.json()).frames.length,1);
  assert.equal((await fetch(s.url+'/api/replays/'+r.id+'?tracks=1')).status,404);
  assert.equal((await fetch(s.url+'/api/shared-replays/'+r.shareCode+'?tracks=1&field=0&chunk=999')).status,404);
  const cookie='avatar-test='+ 'a'.repeat(70*1024);assert.equal((await fetch(s.url+'/healthz',{headers:{Cookie:cookie}})).status,200);
  ws=new WebSocket(`ws://127.0.0.1:${s.port}/ws`,{headers:{Cookie:cookie}});await once(ws,'open');
  const welcome=new Promise(resolve=>ws.on('message',raw=>{const m=JSON.parse(raw);if(m.t==='welcome')resolve(m);}));ws.send(JSON.stringify({t:'hello',name:'大Cookie验收#0001',rid:1}));assert.equal((await welcome).t,'welcome');
  const closed=once(ws,'close');ws.send('a'.repeat(65537));assert.equal((await closed)[0],1009);
});
