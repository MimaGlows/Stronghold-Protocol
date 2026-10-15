// Isolated real-engine load test. Never connects to 3000/3001/3002 or the public tunnel.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fork} from 'node:child_process';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {startServer} from '../server/index.js';
import {defaultCustom} from '../shared/custom.js';
import {TestClient} from '../test/helpers/wsClient.js';
import {flatStage} from '../test/helpers/battleHarness.js';
import {DataSource} from '../server/sim/simdata.js';
import {canPlace,positionClass,tileKey} from '../server/match/board.js';
const file=fileURLToPath(import.meta.url),arg=name=>process.argv.find(a=>a.startsWith(`--${name}=`))?.split('=')[1];
const out=path.resolve(arg('out')||'.development/custom-v2-load'),worker=process.argv.includes('--worker');
if(worker){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sp-load-v2-'));
  const server=await startServer({port:0,host:'127.0.0.1',quiet:true,recording:false,profileDir:dir,ratePerSec:1000,rateBurst:1000,heavyPerSec:1000,heavyBurst:1000,heartbeatMs:30000});
  const delay=monitorEventLoopDelay({resolution:10});delay.enable();let lastCpu=process.cpuUsage(),lastAt=performance.now(),scenario={rooms:0,kind:'standard',hz:20},cycles=0;
  const setCombat=m=>{
    if(m.ended)return;
    m.runner?.stop();m.runner=null;for(const h of m._timers)m.sched.clearTimeout(h);m._timers.clear();m.fields=[];m.bossPool=null;m.teamLp=null;
    const round=scenario.kind==='boss'?14:scenario.kind==='standard'?2:18;
    for(const p of m.order){p.alive=true;p.lp=500;p.left=false;p.bounties=[];p.customDebt=null;p.board.clear();p.hand.fill(null);p.temp.fill(null);}
    if(scenario.kind==='extreme'){for(const p of m.order.slice(4)){p.alive=false;p.customDebt={round:17,bounties:[]};p.lp=0;}m.order[0].lp=600;}
    // A load fixture deliberately repeats one round; it is not a production phase transition.
    m.round=round-1;m._settledBossRound=null;
    m.startRound(round);for(const h of m._timers)m.sched.clearTimeout(h);m._timers.clear();
    m.opts.customSnapshotHz=scenario.hz;
    const stage=flatStage({id:'custom-load-flat'});m.ds=new DataSource({...m.data,stages:{...m.data.stages,'custom-load-flat':stage}});m.stageId='custom-load-flat';m.stage=stage;
    const ids=m.gd.visibleChess.filter(id=>!m.bannedChess.includes(id)&&m.gd.chess(id)?.position!=='NONE');
    for(const p of m.alivePlayers()){
      const count=scenario.kind==='standard'?8:12;
      p.invalidateDeployMap();let inserted=0;
      for(const id of ids){if(inserted>=count)break;const map=p.deployMap(),cls=positionClass(m.gd.chess(id).position);let placed=false;for(let r=9;r<=12&&!placed;r++)for(let col=2;col<=10;col++){const key=tileKey(r,col);if(!p.board.has(key)&&canPlace(map,cls,r,col)){p.board.set(key,{uid:m.nextUid(),id,kind:'chess',items:[],poolCopies:0,meta:{}});inserted++;placed=true;break;}}}p.recompute();
    }
    if(scenario.kind==='unite'){
      const leakers=m.order.slice(2),leaked=Array.from({length:400},(_,i)=>({enemyKey:'enemy_1007_slime',sourcePlayerId:leakers[i%leakers.length].playerId,counted:true,hpPct:1,mods:{hpMul:10,atkMul:3}}));
      m.lastResults=new Map(m.order.map(p=>[p.playerId,{unitsEnd:[],leaked:leaked.filter(l=>l.sourcePlayerId===p.playerId),perfect:p.seat<2}]));
      m.wave={...m.wave,timeLimit:1200};m.startUnite({helpers:m.order.slice(0,2),leakers,leaked,notReentered:new Map()});
    }else if(scenario.kind==='boss'){m.startFinalAssault(false);}else{
      const spawns=scenario.kind==='standard'?m.wave.spawns:m.wave.spawns.map(s=>({...s,time:Math.min(s.time,4)}));
      m.wave={...m.wave,timeLimit:3600,spawns,routes:m.wave.routes.map(r=>({...r,checkpoints:[{type:'WAIT',time:900},...(r.checkpoints||[])]}))};
      if(scenario.kind==='extreme')m.customBank=m.order.slice(0,4).flatMap(p=>Array.from({length:100},()=>({playerId:p.playerId,enemyKey:'enemy_1007_slime',firstRound:1,mods:{}})));
      m.startCombat();
    }cycles++;
  };
  const ensure=setInterval(()=>{for(const room of server.lobby.rooms.values()){const m=room.match;if(m&&!m.ended&&(!m.runner||m.runner.done))setCombat(m);}},500);
  process.on('message',async msg=>{
    if(msg.t==='scenario'){scenario=msg;if(!msg.rooms){for(const room of server.lobby.rooms.values())room.match?.dispose();server.lobby.rooms.clear();}else for(const room of server.lobby.rooms.values())if(room.match)setCombat(room.match);process.send({t:'configured'});}
    if(msg.t==='metrics'){
      const now=performance.now(),cpu=process.cpuUsage(),dt=now-lastAt;
      const rows=[...server.lobby.rooms.values()].map(r=>r.match).filter(Boolean);
      process.send({t:'metrics',cpuCorePercent:100*(cpu.user+cpu.system-lastCpu.user-lastCpu.system)/1000/dt,rssMiB:process.memoryUsage().rss/1048576,heapMiB:process.memoryUsage().heapUsed/1048576,eventLoopP95:delay.percentile(95)/1e6,eventLoopP99:delay.percentile(99)/1e6,cycles,rooms:rows.length,living:rows.reduce((n,m)=>n+m.fields.reduce((k,f)=>k+(f.battle?.aliveEnemies?.().length||0),0),0),pending:rows.reduce((n,m)=>n+m.fields.reduce((k,f)=>k+(f.battle?._pending?.length||0),0),0),socketQueue:Math.max(0,...[...server.registry.all()].map(s=>s.ws?.bufferedAmount||0)),errors:rows.reduce((n,m)=>n+m.errorCount,0)});lastCpu=cpu;lastAt=now;delay.reset();
    }
    if(msg.t==='stop'){clearInterval(ensure);delay.disable();await server.close();fs.rmSync(dir,{recursive:true,force:true});process.exit(0);}
  });process.send({t:'ready',port:server.port});
}else{
  fs.mkdirSync(out,{recursive:true});const child=fork(file,['--worker'],{execPath:process.execPath,stdio:['ignore',fs.openSync(path.join(out,'server.log'),'w'),fs.openSync(path.join(out,'server-errors.log'),'w'),'ipc']});
  const inbox=[],waiters=[];child.on('message',m=>{const i=waiters.findIndex(w=>w.t===m.t);if(i<0)inbox.push(m);else waiters.splice(i,1)[0].resolve(m);});
  const receive=t=>{const i=inbox.findIndex(m=>m.t===t);if(i>=0)return Promise.resolve(inbox.splice(i,1)[0]);return new Promise((resolve,reject)=>{const w={t,resolve:m=>{clearTimeout(timer);resolve(m);}};waiters.push(w);const timer=setTimeout(()=>{waiters.splice(waiters.indexOf(w),1);reject(new Error(`worker timeout: ${t}`));},30000);});};
  const ready=await receive('ready'),links=new Set();let tokens=0,lastToken=performance.now(),wire=0,delivered=0,queue=0,peakQueue=0;
  const rate=Number(arg('mbps')||24)*1e6/8;
  const proxy=net.createServer(client=>{const backend=net.connect(ready.port,'127.0.0.1'),link={client,backend,chunks:[],offset:0,bytes:0};links.add(link);client.pipe(backend);backend.on('data',b=>{wire+=b.length;link.chunks.push(b);link.bytes+=b.length;queue+=b.length;peakQueue=Math.max(peakQueue,queue);if(link.bytes>1048576)backend.pause();});const close=()=>{queue-=link.bytes;link.bytes=0;links.delete(link);client.destroy();backend.destroy();};client.on('error',close);backend.on('error',close);client.on('close',close);});
  await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
  const flush=setInterval(()=>{const now=performance.now();tokens=Math.min(rate*.05,tokens+rate*(now-lastToken)/1000);lastToken=now;for(const l of links){if(l.client.destroyed)continue;while(tokens>=1&&l.chunks.length){const b=l.chunks[0],n=Math.min(b.length-l.offset,Math.floor(tokens));l.client.write(b.subarray(l.offset,l.offset+n));l.offset+=n;tokens-=n;l.bytes-=n;queue-=n;delivered+=n;if(l.offset===b.length){l.chunks.shift();l.offset=0;}if(l.bytes<524288)l.backend.resume();if(l.client.writableLength>262144)break;}}},10);
  let clients=[];const records=[],latencies=[];const url=`ws://127.0.0.1:${proxy.address().port}/ws`;
  const connect=async name=>{const c=await TestClient.connect(url,{timeout:20000});clients.push(c);c.welcome=await c.hello(name);return c;};
  const request=async(c,msg)=>{const r=await c.request(msg,20000);if(r.t==='error')throw new Error(`${msg.t}: ${r.code} ${r.detail||''}`);return r;};
  const percentile=(rows,q)=>rows.length?[...rows].sort((a,b)=>a-b)[Math.min(rows.length-1,Math.floor(rows.length*q))]:0;
  const profile=arg('profile')||'full',short=Number(arg('seconds')||30),hzArg=Number(arg('hz')||5);
  const stages=profile==='unite'?[{rooms:1,kind:'unite',hz:hzArg,seconds:short}]:profile==='watch'?[{rooms:2,kind:'extreme',hz:hzArg,seconds:short},{rooms:1,kind:'unite',hz:hzArg,seconds:short}]:profile==='diagnostic'?[20,10,5].map(hz=>({rooms:1,kind:'extreme',hz,seconds:short})):profile==='rewards'?[{rooms:2,kind:'extreme',hz:hzArg,seconds:300},{rooms:1,kind:'boss',hz:hzArg,seconds:60}]:profile==='smoke'?[{rooms:1,kind:'standard',hz:hzArg,seconds:short},{rooms:1,kind:'extreme',hz:hzArg,seconds:short},{rooms:1,kind:'boss',hz:hzArg,seconds:short}]:profile==='concurrency'?[2,4].map(rooms=>({rooms,kind:'extreme',hz:hzArg,seconds:300})):[{rooms:1,kind:'standard',hz:hzArg,seconds:300},{rooms:1,kind:'boss',hz:hzArg,seconds:300},...[1,2,4].map(rooms=>({rooms,kind:'extreme',hz:hzArg,seconds:300}))];
  const cleanupClients=async()=>{await Promise.all(clients.map(c=>c.close()));clients=[];};
  try{
    for(let s=0;s<stages.length;s++){
      const stage=stages[s];latencies.length=0;await cleanupClients();child.send({t:'scenario',rooms:0,kind:'standard',hz:stage.hz});await receive('configured');
      for(let room=0;room<stage.rooms;room++){
        const cs=[];for(let i=0;i<8;i++)cs.push(await connect(`Load${s}_${room}_${i}#0001`));
        await request(cs[0],{t:'room.create',mode:'custom',difficulty:'ABYSS'});let state=await cs[0].waitFor('room.state');
        const extreme=stage.kind!=='standard';const config={...defaultCustom(),capacity:6,extraRounds:extreme,carnival:extreme,debt:extreme,whitebird:extreme&&stage.kind!=='unite',tourist:true,enemyCount:extreme?1000:100,enemyHp:extreme?300:100,enemyAtk:extreme?400:100,enemyAspd:extreme?400:100,allyHp:300,deployCap:12,supply:12};
        await request(cs[0],{t:'room.custom',config,name:'负载验收',revision:state.revision});
        for(const c of cs.slice(1,6)){await request(c,{t:'room.join',code:state.code});await request(c,{t:'room.ready',ready:true});}for(const c of cs.slice(6))await request(c,{t:'room.spectate',code:state.code});await request(cs[0],{t:'room.start'});
      }
      child.send({t:'scenario',...stage,kind:stage.kind==='mixed'?'extreme':stage.kind});await receive('configured');
      const started=performance.now(),beginWire=wire,beginDelivered=delivered,beginRows=records.length;peakQueue=queue;let nextMetric=started,nextPing=started,lastWire=wire,lastDelivered=delivered,lastMetric=started;
      while(performance.now()-started<stage.seconds*1000){await new Promise(r=>setTimeout(r,250));const now=performance.now();for(const c of clients){c.log.length=0;c.inbox.length=0;}
        if(now>=nextPing){const before=performance.now();await clients[0].request({t:'ping',c:Date.now()},20000).then(()=>latencies.push(performance.now()-before),()=>latencies.push(20000));nextPing=now+2000;}
        if(now>=nextMetric){child.send({t:'metrics'});const metrics=await receive('metrics');records.push({stage:s,at:Date.now(),...metrics,wireMbps:(wire-lastWire)*8/(now-lastMetric)/1000,deliveredMbps:(delivered-lastDelivered)*8/(now-lastMetric)/1000,proxyQueue:queue,peakProxyQueue:peakQueue});lastWire=wire;lastDelivered=delivered;lastMetric=now;nextMetric=now+5000;fs.writeFileSync(path.join(out,'progress.json'),JSON.stringify({stage:s,stages,elapsedSeconds:(now-started)/1000,latest:records.at(-1)},null,2));}
      }
      const rows=records.slice(beginRows),result={...stage,durationSeconds:(performance.now()-started)/1000,meanWireMbps:(wire-beginWire)*8/(performance.now()-started)/1000,meanDeliveredMbps:(delivered-beginDelivered)*8/(performance.now()-started)/1000,p95EventLoop:percentile(rows.map(r=>r.eventLoopP95),.95),p95CpuCore:percentile(rows.map(r=>r.cpuCorePercent),.95),p95ProxyQueue:percentile(rows.map(r=>r.proxyQueue),.95),endingProxyQueue:queue,p95SocketQueue:percentile(rows.map(r=>r.socketQueue),.95),p95PingMs:percentile(latencies,.95),errors:Math.max(...rows.map(r=>r.errors)),peakRssMiB:Math.max(...rows.map(r=>r.rssMiB)),peakLiving:Math.max(...rows.map(r=>r.living))};
      result.stable=result.p95EventLoop<=50&&result.p95PingMs<=150&&result.p95CpuCore<=80&&result.endingProxyQueue<262144&&result.meanWireMbps<=18&&result.errors===0;
      fs.appendFileSync(path.join(out,'stages.jsonl'),JSON.stringify(result)+'\n');fs.writeFileSync(path.join(out,'samples.json'),JSON.stringify(records,null,2));console.log(JSON.stringify(result));
      if(['full','concurrency'].includes(profile)&&s===stages.length-1&&!stage.endurance){const all=fs.readFileSync(path.join(out,'stages.jsonl'),'utf8').trim().split('\n').map(JSON.parse),best=all.filter(r=>r.stable&&r.kind==='extreme').at(-1);if(best)stages.push({rooms:best.rooms,kind:'extreme',hz:stage.hz,seconds:1800,endurance:true});}
    }
  }finally{await cleanupClients();clearInterval(flush);for(const l of links){l.client.destroy();l.backend.destroy();}await new Promise(r=>proxy.close(r));child.send({t:'stop'});await new Promise(r=>child.once('exit',r));}
}
