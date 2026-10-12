import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../../server/index.js';
import { PHASE } from '../../shared/constants.js';
import { give, legalTileFor } from '../match/harness.js';
const chrome='C:/Program Files/Google/Chrome/Application/chrome.exe';
const enabled=process.env.SP_FIXES_E2E==='1' && fs.existsSync(chrome);
test('two real identities: repeated invites, owned footer, first scout, choice/strategy/operator pings and custom continue', {skip:!enabled,timeout:180000},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sp-fixes-')),out=path.resolve('../screenshots');fs.mkdirSync(out,{recursive:true});
  const server=await startServer({host:'127.0.0.1',port:0,quiet:true,replayDir:path.join(dir,'replays'),profileDir:path.join(dir,'profiles')});
  const browser=await (await import('puppeteer-core')).default.launch({executablePath:chrome,headless:true,args:['--no-first-run','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows']});
  const errors=[],stage=s=>fs.writeFileSync(path.resolve('../browser-progress.txt'),s);
  const open=async(name,fallback=false)=>{
    const ctx=await browser.createBrowserContext(),p=await ctx.newPage();p.on('pageerror',e=>errors.push(e.message));await p.setViewport({width:1440,height:900});
    await p.evaluateOnNewDocument(()=>{globalThis.__notices=[];globalThis.__permission=0;globalThis.Notification=class{static permission='default';static async requestPermission(){globalThis.__permission++;this.permission='granted';return 'granted';}constructor(title,options){globalThis.__notices.push({title,options});}close(){}};});
    await p.goto(server.url+(fallback?'?render=fallback':''),{waitUntil:'networkidle2'});await p.waitForFunction(()=>!!globalThis.__SP__);
    await p.evaluate(n=>globalThis.__SP__.net.setName(n),name);await p.waitForFunction(n=>{const s=globalThis.__SP__;return s.net.status==='online'&&s.net.name===n;},{},name);
    await p.evaluate(()=>globalThis.__SP__.store.patch('session',{entered:true}));await p.waitForSelector('.lobby-screen');return p;
  };
  const req=(p,t,x={})=>p.evaluate((t,x)=>globalThis.__SP__.net.request(t,x),t,x);
  const ping=async(p,selector)=>{await p.bringToFront();await delay(150);await p.keyboard.down('KeyZ');await p.waitForSelector('.communication-hint');await p.click(selector);await p.keyboard.up('KeyZ');await delay(150);};
  try{
    stage('open');const a=await open('修复博士#0101'),b=await open('修复博士#0102',true);
    await b.click('.friends-handle');assert.equal(await b.evaluate(()=>globalThis.__permission),1);
    await req(a,'social.add',{identity:'修复博士#0102'});
    await b.evaluate(async()=>{const {socialStore}=await import('/js/ui/social.js');globalThis.__SP__.net._emit('social.state',{profileKey:globalThis.__SP__.net.name,recent:[]});if(!Array.isArray(socialStore.get().friends))throw Error('missing friends');});
    await req(a,'room.create',{mode:'coop',difficulty:'NORMAL'});const code=await a.evaluate(()=>globalThis.__SP__.store.get().room.code);
    for(let i=0;i<20;i++){
      stage('invite '+i);await delay(1150);server.lobby.social.cooldown.clear();await req(a,'social.invite',{identity:'修复博士#0102'});await b.waitForSelector('.social-invite-layer');
      await b.evaluate(()=>[...document.querySelectorAll('.social-invite-layer button')].find(e=>e.textContent.trim()==='接受邀请').click());
      await b.waitForFunction(c=>globalThis.__SP__.store.get().room?.code===c,{},code);await b.waitForSelector('.social-invite-layer',{hidden:true});
      assert.equal(await b.$('.local-hosting-credit'),null);
      if(i<19){await req(b,'room.leave');await b.evaluate(()=>globalThis.__SP__.store.set({room:null}));await b.waitForSelector('.lobby-screen');assert.equal(await b.$$eval('.local-hosting-credit',x=>x.length),1);}
    }
    await b.setViewport({width:844,height:390});await b.screenshot({path:path.join(out,'room-landscape.png')});
    await req(b,'room.ready',{ready:true});await req(a,'room.start');const m=server.lobby.getRoom(code).match;m.loneHuman=true;
    await a.waitForFunction(()=>globalThis.__SP__.store.get().match.public?.phase==='INFO_CHECK');await req(a,'g.infoReady');await req(b,'g.infoReady');
    await a.waitForSelector('[data-comm="band-offer"]');const before=JSON.stringify(m.draft.picks);await ping(a,'[data-comm="band-offer"]');assert.equal(JSON.stringify(m.draft.picks),before);await b.waitForFunction(async()=> (await import('/js/ui/communications.js')).communicationStore.get().events.some(e=>e.kind==='band-offer'));
    for(let i=0;i<2;i++){const pid=m.draftTurn(),p=pid===await a.evaluate(()=>globalThis.__SP__.store.get().me.playerId)?a:b;await req(p,'g.band',{bandId:m.timeoutBand(pid)});}
    await a.waitForFunction(()=>globalThis.__SP__.store.get().match.public?.phase==='PREP');stage('first scout');
    const aid=await a.evaluate(()=>globalThis.__SP__.store.get().me.playerId),bid=await b.evaluate(()=>globalThis.__SP__.store.get().me.playerId);
    await b.bringToFront();await b.click(`.team__btn[data-player="${aid}"]`);
    await b.click('.team__ob');
    await b.waitForFunction(pid=>document.querySelector('.gm__watching')&&globalThis.__SP_VIEW__?.raw?.stats?.().fieldId===`n:${pid}`,{},aid);
    await b.screenshot({path:path.join(out,'first-scout.png')});
    await b.click('.team__back');
    const slot=m.players.get(aid).privateView().shop.slots.findIndex(s=>s&&!s.sold&&s.kind==='chess');await req(a,'g.buy',{slot});
    const ps=m.players.get(aid),piece=ps.hand.find(p=>p?.kind==='chess');assert.ok(piece);
    const [row,col]=legalTileFor(m,ps,piece.id);await req(a,'g.move',{uid:piece.uid,to:{area:'board',row,col}});
    for(const family of ['tactic','bounty','supply','shop']){stage('choice '+family);m.phase=PHASE.SP_DRAFT;m.sp={family,cards:[{idx:0,id:'test_'+family,name:'标点验收'+family}],order:[bid,aid],idx:0,picks:{},taken:{}};m.flush(true);
      await a.waitForSelector('[data-comm="choice"]');await ping(a,'[data-comm="choice"]');assert.equal(m.sp.picks[aid],undefined);await b.waitForFunction(async(name)=>(await import('/js/ui/communications.js')).communicationStore.get().events.some(e=>e.kind==='choice'&&e.display?.name===name),{},'标点验收'+family);}
    m.sp=null;m.phase=PHASE.PREP;for(const ps of m.order)m.markPrivate(ps);m.flush(true);
    await a.waitForFunction(()=>globalThis.__SP__.store.get().match.public.phase==='PREP');await req(a,'g.ready',{ready:true});await req(b,'g.ready',{ready:true});
    await a.waitForFunction(()=>globalThis.__SP__.store.get().match.public.phase==='COMBAT');await a.waitForFunction(()=>!!globalThis.__SP__.store.get().match.field?.battleId);stage('combat operator');
    const f=m.fields.find(f=>f.players.includes(aid));assert.ok(f.spec.players.find(p=>p.playerId===aid).units.some(u=>u.uid===piece.uid));
    await a.waitForFunction((owner,uid)=>!!globalThis.__SP_VIEW__?.unitScreen(owner,uid),{timeout:20000},aid,piece.uid);
    const point=await a.evaluate((owner,uid)=>globalThis.__SP_VIEW__.unitScreen(owner,uid),aid,piece.uid);
    await a.bringToFront();await a.keyboard.down('KeyZ');await a.mouse.click(point.x,point.y);await a.keyboard.up('KeyZ');
    await b.waitForFunction(async()=> (await import('/js/ui/communications.js')).communicationStore.get().events.some(e=>e.kind==='battle-piece'));
    await a.screenshot({path:path.join(out,'combat-ping.png')});
    stage('boss both halves');m._stopClientCombat();m.startRound(m.gd.bossRound);m.setDeadline(0);m.enterPrep();
    const bossPieces=[];
    for(const pid of [aid,bid]){const ps=m.players.get(pid);ps.board.clear();const unit=give(m,ps,piece.id),[row,col]=legalTileFor(m,ps,unit.id);m.markPrivate(ps);m.flush(true);bossPieces.push({pid,uid:unit.uid});await req(pid===aid?a:b,'g.move',{uid:unit.uid,to:{area:'board',row,col}});}
    for(const ps of m.order)m.markPrivate(ps);m.flush(true);
    await a.waitForFunction(()=>globalThis.__SP__.store.get().match.public.phase==='PREP');await req(a,'g.ready',{ready:true});await req(b,'g.ready',{ready:true});
    await a.waitForFunction(()=>globalThis.__SP__.store.get().match.public.phase==='FINAL_ASSAULT');
    const bossField=m.fields.find(f=>f.players.includes(aid));assert.deepEqual(new Set(bossField.spec.players.map(p=>p.side)),new Set(['L','R']));
    await a.bringToFront();await delay(1200);
    for(const {pid,uid} of bossPieces){await a.waitForFunction((owner,uid)=>!!globalThis.__SP_VIEW__?.unitScreen(owner,uid),{},pid,uid);await delay(150);await a.keyboard.down('KeyZ');await a.waitForSelector('.communication-hint');const at=await a.evaluate((owner,uid)=>{const v=globalThis.__SP_VIEW__,p=v.unitScreen(owner,uid);for(const dy of [0,10,-10,20,-20,30,-30])for(const dx of [0,10,-10,20,-20]){const hit=v.pickCommunication(p.x+dx,p.y+dy);if(hit?.type==='unit'&&hit.unit?.ownerId===owner&&hit.unit?.uid===uid)return {x:p.x+dx,y:p.y+dy,hit};}return {p,hit:v.pickCommunication(p.x,p.y)};},pid,uid);fs.appendFileSync(path.resolve('../boss-hit.jsonl'),JSON.stringify({pid,uid,at})+'\n');assert.ok(at.x,'boss operator must be pointer-pickable');await a.mouse.click(at.x,at.y);await a.keyboard.up('KeyZ');await b.waitForFunction(async(owner,uid)=>(await import('/js/ui/communications.js')).communicationStore.get().events.some(e=>e.kind==='battle-piece'&&e.location?.ownerId===owner&&e.location?.uid===uid),{},pid,uid);}
    await a.screenshot({path:path.join(out,'boss-both-operators.png')});
    const ctx=await browser.createBrowserContext(),c=await ctx.newPage();await c.evaluateOnNewDocument(n=>localStorage.setItem('sp.name',n),'修复博士#0101');await c.goto(server.url,{waitUntil:'networkidle2'});
    await c.waitForSelector('[data-testid="continue-current-match"]');assert.equal(await c.$('[data-testid="resume-local-match"]'),null);await c.screenshot({path:path.join(out,'custom-continue.png')});
    assert.deepEqual(errors,[]);stage('passed');
  }catch(e){for(const [i,p] of (await browser.pages()).entries()){await p.screenshot({path:path.join(out,`failure-${i}.png`)}).catch(()=>{});fs.writeFileSync(path.join(out,`failure-${i}.txt`),await p.evaluate(()=>document.body.innerText).catch(()=>''));}throw e;}finally{await browser.close();await server.close();fs.rmSync(dir,{recursive:true,force:true});}
});
