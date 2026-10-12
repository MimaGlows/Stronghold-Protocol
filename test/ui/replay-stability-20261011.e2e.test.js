import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gunzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../../server/index.js';
const chrome='C:/Program Files/Google/Chrome/Application/chrome.exe';
test('existing long replay: prep units, 100 random seeks, 20 mounts, bounded tracks and context loss fallback', {skip:process.env.SP_REPLAY_STRESS!=='1',timeout:300000},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sp-replay-stress-')),out=path.resolve('../screenshots');
  fs.mkdirSync(out,{recursive:true});fs.cpSync(path.resolve('../qa-data/replays'),path.join(dir,'replays'),{recursive:true,dereference:true});
  const server=await startServer({host:'127.0.0.1',port:0,quiet:true,replayDir:path.join(dir,'replays'),profileDir:path.join(dir,'replays/profiles')});
  const records=fs.readdirSync(path.join(dir,'replays')).filter(n=>n.endsWith('.json.gz')).map(n=>JSON.parse(gunzipSync(fs.readFileSync(path.join(dir,'replays',n)))));
  const chosen=records.filter(r=>r.status==='ready').sort((a,b)=>b.durationMs-a.durationMs)[0];assert.ok(chosen);
  const index=server.replays.getShared(chosen.shareCode,{tracks:true});assert.equal(index.status,'ready');
  const browser=await (await import('puppeteer-core')).default.launch({executablePath:chrome,headless:true,args:['--no-first-run','--disable-background-timer-throttling']});
  const page=await browser.newPage(),errors=[],requests=[],metrics=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('/api/shared-replays/'))requests.push(r.url().split('?')[1]||'');});
  const stage=s=>fs.writeFileSync(path.resolve('../replay-progress.txt'),s);
  try{
    await page.setViewport({width:1440,height:900});await page.goto(server.url,{waitUntil:'networkidle2'});await page.waitForFunction(()=>!!globalThis.__SP__);
    const open=async()=>{await page.evaluate(async code=>{const h=await import('/js/replay/history.js');h.openHistory({shared:true,shareCode:code},'replay');},chosen.shareCode);await (await page.waitForSelector('.replay-player')).dispose();await page.waitForFunction(()=>!!globalThis.__SP_REPLAY__&&!!globalThis.__SP_VIEW__);};
    const seek=async at=>{await page.evaluate(at=>{const el=document.querySelector('.replay-range');el.value=at;el.dispatchEvent(new Event('input',{bubbles:true}));},at);await page.waitForFunction(at=>{const s=globalThis.__SP_REPLAY__?.stats();return s?.time===at&&s.trackReady;},{timeout:30000},at);};
    await open();stage('prep');
    const prep=index.nodes.find(n=>n.phase==='PREP'&&n.players[index.participants[0].playerId]?.field?.units?.length);assert.ok(prep,'archive has deployed/bench operators in prep');
    await seek(prep.at);await page.waitForFunction(()=>globalThis.__SP_VIEW__?.raw?.stats?.().units>0);await page.screenshot({path:path.join(out,'replay-prep-units.png')});
    const participants=index.participants.slice(0,2);
    for(const p of participants){await page.click(`.team__btn[data-player="${p.playerId}"]`);const watch=await page.$('.team__ob');if(watch){await watch.dispose();await page.click('.team__ob');}await page.waitForFunction(pid=>globalThis.__SP_REPLAY__?.stats().who===pid,{},p.playerId);}
    await page.screenshot({path:path.join(out,'replay-player-switch.png')});
    await page.click('.gm__fs');await page.waitForFunction(()=>!!document.fullscreenElement);await page.click('.gm__fs');await page.waitForFunction(()=>!document.fullscreenElement);
    await seek(index.fields[0].at+1000);await page.select('.replay-select','8');stage('continuous playback');const playingStart=await page.evaluate(()=>globalThis.__SP_REPLAY__.stats().time);await page.click('.replay-toggle');await delay(60000);await page.click('.replay-toggle');const playedMs=await page.evaluate(()=>globalThis.__SP_REPLAY__.stats().time)-playingStart;assert.ok(playedMs>30000,'continuous playback advances across track chunks');
    for(let i=0;i<(process.env.SP_REPLAY_DIAG?0:100);i++){stage('seek '+i);const at=Math.floor(index.durationMs*((i*37)%100)/100);await seek(at);const s=await page.evaluate(()=>globalThis.__SP_REPLAY__.stats().cache);assert.ok(s.bytes<=32*1024*1024);if(i%10===0)metrics.push({seek:i,...await page.metrics(),cache:s});}
    await seek(prep.at);stage('context loss');
    const canvas=await page.$('.gm__field canvas');assert.ok(canvas);await canvas.dispose();await page.evaluate(()=>document.querySelector('.gm__field canvas').dispatchEvent(new Event('webglcontextlost',{bubbles:false,cancelable:true})));
    await (await page.waitForSelector('.gm__field .ff')).dispose();await page.waitForFunction(()=>globalThis.__SP_VIEW__?.raw?.stats?.().units>0);
    await page.screenshot({path:path.join(out,'replay-context-fallback.png')});
    const close=async()=>{await page.evaluate(async()=>{(await import('/js/replay/history.js')).closeHistory();});await page.waitForSelector('.replay-player',{hidden:true});assert.equal(await page.evaluate(()=>globalThis.__SP_REPLAY__==null),true);};
    await close();
    const cdp=await page.createCDPSession();
    for(let i=0;i<(process.env.SP_REPLAY_DIAG?3:20);i++){stage('mount '+i);await open();await seek(prep.at);await page.waitForFunction(()=>globalThis.__SP_VIEW__?.raw?.stats?.().units>0);await close();await cdp.send('HeapProfiler.collectGarbage');metrics.push({mount:i,...await page.metrics(),spine:await page.evaluate(async()=>(await import('/js/assets.js')).assets.spine.stats())});fs.writeFileSync(path.resolve('../replay-resource-results.json'),JSON.stringify({metrics,errors},null,2));}
    if(process.env.SP_REPLAY_DIAG){const obj=await cdp.send('Runtime.evaluate',{expression:'window'});const listeners=await cdp.send('DOMDebugger.getEventListeners',{objectId:obj.result.objectId});fs.writeFileSync(path.resolve('../replay-listeners.json'),JSON.stringify(listeners,null,2));const file=fs.openSync(path.resolve('../replay.heapsnapshot'),'w');cdp.on('HeapProfiler.addHeapSnapshotChunk',({chunk})=>fs.writeSync(file,chunk));await cdp.send('HeapProfiler.takeHeapSnapshot');fs.closeSync(file);return;}
    await delay(22000);await cdp.send('HeapProfiler.collectGarbage');metrics.push({quiet:true,...await page.metrics()});
    assert.deepEqual(errors,[]);assert.ok(requests.every(q=>q.includes('tracks=1')||q.includes('summary=1')));
    fs.writeFileSync(path.resolve('../replay-resource-results.json'),JSON.stringify({durationMs:chosen.durationMs,continuousWallMs:60000,playedMs,playerSwitches:participants.length,fullscreen:true,seeks:100,mounts:20,requests:requests.length,wholeTrackRequests:requests.filter(q=>!q).length,metrics,errors},null,2));stage('passed');
    const cycles=metrics.filter(m=>m.mount!=null);assert.ok(metrics.at(-1).JSHeapUsedSize<cycles[4].JSHeapUsedSize+32*1024*1024,'quiet heap does not grow by an unbounded track copy');
  }catch(e){await page.screenshot({path:path.join(out,'replay-failure.png')});fs.writeFileSync(path.resolve('../replay-failure.txt'),await page.evaluate(()=>document.body.innerText));throw e;}finally{await browser.close();await server.close();fs.rmSync(dir,{recursive:true,force:true});}
});
