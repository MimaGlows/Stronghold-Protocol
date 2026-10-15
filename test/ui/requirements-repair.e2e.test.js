import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startServer} from '../../server/index.js';
const chrome=process.env.CHROME_PATH,enabled=process.env.SP_CUSTOM_E2E==='1'&&chrome&&fs.existsSync(chrome);
const OUT=path.resolve('test/e2e/out/requirements-repair');
const click=async(p,selector,text)=>{for(const h of await p.$$(selector))if((await h.evaluate(e=>e.textContent)).includes(text)){await h.click();return;}throw Error('Missing '+text);};
test('settings cancel/save, hidden strategy dialog, queue control reachability at both target viewports',{skip:!enabled,timeout:120000},async t=>{
  fs.mkdirSync(OUT,{recursive:true});const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sp-repair-ui-'));
  const server=await startServer({port:0,host:'127.0.0.1',quiet:true,recording:false,profileDir:dir,matchmakingDir:path.join(dir,'matching')}),browser=await(await import('puppeteer-core')).default.launch({executablePath:chrome,headless:true,args:['--no-first-run','--disable-renderer-backgrounding']});
  const p=await browser.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));let recording;
  t.after(async()=>{await recording?.stop();if(!t.passed)await p.screenshot({path:path.join(OUT,'failure.png')});await browser.close();await server.close();fs.rmSync(dir,{recursive:true,force:true});});
  await p.setViewport({width:1440,height:900});await p.goto(server.url,{waitUntil:'networkidle2'});await p.type('input[name=doctor-name]','设置验收');await click(p,'.title-login .btn','开始');await p.waitForSelector('.lobby-screen');
  // Complete a cache entry between the hook's render and its passive subscription;
  // no later server message or data notification may rescue the loading screen.
  await p.evaluate(async()=>{
    const {data,useData}=await import('/js/data.js'),{h,render}=await import('/vendor/preact.module.js');
    const status=data.status,load=data.load;let current='loading';
    data.status=n=>n==='subscribe-race-probe'?current:status(n);
    data.load=n=>n==='subscribe-race-probe'?Promise.resolve({}):load(n);
    const node=document.body.appendChild(document.createElement('div'));
    const Probe=()=>h('span',{'data-subscribe-probe':useData('subscribe-race-probe')?'ready':'loading'});
    render(h(Probe),node);current='ready';
    globalThis.cleanupDataProbe=()=>{render(null,node);node.remove();data.status=status;data.load=load;};
  });
  try{await p.waitForSelector('[data-subscribe-probe="ready"]',{timeout:2000});}finally{await p.evaluate(()=>globalThis.cleanupDataProbe());}
  const request=(type,fields={})=>p.evaluate(({type,fields})=>globalThis.__SP__.net.request(type,fields),{type,fields});
  recording=await p.screencast({path:path.join(OUT,'settings-and-hidden-war.webm')});
  await request('room.create',{mode:'custom',difficulty:'NORMAL'});await p.waitForSelector('.custom-room');
  await click(p,'.custom-summary .btn','自定设置');await click(p,'.custom-difficulty .btn','绝境模拟');
  assert.equal(await p.evaluate(()=>globalThis.__SP__.store.get().room.difficulty),'NORMAL');await click(p,'.custom-settings .modal__actions .btn','取消');await p.waitForSelector('.custom-settings',{hidden:true});
  assert.equal(await p.evaluate(()=>globalThis.__SP__.store.get().room.difficulty),'NORMAL');
  await click(p,'.custom-summary .btn','自定设置');await click(p,'.custom-difficulty .btn','绝境模拟');await p.keyboard.press('Escape');await p.waitForSelector('.custom-settings',{hidden:true});assert.equal(await p.evaluate(()=>globalThis.__SP__.store.get().room.difficulty),'NORMAL');
  await click(p,'.custom-summary .btn','自定设置');await click(p,'.custom-difficulty .btn','绝境模拟');await click(p,'.custom-settings nav button','历战合约');await p.click('[data-contract=hiddenWar]');await click(p,'.custom-settings .modal__actions .btn','保存设置');await p.waitForFunction(()=>globalThis.__SP__.store.get().room.difficulty==='HARD');await p.screenshot({path:path.join(OUT,'atomic-settings-saved.png')});
  await request('room.start');await p.waitForSelector('.brief');await request('g.infoReady');await p.waitForSelector('[data-testid=match-info-open]');await p.click('[data-testid=match-info-open]');await p.waitForSelector('.minfo-dlg .hidden-intel');assert.equal((await p.$$('.minfo-dlg .brief-bond')).length,0);await p.screenshot({path:path.join(OUT,'hidden-strategy-dialog.png')});
  const id=await p.evaluate(()=>globalThis.__SP__.store.get().me.playerId),session=server.registry.byId(id),room=server.lobby.roomOf(session);room.match.finish({victory:false,reason:'audit'});await p.waitForSelector('.result');await click(p,'.result__foot .btn','返回同盟');await request('room.leave');await p.evaluate(()=>globalThis.__SP__.store.set({room:null}));await p.waitForSelector('.lobby-screen');
  server.lobby.matchmakingService.parties.ensure(session,'NORMAL');await p.waitForSelector('.matching-queue');
  for(const [width,height]of [[1440,900],[844,390]]){
    await p.setViewport({width,height});await p.waitForFunction(()=>{const e=document.querySelector('.matching-queue');return e&&parseFloat(document.documentElement.style.getPropertyValue('--matching-queue-height'))===e.offsetHeight;});
    await p.$eval('.lobby-body',e=>{e.scrollTop=e.scrollHeight;});
    await p.waitForFunction(()=>{const e=document.querySelector('.matching-blacklist'),r=e.getBoundingClientRect(),q=document.querySelector('.matching-queue').getBoundingClientRect();return r.bottom<=q.top&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));});
    const point=await p.$eval('.matching-blacklist',e=>{const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};});await p.mouse.click(point.x,point.y);await p.waitForSelector('.matching-blacklist-modal');await p.screenshot({path:path.join(OUT,`reachable-blacklist-${width}.png`)});await click(p,'.matching-blacklist-modal .modal__actions .btn','关闭');
  }
  assert.deepEqual(errors,[]);
});
