import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startServer} from '../../server/index.js';
const chrome=process.env.CHROME_PATH,enabled=process.env.SP_CUSTOM_E2E==='1'&&chrome&&fs.existsSync(chrome);
const state=p=>p.evaluate(()=>globalThis.__SP__.store.get());
const request=(p,t,fields={})=>p.evaluate(({t,fields})=>globalThis.__SP__.net.request(t,fields),{t,fields});
const reloads=Math.max(1,Math.min(10,Number(process.env.SP_CUSTOM_RELOADS)||1));
test('six-player server custom: two-step scouting, hidden-war access, live loss and unite camera switching',{skip:!enabled,timeout:120000+reloads*10000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sp-gameplay-browser-')),out=path.resolve('test/e2e/out/custom-gameplay-fix');fs.mkdirSync(out,{recursive:true});
  const server=await startServer({port:0,host:'127.0.0.1',quiet:true,recording:false,profileDir:dir,matchmakingDir:path.join(dir,'matching')}),browser=await(await import('puppeteer-core')).default.launch({executablePath:chrome,headless:true,args:['--no-first-run','--disable-renderer-backgrounding']});
  const pages=[],errors=[];let video;
  t.after(async()=>{if(video)await video.stop();if(!t.passed&&pages[0]){await pages[0].screenshot({path:path.join(out,'failure.png')});console.log('Failed game state',await pages[0].evaluate(async()=>{const {data}=await import('/js/data.js'),{GAME_FILES}=await import('/js/ui/gameComponents.js');return {phase:globalThis.__SP__.store.get().match.public?.phase,data:Object.fromEntries(GAME_FILES.map(n=>[n,data.status(n)]))};}),errors);}await browser.close();await server.close();fs.rmSync(dir,{recursive:true,force:true});});
  for(let i=0;i<7;i++){const p=await(await browser.createBrowserContext()).newPage();pages.push(p);p.on('pageerror',e=>errors.push(e.message));await p.setViewport({width:1440,height:900});await p.goto(server.url,{waitUntil:'networkidle2'});await p.type('input[name=doctor-name]',`ObserveQA${i}`);await p.click('.title-login .btn--primary');await p.waitForSelector('.lobby-screen');}
  const a=pages[0];await a.bringToFront();await request(a,'room.create',{mode:'custom',difficulty:'ABYSS'});let roomState=(await state(a)).room;await request(a,'room.custom',{config:{...roomState.custom,capacity:6,hiddenWar:true,noLeakCap:true},name:'联防验收',revision:roomState.revision});const code=roomState.code;
  for(const p of pages.slice(1,6)){await request(p,'room.join',{code});await request(p,'room.ready',{ready:true});}await request(pages[6],'room.spectate',{code});await request(a,'room.start');await a.waitForSelector('.brief');assert.equal(await a.$('.brief-reroll'),null);
  const room=server.lobby.roomOf(server.registry.byId((await state(a)).me.playerId)),m=room.match;assert.equal(m.clientCombat,false);
  for(const p of m.order)p.lp=100;m.startRound(1);m.enterPrep();m.setDeadline(0);m.flush(true);await a.waitForSelector('.gm');
  let watchCalls=0;const watch=m.watch.bind(m);m.watch=(...args)=>{watchCalls++;return watch(...args);};const other=m.order[1].playerId;
  await a.click(`.team__btn[data-player="${other}"]`);await a.waitForSelector('.team__ob');assert.equal(watchCalls,0);await a.click('.team__ob');await a.waitForFunction(id=>globalThis.__SP__.store.get().match.field?.fieldId===`n:${id}`,{},other);assert.equal(watchCalls,1);await a.screenshot({path:path.join(out,'01-two-step-scout.png')});await a.click('.team__back');
  // Streamed combat: pin real combat in the isolated fixture while injecting authority counts.
  m.startCombat();m.runner.stop();const f=m.fields[0],pid=m.order[0].playerId;f.battle._perPlayer[pid].leaked=[];m.markPublic();m.flush(true);await a.waitForFunction(()=>globalThis.__SP__.store.get().match.public.phase==='COMBAT');
  await a.waitForNetworkIdle({idleTime:750,timeout:15000});
  // Sixty fixed steady samples give a meaningful P95; with eighteen samples P95 is the single maximum.
  // Preserve the six cold samples separately and retain every subsequent sample, including stalls.
  const elapsed=[],cold=[];for(let count=1;count<=66;count++){const start=performance.now();f.battle._perPlayer[pid].leaked=Array.from({length:count},()=>({counted:true}));m.markPublic();m.flush();await a.waitForFunction(n=>globalThis.__SP__.store.get().match.public.players[0].pendingLp===n,{polling:20},count);await a.waitForFunction(n=>[...document.querySelectorAll('.team__row.is-self [data-comm="life"] .lp')].some(e=>Number(e.dataset.pending)===n),{polling:20},count);(count<=6?cold:elapsed).push(performance.now()-start);}
  const p95=[...elapsed].sort((a,b)=>a-b)[Math.floor(elapsed.length*.95)];fs.writeFileSync(path.join(out,'latency.json'),JSON.stringify({samples:elapsed,cold,p95,errors},null,2)+'\n');assert.ok(p95<=300,`Life preview P95 ${p95}`);await a.screenshot({path:path.join(out,'02-live-life-preview.png')});
  // Build an actual two-helper unite battle; leakers and spectator receive the same streamed field.
  m.setDeadline(0);m.fields=[];const leaks=m.order.slice(2).map(p=>({sourcePlayerId:p.playerId,enemyKey:'enemy_1007_slime',counted:true,hpPct:1,mods:{}}));
  m.lastResults=new Map(m.order.map(p=>[p.playerId,{leaked:leaks.filter(l=>l.sourcePlayerId===p.playerId),unitsEnd:[],perfect:p.seat<2}]));m.wave={...m.wave,timeLimit:1000};m.startUnite({helpers:m.order.slice(0,2),leakers:m.order.slice(2),leaked:leaks,notReentered:new Map()});m.runner.stop();m.flush(true);assert.equal(m.errorCount,0,JSON.stringify(m.errors));await a.waitForFunction(()=>globalThis.__SP__.store.get().match.public.phase==='UNITE');
  await a.waitForSelector('.chud__layers');await a.bringToFront();video=await a.screencast({path:path.join(out,'03-unite-camera.webm')});
  await a.click('.chud__layers [aria-label="右侧战场"]');await a.waitForFunction(()=>document.querySelector('.chud__layers .vswitch__label')?.textContent.includes('你自己'));
  await a.click('.chud__layers [aria-label="左侧战场"]');await a.waitForFunction(()=>document.querySelector('.chud__layers .vswitch__label')?.textContent.includes('全景'));
  await a.click('.chud__layers [aria-label="左侧战场"]');await a.waitForFunction(()=>document.querySelector('.chud__layers .vswitch__label')?.textContent.includes('ObserveQA1'));
  await a.screenshot({path:path.join(out,'04-unite-left.png')});await a.setViewport({width:844,height:390});await a.$eval('.team',e=>{e.scrollTop=e.scrollHeight;});await a.waitForFunction(()=>{const rows=document.querySelectorAll('.team__row'),last=rows[rows.length-1]?.getBoundingClientRect();return last&&last.bottom<innerHeight-40;});await a.screenshot({path:path.join(out,'05-mobile-unite.png')});await a.setViewport({width:1440,height:900});
  for(const page of [pages[2],pages[6]]){await page.bringToFront();await page.waitForSelector('.chud__layers');assert.equal(await page.$('.chud__wait'),null);await page.click(`.team__btn[data-player="${other}"]`);await page.waitForSelector('.team__ob');await page.click('.team__ob');await page.waitForFunction(()=>document.querySelector('.chud__layers .vswitch__label')?.textContent.includes('ObserveQA1'));}
  for(let i=0;i<reloads;i++){await a.reload({waitUntil:'networkidle2'});await a.waitForSelector('.chud__layers');assert.equal((await state(a)).match.public.phase,'UNITE');}
  console.log('Unite reconnects passed:',reloads);
  await video.stop();video=null;fs.writeFileSync(path.join(out,'latency.json'),JSON.stringify({samples:elapsed,cold,p95,errors},null,2)+'\n');assert.deepEqual(errors,[]);
});
