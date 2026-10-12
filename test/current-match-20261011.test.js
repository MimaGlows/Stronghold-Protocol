import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
test('custom continue discovers only actual current-account match; leave and server restart revoke it',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sp-current-'));let server=await startServer({host:'127.0.0.1',port:0,quiet:true,replayDir:dir}),client;
  t.after(async()=>{await client?.close();await server.close();fs.rmSync(dir,{recursive:true,force:true});});
  const active=async identity=>(await(await fetch(server.url+'/api/profiles/active-match?'+new URLSearchParams({identity}))).json()).active;
  client=await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`);await client.hello('当前博士#0001');assert.equal(await active('当前博士#0001'),false);
  await client.request({t:'room.create',mode:'solo',difficulty:'NORMAL'});await client.request({t:'room.start'});
  assert.equal(await active('当前博士#0001'),true);assert.equal(await active('当前博士#0002'),false);
  await client.request({t:'g.leave'});assert.equal(await active('当前博士#0001'),false);
  await client.request({t:'room.create',mode:'solo',difficulty:'NORMAL'});await client.request({t:'room.start'});assert.equal(await active('当前博士#0001'),true);
  await client.close();await server.close();server=await startServer({host:'127.0.0.1',port:0,quiet:true,replayDir:dir});assert.equal(await active('当前博士#0001'),false);
});
