// SP_MATCH_E2E=1 CHROME_PATH=... node --test test/ui/matchmaking.e2e.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../../server/index.js';
const chrome=process.env.CHROME_PATH,enabled=process.env.SP_MATCH_E2E==='1' && chrome && fs.existsSync(chrome);
const OUT=path.resolve('test/e2e/out/matchmaking-v6');
async function clickText(page,selector,text) {
  for(const h of await page.$$(selector))if((await h.evaluate(e=>e.textContent)).includes(text)){
    // Reveal clipped scroll-container content without centring an already visible fixed-footer control.
    await h.evaluate(e=>e.scrollIntoView({block:'nearest',inline:'nearest'}));
    try{await page.waitForFunction(e=>{const r=e.getBoundingClientRect();return !e.disabled&&r.width>0&&r.height>0&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));},{timeout:5000},h);}catch(error){throw new Error('Unreachable '+text+': '+JSON.stringify(await h.evaluate(e=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {disabled:e.disabled,rect:r.toJSON(),hit:hit?.outerHTML.slice(0,700),ancestors:[e,e.parentElement,e.parentElement?.parentElement].map(n=>({class:n?.className,rect:n?.getBoundingClientRect().toJSON(),pointer:n&&getComputedStyle(n).pointerEvents}))};})),{cause:error});}
    const pt=await h.evaluate(e=>{const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
    await page.mouse.click(pt.x,pt.y);return;
  }
  throw new Error('Missing '+text);
}
const state=p=>p.evaluate(()=>globalThis.__SP__.store.get());
const request=(p,type,fields={})=>p.evaluate(({type,fields})=>globalThis.__SP__.net.request(type,type==='matching.leave'?{partyId:globalThis.__SP__.store.get().matching.party?.id,...fields}:fields),{type,fields});
const waitParty=(p,count)=>p.waitForFunction(n=>globalThis.__SP__.store.get().matching.party?.members.length===n,{},count);
const settle=p=>p.evaluate(async()=>{await Promise.all([...document.querySelectorAll('.matching-queue,.alliance-picker')].flatMap(e=>e.getAnimations({subtree:true})).filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});
test('four browsers: lobby parties, preferences, queue UI, merge, friend restoration, backfill, sanctions and mobile', {skip:!enabled,timeout:180000}, async(t)=>{
  fs.mkdirSync(OUT,{recursive:true}); const puppeteer=(await import('puppeteer-core')).default;
  const browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-first-run','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sp-matching-v2-browser-'));
  const server=await startServer({port:0,host:'127.0.0.1',quiet:true,profileDir:path.join(dir,'profiles'),matchmakingDir:path.join(dir,'matching')});
  const pages=[],errors=[];
  t.after(async()=>{
    if(!t.passed)for(const [i,p] of pages.entries()){await p.screenshot({path:path.join(OUT,`failure-${i}.png`)}); console.log('Browser failure',i,await p.evaluate(()=>({motion:globalThis.__cueMotion?.filter(t=>t.id==='matching-success').map(t=>({id:t.id,first:t.samples[0],last:t.samples.at(-1),count:t.samples.length})),matching:globalThis.__SP__.store.get().matching,body:document.querySelector('.app-root').innerText.slice(-1500)})),errors);}
    await browser.close(); await server.close(); fs.rmSync(dir,{recursive:true,force:true});
  });
  for(const name of ['MimaGlows','博士乙','博士丙','博士丁']){
    const context=await browser.createBrowserContext(),p=await context.newPage();pages.push(p);p.on('pageerror',e=>errors.push(e.message));
    await p.setViewport({width:1440,height:900});await p.goto(server.url,{waitUntil:'networkidle2'});
    await p.type('input[name=doctor-name]',name);await clickText(p,'.title-login .btn','开始');await p.waitForSelector('.lobby-screen');
    await p.waitForFunction(()=>!!globalThis.__SP__.store.get().matching.identity);
    await p.evaluate(()=>localStorage.setItem('sp.pref.lobby.difficulty','NORMAL'));
    await p.reload({waitUntil:'networkidle2'});await p.waitForSelector('.lobby-screen');
  }
  const [a,b,c,d]=pages;
  await a.evaluate(async()=>{
    const {audio}=await import('/js/audio.js'),sfx=audio.sfx.bind(audio);globalThis.__matchingSounds=[];
    audio.sfx=(name,...args)=>{if(['start','matchCancel','matchSucceed'].includes(name))globalThis.__matchingSounds.push(name);return sfx(name,...args);};
    globalThis.__cueMotion=[];const animate=Element.prototype.animate;
    Element.prototype.animate=function(...args){const animation=animate.apply(this,args),element=this;requestAnimationFrame(()=>{
      if(!/^(friends-|matching-success|matching-queue-exit)/.test(animation.id))return;
      const trace={id:animation.id,samples:[]};globalThis.__cueMotion.push(trace);
      const sample=()=>{if(!element.isConnected || animation.playState==='idle')return;const c=getComputedStyle(element),r=element.getBoundingClientRect();trace.samples.push({time:animation.currentTime,transform:c.transform,opacity:c.opacity,x:r.x,y:r.y});if(trace.samples.length<40&&animation.playState!=='finished')requestAnimationFrame(sample);};sample();
    });return animation;};
  });
  console.log('Native system prefers-reduced-motion:',await a.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches));
  async function setMotion(p,mode){await p.click('.lobby-screen [data-testid="settings-btn"]');await p.waitForSelector('[data-testid="matching-motion"]');await clickText(p,'[data-testid="matching-motion"] button',mode==='full'?'完整动画':'减少动画');assert.ok(await p.$eval('.settings-modal .modal__actions .btn',e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),'settings completion remains above the fixed queue');await p.screenshot({path:path.join(OUT,`settings-over-queue-${p.viewport().width}-${mode}.png`)});await clickText(p,'.settings-modal .modal__actions .btn','完成');await p.waitForFunction(()=>!document.querySelector('[data-testid="matching-motion"]'));}
  await a.evaluate(async()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=256;const g=canvas.getContext('2d');g.fillStyle='#f13e77';g.fillRect(0,0,256,256);(await import('/js/ui/avatarProfile.js')).commitAvatar({kind:'custom',dataUrl:canvas.toDataURL('image/webp',.8)});});
  await a.waitForFunction(async()=>(await import('/js/ui/avatarProfile.js')).avatarStore.get().sync==='synced');
  const dimensions=await a.evaluate(()=>{const start=document.querySelector('.matching-start').getBoundingClientRect(),create=document.querySelector('.matching-create-box .btn--primary').getBoundingClientRect();return {start:{w:start.width,h:start.height,right:start.right},create:{w:create.width,h:create.height,right:create.right}};});
  assert.ok(Math.abs(dimensions.start.w-dimensions.create.w)<1);assert.ok(Math.abs(dimensions.start.h-dimensions.create.h)<1);assert.ok(Math.abs(dimensions.start.right-dimensions.create.right)<1);
  assert.ok(await a.evaluate(()=>{const b=document.querySelector('.matching-blacklist').getBoundingClientRect(),s=document.querySelector('.matching-start').getBoundingClientRect();return s.left-b.right>=12;}),'blacklist button has real clearance');
  assert.equal(await a.$('.matching-entry'),null);await a.screenshot({path:path.join(OUT,'01-lobby.png')});
  async function invite(host,guest){
    const id=(await state(guest)).matching.identity;await request(host,'social.add',{identity:id});await host.click('.friends-handle');await host.waitForSelector(`.friend-row[data-identity="${id}"]`);
    if(host===a){await host.waitForFunction(()=>globalThis.__cueMotion.some(t=>t.id==='friends-open'&&t.samples.length>=3));await host.screenshot({path:path.join(OUT,'20-friends-open.png')});}
    await clickText(host,`.friend-row[data-identity="${id}"] .btn`,'邀请加入匹配队伍');await guest.waitForSelector('.social-invite-layer .modal');
    if(host===a){await host.waitForSelector('.matching-notice-text');await host.screenshot({path:path.join(OUT,'17-avatar-notice.png')});await clickText(host,'.modal__actions .btn','知道了');await host.waitForFunction(()=>!document.querySelector('.matching-notice-text'));}
    await host.waitForSelector('.matching-member.is-pending');await clickText(guest,'.social-invite-layer .btn','接受邀请');await waitParty(host,2);await guest.waitForSelector('.lobby-screen');await host.click('.friends-handle');
    if(host===a){await host.waitForFunction(()=>['friends-open','friends-close'].every(id=>globalThis.__cueMotion.some(t=>t.id===id && new Set(t.samples.map(s=>s.transform)).size>1)));}
  }
  await invite(a,b);await invite(c,d);
  for(const p of pages)assert.ok((await state(p)).matching.party.members.every(m=>!m.ready));
  await settle(a);
  assert.ok(await a.$eval('.matching-member__info',e=>Number(getComputedStyle(e).opacity)===1&&e.textContent.includes('MimaGlows')));
  await a.screenshot({path:path.join(OUT,'02-party.png')});
  await a.setViewport({width:844,height:390});await a.waitForFunction(()=>parseFloat(getComputedStyle(document.documentElement).fontSize)<45);
  assert.ok(await a.$eval('.matching-prepare',e=>{const r=e.getBoundingClientRect(),l=e.querySelector('.btn__label').getBoundingClientRect(),q=e.closest('.matching-queue').getBoundingClientRect();return l.top>=r.top&&l.bottom<=r.bottom&&r.bottom<=q.bottom;}),'mobile prepare label fits its button and queue');
  await a.screenshot({path:path.join(OUT,'15-party-mobile.png')});await a.setViewport({width:1440,height:900});await a.waitForFunction(()=>parseFloat(getComputedStyle(document.documentElement).fontSize)>60);
  await a.$eval('.lobby-body',e=>{e.scrollTop=e.scrollHeight;});
  await a.waitForFunction(()=>{const b=document.querySelector('.lobby-body'),e=document.querySelector('.matching-blacklist');b.scrollTop=b.scrollHeight;const r=e.getBoundingClientRect(),old=globalThis.__blacklistPosition;const hit=e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));const count=hit&&old&&Math.abs(old.y-r.y)<.1&&Math.abs(old.h-r.height)<.1?old.count+1:0;globalThis.__blacklistPosition={y:r.y,h:r.height,count};return count>=4;});
  // Puppeteer's implicit scrollIntoView ignores the fixed footer and can scroll this control behind it.
  const blacklistPoint=await a.$eval('.matching-blacklist',e=>{const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
  await a.mouse.click(blacklistPoint.x,blacklistPoint.y);await a.waitForSelector('.matching-blacklist-modal');assert.equal(await a.$('.matching-blacklist-modal select'),null);await clickText(a,'.matching-blacklist-modal .modal__actions .btn','关闭');
  async function declare(p,bond,snapshot=false){
    const party=(await state(p)).matching.party;
    await clickText(p,party?'.matching-queue .matching-prepare':'.matching-start',party?'选择同盟并完成准备':'开始匹配');
    await p.waitForSelector('.alliance-picker');assert.equal(await p.$('.alliance-picker select'),null);
    assert.equal((await p.$$('.alliance-option')).length,9);await p.waitForFunction(()=>document.querySelector('.alliance-confirm')?.disabled);
    await p.click(`.alliance-option[data-bond="${bond || 'any'}"]`);
    await p.waitForFunction(()=>!document.querySelector('.alliance-confirm').disabled);
    assert.ok(await p.evaluate(()=>{const els=[...document.querySelectorAll('.alliance-picker .modal__actions .btn')],rs=els.map(e=>e.getBoundingClientRect());return Math.abs(rs[0].height-rs[1].height)<1&&Math.abs((rs[0].top+rs[0].height/2)-(rs[1].top+rs[1].height/2))<1;}),'cancel and confirm share height and center');
    if(snapshot){
      await p.waitForFunction(()=>[...document.querySelectorAll('.alliance-option .bglyph img')].every(e=>e.complete&&e.naturalWidth>0));
      await p.evaluate(async()=>{await Promise.all(document.querySelector('.alliance-picker').getAnimations({subtree:true}).filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});
      await p.screenshot({path:path.join(OUT,'10-alliance-picker.png')});
      await p.setViewport({width:844,height:390});
      await p.waitForFunction(()=>parseFloat(getComputedStyle(document.documentElement).fontSize)<45);
      await p.waitForFunction(()=>[...document.querySelectorAll('.alliance-option')].every(e=>e.querySelector('.alliance-option__glyph').getBoundingClientRect().right<=e.querySelector('strong').getBoundingClientRect().left));
      assert.ok(await p.$eval('.alliance-picker .modal__actions .btn--ghost .btn__label',e=>parseFloat(getComputedStyle(e).fontSize)>=14));
      await p.$eval('.alliance-options',e=>{e.closest('.modal__body').scrollTop=9999;});
      await p.waitForFunction(()=>{const b=document.querySelector('.alliance-option[data-bond="kazimierzShip"]') || document.querySelector('.alliance-option:last-child'),r=b.getBoundingClientRect(),a=document.querySelector('.alliance-picker .modal__actions').getBoundingClientRect();return r.bottom<=a.top+1;});
      await p.screenshot({path:path.join(OUT,'16-picker-mobile-bottom.png')});await p.$eval('.alliance-options',e=>{e.closest('.modal__body').scrollTop=0;});
      await p.screenshot({path:path.join(OUT,'11-picker-mobile.png')});await p.setViewport({width:1440,height:900});await p.waitForFunction(()=>parseFloat(getComputedStyle(document.documentElement).fontSize)>60);
      await p.evaluate(()=>{const net=globalThis.__SP__.net,original=net.request;net.request=function(type,...args){if(type==='matching.prepare'){net.request=original;return Promise.reject(Object.assign(new Error('temporary test failure'),{code:'INTERNAL'}));}return original.call(this,type,...args);};});
      await clickText(p,'.alliance-picker .alliance-confirm','选择');await p.waitForFunction(()=>!document.querySelector('.alliance-confirm').disabled);
      assert.equal(await p.$eval(`.alliance-option[data-bond="${bond}"]`,e=>e.getAttribute('aria-pressed')),'true');
    }
    await clickText(p,'.alliance-picker .alliance-confirm','选择');await p.waitForFunction(()=>!document.querySelector('.alliance-picker'));
  }
  await a.click('.me-chip .avatar-edit');assert.equal(await a.$eval('.avatar-upload',e=>e.disabled),true);await clickText(a,'.avatar-picker .avatar-confirm','保存头像');await a.waitForSelector('.matching-notice-text');await clickText(a,'.modal__actions .btn','知道了');await a.waitForFunction(()=>!document.querySelector('.matching-notice-text'));await clickText(a,'.avatar-picker .modal__actions .btn','取消');
  assert.ok(await a.$eval('.me-chip .avatar img',e=>e.src.includes('aroma')));
  await declare(a,'yanShip',true);assert.equal((await state(a)).matching.party.phase,'idle');
  // Observe the transition itself, before later UI waits can outlive the short animation.
  await a.evaluate(()=>{globalThis.__matchingMidpoint=null;globalThis.__matchingTrace=[];const q=document.querySelector('.matching-queue'),o=new MutationObserver(()=>{globalThis.__matchingTrace.push({c:q.className,ids:q.getAnimations({subtree:true}).map(a=>[a.id,a.currentTime,a.effect.getTiming().duration]),bg:getComputedStyle(q).backgroundColor});const anim=q.getAnimations().find(a=>a.id==='matching-color');if(!anim)return;anim.pause();anim.currentTime=160;globalThis.__matchingMidpoint=getComputedStyle(q).backgroundColor;anim.play();o.disconnect();});o.observe(q,{attributes:true,attributeFilter:['class']});});
  await declare(b,'sargonShip');await a.waitForSelector('.matching-queue.is-searching');
  const midpoint=await a.evaluate(()=>globalThis.__matchingMidpoint);
  assert.ok(midpoint&&midpoint!=='rgb(20, 24, 22)'&&midpoint!=='rgb(89, 244, 202)',JSON.stringify(await a.evaluate(()=>globalThis.__matchingTrace)));
  const entries=await a.evaluate(()=>globalThis.__matchingTrace.flatMap(s=>s.ids));assert.ok(entries.some(([id,,duration])=>id==='matching-refresh-enter'&&duration===420));
  assert.ok(entries.some(([id,,duration])=>id==='matching-group-shift'&&duration===180));
  await clickText(b,'.matching-unready','取消准备');await a.waitForFunction(()=>globalThis.__SP__.store.get().matching.party.phase==='idle');
  await a.waitForFunction(()=>globalThis.__cueMotion.some(t=>t.id==='matching-queue-exit'&&t.samples.some(s=>s.y>t.samples[0].y+5)));
  assert.ok((await state(a)).matching.party.members.every(m=>!m.ready));
  await settle(a);assert.equal(await a.$eval('.matching-queue',e=>getComputedStyle(e).backgroundColor),'rgb(20, 24, 22)');
  assert.equal(await a.$eval('.matching-member__info',e=>getComputedStyle(e).opacity),'1');
  await declare(a,'yanShip');
  await a.waitForFunction(()=>!document.querySelector('.toast'));
  const recording=await a.screencast({path:path.join(OUT,'12-matching-motion.webm')});
  await declare(b,'sargonShip');await a.waitForSelector('.matching-queue.is-searching');
  await a.waitForFunction(()=>!document.querySelector('.toast'));
  await a.evaluate(async()=>{await Promise.all(document.querySelector('.matching-queue').getAnimations({subtree:true}).filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});
  await a.waitForFunction(()=>document.querySelector('.matching-queue__time')?.textContent==='00:02');
  const angleBefore=await a.$eval('.matching-refresh .icon',e=>getComputedStyle(e).transform);
  assert.ok(await a.evaluate(()=>{const g=document.querySelector('.matching-queue__members').getBoundingClientRect(),els=[...document.querySelectorAll('.matching-queue__members > .matching-member')],l=els[0].getBoundingClientRect(),r=els.at(-1).getBoundingClientRect(),actions=document.querySelector('.matching-queue__actions').getBoundingClientRect();return (l.left+r.right)/2>g.left+g.width/2+10 && r.right<actions.left-10;}),'compact portraits settle to the right without touching cancel');
  await a.screenshot({path:path.join(OUT,'03-searching.png')});
  const queueRect=await a.$eval('.matching-queue',e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:2};});
  await a.screenshot({path:path.join(OUT,'13-queue-detail.png'),clip:queueRect});
  await a.setViewport({width:844,height:390});await a.waitForFunction(()=>{const r=document.querySelector('.matching-queue').getBoundingClientRect();return r.bottom<=innerHeight+1&&r.left>=0&&r.right<=innerWidth+1;});await a.screenshot({path:path.join(OUT,'04-mobile.png')});await a.setViewport({width:1440,height:900});
  await a.waitForFunction(()=>document.querySelector('.matching-refresh .icon').getAnimations().some(a=>a.id==='matching-refresh-loop'&&a.currentTime>=9500));
  assert.notEqual(await a.$eval('.matching-refresh .icon',e=>getComputedStyle(e).transform),angleBefore);
  assert.equal(await a.$eval('.matching-queue',e=>getComputedStyle(e).backgroundColor),'rgb(89, 244, 202)');
  assert.equal(await a.$eval('.matching-member__info',e=>getComputedStyle(e).opacity),'0');
  assert.equal((await a.$$('.matching-queue__actions .btn')).length,1);
  assert.equal(await a.$eval('.matching-refresh .icon',e=>e.getAnimations()[0].effect.getTiming().duration),9000);
  await clickText(b,'.matching-unready','取消准备');await a.waitForSelector('.matching-queue.is-forming');await settle(a);
  assert.deepEqual(await a.evaluate(()=>globalThis.__matchingSounds),['start','matchCancel','start','matchCancel']);
  await a.screenshot({path:path.join(OUT,'14-cancel-restored.png')});
  await declare(a,'yanShip');await declare(b,'sargonShip');await a.waitForSelector('.matching-queue.is-searching');await settle(a);await recording.stop();
  const attempt=(await state(a)).matching.party.attemptId;
  await setMotion(a,'reduced');assert.equal(await a.$eval('.matching-queue',e=>e.getAnimations({subtree:true}).length),0);
  await setMotion(a,'full');await a.waitForFunction(()=>document.querySelector('.matching-refresh .icon').getAnimations().some(a=>a.id==='matching-refresh-loop'));
  await a.setViewport({width:844,height:390});await setMotion(a,'reduced');await setMotion(a,'full');await a.setViewport({width:1440,height:900});
  assert.equal((await state(a)).matching.party.attemptId,attempt);
  const first=server.lobby.matchmakingService.parties.of(server.registry.byId((await state(a)).me.playerId));first.attempt.startedAt-=60000;server.lobby.matchmakingService.parties.pump();
  await a.waitForSelector('.matching-queue__extended');await a.screenshot({path:path.join(OUT,'05-extended.png')});
  await a.bringToFront();const successRecording=await a.screencast({path:path.join(OUT,'19-success-motion.webm')});
  // Capture the transient confirmation concurrently; waiting for another tab's dialog exit can outlive it.
  const successShot=(async()=>{await a.bringToFront();const sample=await a.waitForFunction(()=>{const e=document.querySelector('.matching-success');if(!e?.getAnimations().some(a=>a.id==='matching-success'&&a.currentTime>=160))return false;return {inMatch:globalThis.__SP__.store.get().room.inMatch,pointer:getComputedStyle(e).pointerEvents,members:e.querySelectorAll('.matching-success__member').length};},{polling:25});const facts=await sample.jsonValue();await a.screenshot({path:path.join(OUT,'19-success.png')});return facts;})();
  await declare(c,'victoriaShip');await declare(d,'kjeragShip');const successFacts=await successShot;
  assert.ok(successFacts.inMatch,'game already entered during confirmation');assert.equal(successFacts.pointer,'none');assert.equal(successFacts.members,4);
  assert.deepEqual(await a.evaluate(()=>globalThis.__matchingSounds),['start','matchCancel','start','matchCancel','start','matchSucceed']);
  assert.ok(await a.evaluate(async()=>{const {audio}=await import('/js/audio.js'),{data}=await import('/js/data.js'),m=data.get('assets');const decoded=await Promise.all(['start','matchCancel','matchSucceed'].map(k=>audio.buffers.get(m.audio.sfx.ui[k])));return decoded.every(b=>b?.duration>0);}),'all three native cue assets decoded by real Web Audio');
  await a.waitForFunction(()=>!document.querySelector('.matching-success'));await successRecording.stop();
  assert.ok(await a.evaluate(()=>{const t=globalThis.__cueMotion.find(t=>t.id==='matching-success');return t.samples.some(s=>Number(s.opacity)>0&&Number(s.opacity)<1)&&new Set(t.samples.map(s=>s.transform)).size>1;}),'success has real intermediate opacity and motion');
  await a.waitForFunction(()=>globalThis.__SP__.store.get().room?.inMatch);assert.equal(await a.$('.room-screen'),null);
  const room=server.lobby.roomOf(server.registry.byId((await state(a)).me.playerId));assert.equal(room.activeHumans().length,4);await a.screenshot({path:path.join(OUT,'06-briefing.png')});
  room.match.finish('defeat');await a.waitForSelector('.result');await clickText(a,'.matching-result .btn','拉黑匹配队友');await a.waitForFunction(()=>globalThis.__SP__.store.get().matching.blocks.length===1);
  await a.screenshot({path:path.join(OUT,'07-result.png')});
  for(const p of pages)await clickText(p,'.result__foot .btn','返回大厅');for(const p of pages)await p.waitForSelector('.lobby-screen');
  assert.equal((await state(a)).matching.party.members.length,2);assert.equal((await state(c)).matching.party.members.length,2);
  const returnedB=await state(b); assert.equal(returnedB.matching.party.members.find(m=>m.playerId===returnedB.me.playerId)?.ready,false);
  await request(a,'matching.leave');await a.waitForSelector('.matching-queue-departing');await a.waitForFunction(()=>globalThis.__cueMotion.some(t=>t.id==='matching-queue-exit'&&t.samples.length>=4));await a.screenshot({path:path.join(OUT,'21-queue-exit.png')});await a.waitForFunction(()=>!document.querySelector('.matching-queue-departing'));
  assert.ok(await a.evaluate(()=>{const t=globalThis.__cueMotion.find(t=>t.id==='matching-queue-exit');return t.samples.at(-1).y>t.samples[0].y+20;}),'leaving queue slides downward');
  for(const p of [b,c,d])await request(p,'matching.leave');await a.waitForFunction(()=>!globalThis.__SP__.store.get().matching.party);assert.ok(await a.$('.me-chip .avatar img'));
  const blocked=(await state(a)).matching.blocks[0];await request(a,'matching.unblock',{identity:blocked});
  await a.evaluate(()=>{globalThis.__soloEntries=[];globalThis.__soloObserver=new MutationObserver(()=>{const q=document.querySelector('.matching-queue.is-searching');if(q)for(const a of q.getAnimations())if(a.id==='matching-queue-enter')globalThis.__soloEntries.push(a.effect.getTiming().duration);});globalThis.__soloObserver.observe(document.body,{attributes:true,childList:true,subtree:true});});
  await declare(a,'yanShip');await a.waitForSelector('.matching-queue.is-searching');
  if(await a.$('.matching-notice-text')){await clickText(a,'.modal__actions .btn','知道了');await a.waitForFunction(()=>!document.querySelector('.matching-notice-text'));}
  assert.ok((await a.evaluate(()=>{globalThis.__soloObserver.disconnect();return globalThis.__soloEntries;})).includes(360),'first solo search slides from below in 360ms');
  await settle(a);assert.ok(await a.$eval('.matching-queue',e=>{const r=e.getBoundingClientRect();return getComputedStyle(e).position==='fixed'&&Math.abs(r.bottom-innerHeight)<1&&r.left===0&&Math.abs(r.right-innerWidth)<1;}),'queue overlays the full window bottom');
  await clickText(a,'.matching-unready','取消准备');await a.waitForFunction(()=>globalThis.__SP__.store.get().matching.party.phase==='idle');
  await request(a,'matching.leave');await a.waitForFunction(()=>!globalThis.__SP__.store.get().matching.party);
  await setMotion(a,'reduced');
  await a.reload({waitUntil:'networkidle2'});await a.waitForFunction(()=>globalThis.__SP__.store.get().matching.identity && globalThis.__SP__.store.get().matching.preference==='yanShip');
  assert.equal((await state(a)).matching.party,null);
  assert.equal(await a.evaluate(()=>JSON.parse(localStorage.getItem('sp.pref.settings')).matchingMotion),'reduced');
  assert.equal(await a.evaluate(()=>document.documentElement.dataset.matchingMotion),'reduced');await setMotion(a,'full');
  // Ordinary room owns the opening decision; the other three remain a whole lobby party.
  await clickText(a,'.matching-create-box .btn--primary','创建同盟');await a.waitForSelector('.room-screen');
  await a.click('.matching-toggle input');await a.waitForSelector('.alliance-picker');await a.click('.alliance-option[data-bond="any"]');await clickText(a,'.alliance-confirm','选择');await a.waitForFunction(()=>globalThis.__SP__.store.get().room.matching.enabled);
  assert.equal(await a.$('.matching-room'),null);assert.equal(await a.$('.room-screen .matching-preference'),null);
  assert.ok(await a.$('.room-bar__opts .matching-toggle'));
  assert.equal(await a.$eval('.seat--empty .btn',e=>e.disabled),true);
  await setMotion(b,'reduced');await invite(b,c);
  const idD=(await state(d)).matching.identity;await request(b,'social.add',{identity:idD});await request(b,'matching.invite',{identity:idD,difficulty:'NORMAL'});await d.waitForSelector('.social-invite-layer .modal');await clickText(d,'.social-invite-layer .btn','接受邀请');await waitParty(b,3);
  await declare(b,'yanShip');await declare(c,'victoriaShip');await declare(d,'kjeragShip');await b.waitForSelector('.matching-queue.is-searching');
  await b.setViewport({width:844,height:390});await b.waitForFunction(()=>parseFloat(getComputedStyle(document.documentElement).fontSize)<45);
  const trio=server.lobby.matchmakingService.parties.of(server.registry.byId((await state(b)).me.playerId));trio.attempt.startedAt-=60000;server.lobby.matchmakingService.parties.pump();
  await b.waitForSelector('.matching-success');assert.equal(await b.$eval('.matching-success',e=>e.getAnimations({subtree:true}).length),0);assert.equal((await state(b)).room.inMatch,false,'success does not auto-start a backfill room');await b.screenshot({path:path.join(OUT,'22-success-mobile.png')});await b.waitForFunction(()=>!document.querySelector('.matching-success'));await b.setViewport({width:1440,height:900});
  for(const p of [b,c,d])await p.waitForSelector('.room-screen');const ordinary=server.lobby.roomOf(server.registry.byId((await state(a)).me.playerId));assert.equal(ordinary.activeHumans().length,4);assert.equal(ordinary.match,null);
  assert.equal(ordinary.toState().matchPrivacy,true);assert.ok(ordinary.toState().seats.every(s=>!s?.doctorCode));
  assert.ok(await a.evaluate(()=>!/#\d{4}\b/.test(document.querySelector('.room-screen').innerText)));
  await a.waitForSelector('.dialog-host .matching-notice-text');
  await a.screenshot({path:path.join(OUT,'23-backfill-avatar-notice.png')});
  await clickText(a,'.dialog-host .modal__actions .btn','知道了');await a.waitForFunction(()=>!document.querySelector('.dialog-host .matching-notice-text'));
  await a.waitForFunction(()=>{const seats=[...document.querySelectorAll('.room-screen .seat:not(.seat--empty)')];return seats.length===4&&seats.every(e=>Number(getComputedStyle(e).opacity)===1);});
  await a.screenshot({path:path.join(OUT,'08-backfill-room.png')});await clickText(a,'.room-bar__right .btn','开始模拟');await b.waitForFunction(()=>globalThis.__SP__.store.get().room.inMatch);
  assert.equal(ordinary.match.matchPrivacy,true);assert.ok(ordinary.match.publicView().players.every(p=>!p.doctorCode));
  await b.evaluate(async()=>{await (await import('/js/ui/matchChrome.js')).quitMatch();});await b.waitForFunction(()=>globalThis.__SP__.store.get().matching.bannedUntil>Date.now());await b.waitForSelector('.lobby-screen');
  await b.screenshot({path:path.join(OUT,'09-sanction.png')});assert.equal(await b.$eval('.matching-start',e=>e.disabled),true);
  const keys=await a.evaluate(()=>Object.keys(localStorage));assert.ok(keys.every(k=>!k.startsWith('sp.')||k.startsWith('sp.')));
  const badContext=await browser.createBrowserContext(),bad=await badContext.newPage();pages.push(bad);bad.on('pageerror',e=>errors.push(e.message));await bad.setViewport({width:1440,height:900});await bad.goto(server.url,{waitUntil:'networkidle2'});await bad.type('input[name=doctor-name]','fuck');await clickText(bad,'.title-login .btn','开始');await bad.waitForSelector('.lobby-screen');await clickText(bad,'.matching-start','开始匹配');await bad.waitForSelector('.alliance-picker');await bad.click('.alliance-option[data-bond="any"]');await clickText(bad,'.alliance-confirm','选择');await bad.waitForSelector('.matching-notice-text');assert.ok(await bad.$eval('.matching-notice-text',e=>e.textContent.includes('敏感词检查')));assert.equal((await state(bad)).matching.party,null);await bad.screenshot({path:path.join(OUT,'18-name-rejected.png')});await clickText(bad,'.modal__actions .btn','知道了');assert.equal(await bad.$eval('.alliance-option[data-bond="any"]',e=>e.getAttribute('aria-pressed')),'true');
  assert.deepEqual(errors,[]);
});
