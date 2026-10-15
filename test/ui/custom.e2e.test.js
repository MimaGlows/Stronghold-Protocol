import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../../server/index.js';
const chrome=process.env.CHROME_PATH, enabled=process.env.SP_CUSTOM_E2E==='1'&&chrome&&fs.existsSync(chrome);
const OUT=path.resolve('test/e2e/out/custom-v2');
async function click(p,selector,text){for(const h of await p.$$(selector))if((await h.evaluate(e=>e.textContent.trim())).includes(text)){await h.click();return;}throw new Error(`Missing ${text}`);}
const state=p=>p.evaluate(()=>globalThis.__SP__.store.get());
const request=(p,t,fields={})=>p.evaluate(({t,fields})=>globalThis.__SP__.net.request(t,fields),{t,fields});
test('six browsers: custom room, six seats, settings, round start, spectators and timed result',{skip:!enabled,timeout:120000},async t=>{
  fs.mkdirSync(OUT,{recursive:true});const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sp-custom-browser-'));
  const browser=await(await import('puppeteer-core')).default.launch({executablePath:chrome,headless:true,args:['--no-first-run','--disable-renderer-backgrounding']});
  const server=await startServer({port:0,host:'127.0.0.1',quiet:true,profileDir:path.join(dir,'profiles'),matchmakingDir:path.join(dir,'matching'),replayDir:path.join(dir,'replays')});
  const pages=[],errors=[];let recording;
  t.after(async()=>{if(recording)await recording.stop();if(!t.passed)for(const [i,p]of pages.entries())await p.screenshot({path:path.join(OUT,`failure-${i}.png`)});await browser.close();await server.close();fs.rmSync(dir,{recursive:true,force:true});});
  for(let i=0;i<7;i++){
    const context=await browser.createBrowserContext(),p=await context.newPage();pages.push(p);p.on('pageerror',e=>errors.push(e.message));
    await p.setViewport({width:1440,height:900});await p.goto(server.url,{waitUntil:'networkidle2'});await p.type('input[name=doctor-name]',`CustomQA${i}`);await click(p,'.title-login .btn','开始');await p.waitForSelector('.lobby-screen');
  }
  const a=pages[0];await a.bringToFront();
  await a.evaluate(()=>{globalThis.__customMotion=[];const original=Element.prototype.animate;Element.prototype.animate=function(...args){const a=original.apply(this,args),e=this;requestAnimationFrame(()=>{if(!a.id.startsWith('custom-'))return;const row={id:a.id,samples:[]};globalThis.__customMotion.push(row);const sample=()=>{if(!e.isConnected||a.playState==='idle')return;row.samples.push({time:a.currentTime,transform:getComputedStyle(e).transform});if(row.samples.length<35&&a.playState!=='finished')requestAnimationFrame(sample);};sample();});return a;};});
  if(process.env.SP_CUSTOM_CAPTURE!=='0')recording=await a.screencast({path:path.join(OUT,'06-custom-motion.webm')});
  await click(a,'.mode-card','自订模拟');await a.screenshot({path:path.join(OUT,'00-three-modes.png')});await click(a,'.matching-create-box .btn--primary','创建自定房间');await a.waitForSelector('.custom-room');
  await a.waitForFunction(()=>globalThis.__customMotion.some(r=>r.id==='custom-room-enter'&&r.samples.length>=3));
  const code=(await state(a)).room.code;assert.equal(code.length,5);
  await a.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{globalThis.__copiedInvite=text;}}});});await click(a,'.invite__btns .btn','复制链接');assert.ok(await a.evaluate(code=>globalThis.__copiedInvite.includes(`?room=${code}`)&&globalThis.__copiedInvite.includes('【自订模拟】【自定房间】'),code));
  await click(a,'.custom-summary .btn','自定设置');await a.waitForSelector('.custom-settings');
  assert.equal((await a.$$('.custom-capacity [data-capacity]')).length,4);await a.click('[data-capacity="6"]');
  const required=await a.evaluate(()=>{const b=globalThis.__SP__.data.get('bonds');return [...Object.keys(b).filter(id=>b[id].weight>0&&b[id].isCore).slice(0,2),...Object.keys(b).filter(id=>b[id].weight>0&&!b[id].isCore).slice(0,1)];});for(const id of required){await a.$eval(`[data-required-bond="${id}"]`,e=>e.scrollIntoView({block:'center'}));await a.click(`[data-required-bond="${id}"]`);}assert.equal((await a.$$('.custom-bond-picker button[aria-pressed="true"]')).length,3);assert.equal((await a.$$('.custom-bond-picker button[aria-pressed="false"]:not(:disabled)')).length,0);await a.screenshot({path:path.join(OUT,'13-required-limit.png')});for(const id of required)await a.click(`[data-required-bond="${id}"]`);assert.equal((await a.$$('.custom-bond-picker button[aria-pressed="true"]')).length,0);
  await click(a,'.custom-settings .modal__actions .btn','保存设置');await a.waitForFunction(()=>globalThis.__SP__.store.get().room.capacity===6);
  await request(pages[1],'room.join',{code});await pages[1].waitForSelector('.custom-room');let r=(await state(pages[1])).room;await request(pages[1],'room.seat',{seat:5,revision:r.revision});
  await a.waitForFunction(()=>globalThis.__customMotion.some(r=>r.id==='custom-seat-move'&&r.samples.length>=3));
  for(const p of pages.slice(2,6)){await request(p,'room.join',{code});await p.waitForSelector('.custom-room');}
  await request(pages[6],'room.spectate',{code});await pages[6].waitForSelector('.custom-room');
  await a.waitForFunction(()=>globalThis.__SP__.store.get().room.seats.filter(Boolean).length===6);await a.screenshot({path:path.join(OUT,'01-six-seats.png')});
  await click(a,'.custom-summary .btn','自定设置');await click(a,'.custom-settings nav button','历战合约');
  const score=await a.$eval('.custom-score-preview strong',e=>e.textContent);assert.equal((await a.$$('.custom-contract-tile')).length,10);await a.click('[data-contract="whitebird"]');assert.equal(await a.$eval('.custom-score-preview strong',e=>e.textContent),score);
  assert.ok(await a.$eval('.custom-contract-detail',e=>e.textContent.includes('不影响难度系数')));await a.click('[data-contract="fateWager"]');await a.click('[data-contract="hiddenWar"]');await a.click('[data-contract="oneLife"]');await a.click('[data-contract="lastStand"]');assert.equal(await a.$eval('[data-contract="oneLife"]',e=>e.getAttribute('aria-pressed')),'false');await a.click('[data-contract="lastStand"]');await a.screenshot({path:path.join(OUT,'02-contracts.png')});
  await click(a,'.custom-settings .modal__actions .btn','保存设置');await a.waitForFunction(()=>globalThis.__SP__.store.get().room.custom.whitebird===true);
  assert.equal((await a.$$('[data-active-contract]')).length,3);await a.hover('[data-active-contract="fateWager"]');await a.waitForFunction(()=>document.querySelector('[role=tooltip]')?.textContent.includes('在所有玩家都完美通过'));await a.screenshot({path:path.join(OUT,'12-contract-tooltip.png')});await a.mouse.move(0,0);await a.screenshot({path:path.join(OUT,'08-active-contracts.png')});
  await a.setViewport({width:844,height:390});await a.waitForFunction(()=>matchMedia('(max-width:900px)').matches&&getComputedStyle(document.querySelector('.custom-room')).paddingLeft==='12px');await a.screenshot({path:path.join(OUT,'03-mobile.png')});
  await a.$eval('.custom-room__body',e=>{e.scrollTop=e.scrollHeight;});assert.ok(await a.$eval('.custom-observers',e=>{const r=e.getBoundingClientRect();return r.bottom<=window.innerHeight&&r.top>=0;}));
  await a.$eval('.custom-room__body',e=>{e.scrollTop=0;});await click(a,'.custom-summary .btn','自定设置');await click(a,'.custom-settings nav button','我方');await a.screenshot({path:path.join(OUT,'04-mobile-settings.png')});
  await a.$eval('.custom-field input[aria-label="干员重新部署时间"]',e=>e.scrollIntoView({block:'center'}));
  assert.ok(await a.$eval('.custom-field input[aria-label="干员重新部署时间"]',e=>{const r=e.getBoundingClientRect();return r.top>0&&r.bottom<window.innerHeight;}));
  await a.keyboard.press('Escape');await a.waitForSelector('.custom-settings',{hidden:true});assert.ok(await a.$eval('.custom-summary .btn',e=>e===document.activeElement));
  await click(a,'.custom-summary .btn','自定设置');await click(a,'.custom-settings nav button','我方');await click(a,'.custom-settings .modal__actions .btn','取消');
  await a.setViewport({width:1440,height:900});
  assert.equal((await a.$$('.invite__code span')).length,5);assert.equal(await a.$eval('.custom-kicker',e=>getComputedStyle(e).fontFamily.includes('Novecento')),true);assert.equal(await a.$eval('.custom-room__score strong',e=>getComputedStyle(e).fontFamily.includes('Bender')),true);assert.equal(await a.$eval('.custom-protocol-metrics strong',e=>getComputedStyle(e).fontFamily.includes('Bender')),true);assert.equal(await a.evaluate(()=>document.body.innerText.includes('总对局时限：100分钟')),false);assert.ok(await a.$('.friends-handle'));
  await a.evaluate(()=>document.fonts.ready);assert.equal(await a.evaluate(()=>document.fonts.check('24px Bender')),true);
  const traces=await a.evaluate(()=>globalThis.__customMotion);
  await a.evaluate(async()=>{(await import('/js/ui/settings.js')).updateSettings({matchingMotion:'reduced'});});await a.waitForFunction(()=>document.querySelector('.custom-room').dataset.motion==='reduced');await click(a,'.custom-summary .btn','自定设置');await a.waitForSelector('.custom-settings');assert.equal(await a.$eval('.friends-handle',e=>getComputedStyle(e).visibility),'hidden');assert.equal(await a.$eval('.custom-settings',e=>e.getAnimations().filter(a=>a.playState==='running').length),0);await a.keyboard.press('Escape');await a.reload({waitUntil:'networkidle2'});await a.waitForSelector('.custom-room');assert.equal(await a.$eval('.custom-room',e=>e.dataset.motion),'reduced');await a.evaluate(async()=>{(await import('/js/ui/settings.js')).updateSettings({matchingMotion:'full'});});
  for(const p of pages.slice(1,6))await request(p,'room.ready',{ready:true});await a.waitForFunction(()=>{const s=globalThis.__SP__.store.get();return s.room.seats.every(p=>p.playerId===s.me.playerId||p.ready);});await click(a,'.custom-room__footer .btn','开始模拟');await a.waitForSelector('.brief');
  const room=server.lobby.roomOf(server.registry.byId((await state(a)).me.playerId));assert.equal(room.mode,'custom');assert.equal(room.match.order.length,6);assert.equal(room.match.clientCombat,false);
  await a.waitForSelector('.hidden-intel--bonds');assert.equal(await a.$eval('.hidden-intel--bonds',e=>e.textContent.includes('隐秘战争生效')),true);assert.equal((await state(a)).match.public.bossId,null);assert.deepEqual((await state(a)).match.public.disabledBonds,[]);await a.screenshot({path:path.join(OUT,'07-hidden-war.png')});
  assert.equal(room.match.durationDeadline-room.match.durationStartedAt,6000000);
  room.match.finish({victory:false,reason:'duration_limit'});
  await a.waitForFunction(()=>document.body.innerText.includes('已达到100分钟'));await a.screenshot({path:path.join(OUT,'05-time-limit.png')});
  await click(a,'.modal__actions .btn','确认');await a.waitForSelector('.result__headline');assert.ok(await a.$eval('.result__headline',e=>e.textContent.includes('达到时限')));
  assert.equal(room.lastSummary.roomMode,'custom');assert.equal(room.lastSummary.reason,'duration_limit');assert.equal(room.lastSummary.victory,false);
  assert.equal(room.lastSummary.customEvaluation.version,3);assert.equal(room.lastSummary.initialPlayerCount,6);assert.ok(await a.$eval('.result .dtag__name',e=>/（\d+）/.test(e.textContent)));
  assert.ok(traces.some(r=>r.id==='custom-settings-enter'&&new Set(r.samples.map(s=>s.transform)).size>=3));
  fs.writeFileSync(path.join(OUT,'motion-progress.json'),JSON.stringify(traces,null,2));
  if(recording)await recording.stop();recording=null;
  assert.deepEqual(errors,[]);console.log('Custom browser acceptance: six players + observer, actual motion progress, 0 page errors');
});

