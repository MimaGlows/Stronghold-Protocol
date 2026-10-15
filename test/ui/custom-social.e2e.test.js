import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startServer} from '../../server/index.js';
const chrome=process.env.CHROME_PATH,enabled=process.env.SP_CUSTOM_E2E==='1'&&chrome&&fs.existsSync(chrome);
const OUT=path.resolve('test/e2e/out/custom-v2');
const state=p=>p.evaluate(()=>globalThis.__SP__.store.get());
const request=(p,t,fields={})=>p.evaluate(({t,fields})=>globalThis.__SP__.net.request(t,fields),{t,fields});
async function click(p,selector,text){for(const h of await p.$$(selector))if((await h.evaluate(e=>e.textContent.trim()))===text){await h.click();return;}throw new Error(`Missing ${text}`);}
test('custom friends: confirmed switch, failed join keeps source, observers and real 5Hz interpolation',{skip:!enabled,timeout:120000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sp-custom-social-'));
  const server=await startServer({port:0,host:'127.0.0.1',quiet:true,profileDir:dir,matchmakingDir:path.join(dir,'matching'),replayDir:path.join(dir,'replays')});
  const browser=await(await import('puppeteer-core')).default.launch({executablePath:chrome,headless:true,args:['--no-first-run','--disable-renderer-backgrounding']});
  const pages=[],errors=[];let recording;
  fs.mkdirSync(OUT,{recursive:true});
  t.after(async()=>{if(recording)await recording.stop();if(!t.passed)for(const [i,p]of pages.entries())await p.screenshot({path:path.join(OUT,`social-failure-${i}.png`)});await browser.close();await server.close();fs.rmSync(dir,{recursive:true,force:true});});
  for(const name of ['VTwoHost#0001','VTwoGuest#0001','VTwoObserver#0001']){
    const p=await(await browser.createBrowserContext()).newPage();pages.push(p);p.on('pageerror',e=>errors.push(e.message));await p.setViewport({width:1440,height:900});await p.goto(server.url,{waitUntil:'networkidle2'});
    await p.evaluate(name=>globalThis.__SP__.net.setName(name),name);await p.waitForFunction(name=>{const s=globalThis.__SP__.store.get();return `${s.me.name}#${s.me.doctorCode}`===name&&globalThis.__SP__.net.status==='online';},{},name);await p.evaluate(()=>globalThis.__SP__.store.patch('session',{entered:true}));await p.waitForSelector('.friends-handle');
  }
  const [a,b,c]=pages;
  await request(a,'social.add',{identity:'VTwoGuest#0001'});await request(b,'social.add',{identity:'VTwoHost#0001'});await request(c,'social.add',{identity:'VTwoHost#0001'});
  await request(a,'room.create',{mode:'custom',difficulty:'NORMAL'});await a.waitForSelector('.custom-room');const code=(await state(a)).room.code;
  await request(b,'room.create',{mode:'coop',difficulty:'FUNNY'});await b.waitForSelector('.room-screen');const source=(await state(b)).room.code;
  await a.bringToFront();await a.click('.friends-handle');await a.waitForFunction(()=>getComputedStyle(document.querySelector('.friends-panel')).transform==='matrix(1, 0, 0, 1, 0, 0)');await click(a,'.friend-row button','邀请');await b.waitForSelector('.social-invite-layer');await b.bringToFront();await b.click('.social-invite-layer .btn--primary');await b.waitForFunction(()=>document.body.innerText.includes('确认切换'));
  assert.equal((await state(b)).room.code,source);await b.screenshot({path:path.join(OUT,'09-switch-confirmation.png')});
  // Target changes while the confirmation is open: no destructive source detach.
  const host=server.registry.byId((await state(a)).me.playerId),room=server.lobby.roomOf(host);
  server.lobby.setCustom(host,{config:{...room.custom,capacity:1},name:room.customName,revision:room.customRevision});
  await click(b,'.modal__actions button','确认切换');await b.waitForFunction(()=>document.querySelector('.social-invite-layer .btn--primary')?.disabled===false);assert.equal((await state(b)).room.code,source);
  server.lobby.setCustom(host,{config:{...room.custom,capacity:4},name:room.customName,revision:room.customRevision});
  await b.click('.social-invite-layer .btn--primary');await b.waitForFunction(()=>document.body.innerText.includes('确认切换'));await click(b,'.modal__actions button','确认切换');await b.waitForFunction(code=>globalThis.__SP__.store.get().room?.code===code,{},code);
  await b.waitForSelector('.social-invite-layer',{hidden:true});assert.equal(server.lobby.rooms.get(source)?.activeHumans().length||0,0);
  await c.bringToFront();await c.click('.friends-handle');await c.waitForFunction(()=>getComputedStyle(document.querySelector('.friends-panel')).transform==='matrix(1, 0, 0, 1, 0, 0)');await c.waitForFunction(()=>[...document.querySelectorAll('.friend-row button')].some(e=>e.textContent.trim()==='观战'));await click(c,'.friend-row button','观战');await c.waitForFunction(code=>globalThis.__SP__.store.get().room?.code===code,{},code);assert.equal((await state(c)).room.spectators.length,1);
  await b.bringToFront();await b.click('.friends-handle');await b.waitForFunction(()=>getComputedStyle(document.querySelector('.friends-panel')).transform==='matrix(1, 0, 0, 1, 0, 0)');assert.ok(await b.$('.friend-row'));
  await request(b,'room.ready',{ready:true});await request(a,'room.start');await a.waitForSelector('.brief');const m=room.match;
  for(const p of [a,b])await request(p,'g.infoReady');await a.waitForFunction(()=>globalThis.__SP__.store.get().match.public?.phase==='BAND_DRAFT');
  while(m.phase==='BAND_DRAFT'){const id=m.draftTurn();if(!id)break;m.pickBand(m.players.get(id),m.defaultBand(id));}await a.waitForFunction(()=>globalThis.__SP__.store.get().match.public?.phase!=='BAND_DRAFT');m.startRound(2);
  await a.waitForFunction(()=>globalThis.__SP__.store.get().match.public?.phase==='PREP');
  await a.evaluate(async()=>{const {SnapshotBuffer}=await import('/js/render/interp.js');globalThis.__renderSamples=[];globalThis.__actualBuffer=null;const sample=SnapshotBuffer.prototype.sample;SnapshotBuffer.prototype.sample=function(...args){const value=sample.apply(this,args);globalThis.__actualBuffer=this;if(value.size&&globalThis.__renderSamples.length<2000)globalThis.__renderSamples.push({time:this.renderT,delay:this.delay,units:[...value].map(([id,u])=>({id,x:u.x,y:u.y})),snaps:this.snaps.map(s=>({t:s.t,units:[...s.units].map(([id,u])=>({id,x:u[1],y:u[2]}))}))});return value;};});
  await a.bringToFront();if(process.env.SP_CUSTOM_CAPTURE!=='0')recording=await a.screencast({path:path.join(OUT,'10-combat-interpolation.webm')});m.startCombat();
  await a.waitForFunction(()=>globalThis.__SP__.store.get().match.public?.phase==='COMBAT');
  await a.waitForFunction(()=>globalThis.__actualBuffer?.delay===.2&&new Set(globalThis.__renderSamples.map(s=>s.time)).size>=10&&globalThis.__renderSamples.some(s=>s.units.some(u=>s.snaps.length>=2&&s.snaps.every(snap=>!snap.units.some(v=>v.id===u.id&&v.x===u.x&&v.y===u.y)))),{timeout:20000});
  const samples=await a.evaluate(()=>globalThis.__renderSamples);assert.ok(samples.some(s=>s.snaps.length>=2));assert.ok(new Set(samples.map(s=>s.time)).size>=10);
  assert.ok(samples.some(s=>s.units.some(u=>s.snaps.length>=2&&s.snaps.every(snap=>!snap.units.some(v=>v.id===u.id&&v.x===u.x&&v.y===u.y)))),'actual rendered coordinates interpolate between snapshot positions');
  assert.equal((await state(a)).match.field.snapshotHz,5);await a.screenshot({path:path.join(OUT,'11-custom-combat.png')});fs.writeFileSync(path.join(OUT,'combat-interpolation.json'),JSON.stringify(samples,null,2));if(recording)await recording.stop();recording=null;
  m.finish({victory:false,reason:'duration_limit'});assert.equal(room.lastSummary.initialPlayerCount,2);assert.equal(room.lastSummary.baselineKind,'multi');assert.deepEqual(errors,[]);
});



