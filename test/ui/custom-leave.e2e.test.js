import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startServer} from '../../server/index.js';
const chrome=process.env.CHROME_PATH,enabled=process.env.SP_CUSTOM_E2E==='1'&&chrome&&fs.existsSync(chrome);
const request=(p,t,fields={})=>p.evaluate(({t,fields})=>globalThis.__SP__.net.request(t,fields),{t,fields});
const state=p=>p.evaluate(()=>globalThis.__SP__.store.get());
test('custom leave: failed request retains room, guests and spectators return to lobby, host migrates, stale departure clears',{skip:!enabled,timeout:60000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sp-custom-leave-'));
  const server=await startServer({port:0,host:'127.0.0.1',quiet:true,profileDir:dir,matchmakingDir:path.join(dir,'matching'),replayDir:path.join(dir,'replays')});
  const browser=await(await import('puppeteer-core')).default.launch({executablePath:chrome,headless:true,args:['--no-first-run']});
  const pages=[],errors=[];
  t.after(async()=>{await browser.close();await server.close();fs.rmSync(dir,{recursive:true,force:true});});
  for(const name of ['LeaveHost#0001','LeaveGuest#0001','LeaveObserver#0001']){
    const p=await(await browser.createBrowserContext()).newPage();pages.push(p);p.on('pageerror',e=>errors.push(e.message));await p.setViewport({width:1440,height:900});await p.goto(server.url,{waitUntil:'networkidle2'});
    await p.type('input[name=doctor-name]',name.split('#')[0]);await p.click('.title-login .btn--primary');await p.waitForSelector('.lobby-screen');
  }
  const [a,b,c]=pages;await request(a,'room.create',{mode:'custom',difficulty:'NORMAL'});const code=(await state(a)).room.code;
  await request(b,'room.join',{code});await b.waitForSelector('.custom-room');await request(c,'room.spectate',{code});await c.waitForSelector('.custom-room');
  const guest=server.registry.byId((await state(b)).me.playerId),observer=server.registry.byId((await state(c)).me.playerId),room=server.lobby.roomOf(guest);
  const leave=server.lobby.leave.bind(server.lobby);let reject=true,requests=0;
  server.lobby.leave=s=>{if(s===guest){requests++;if(reject)return {error:'RATE'};}return leave(s);};
  await b.click('.custom-room__header button');await b.waitForFunction(()=>document.querySelector('.toast'));
  assert.equal(requests,1);assert.equal((await state(b)).room.code,code);assert.equal(server.lobby.roomOf(guest),room);
  reject=false;await b.click('.custom-room__header button');await b.waitForSelector('.lobby-screen',{timeout:5000});
  assert.equal((await state(b)).room,null);assert.equal(server.lobby.roomOf(guest),null);assert.equal(room.activeHumans().length,1);
  const evidence=path.resolve('test/e2e/out/custom-leave');fs.mkdirSync(evidence,{recursive:true});await b.screenshot({path:path.join(evidence,'guest-returned-to-lobby.png')});await a.screenshot({path:path.join(evidence,'host-room-after-guest-left.png')});
  await c.click('.custom-room__header button');await c.waitForSelector('.lobby-screen',{timeout:5000});assert.equal(server.lobby.roomOf(observer),null);assert.equal(room.spectators.length,0);
  await request(b,'room.join',{code});await b.waitForSelector('.custom-room');await a.click('.custom-room__header button');await a.waitForSelector('.lobby-screen',{timeout:5000});assert.equal(room.hostId,guest.playerId);
  // Another window / server cleanup can complete a departure before this page's request.
  leave(guest);assert.equal(server.lobby.rooms.has(code),false);await b.click('.custom-room__header button');await b.waitForSelector('.lobby-screen',{timeout:5000});assert.equal((await state(b)).room,null);
  assert.deepEqual(errors,[]);
});
