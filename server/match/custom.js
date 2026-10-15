import { MATCH_LIMIT_MS, checkCustom, customScore, customWarnings } from '../../shared/custom.js';
import { PHASE } from '../../shared/constants.js';
import { createRng, deriveSeed } from '../sim/rng.js';
import { draftBounty, bountyDraftKind, bountyCard } from './choices.js';
import { withBounties, previewOf, buildBossWave, bountySpawns } from './waves.js';
import { GameData } from './gamedata.js';

export const CUSTOM_RULES_VERSION = 2;

export function customScoreContext(data,difficulty,players=4) {
  const gd=new GameData(data,`mode_${players===1?'single':'multi'}_${difficulty.toLowerCase()}`), bans=gd.bans(difficulty);
  const eligible=gd.bondIds.filter(id=>Number(gd.bond(id).weight)>0&&!gd.modeInactiveBonds.has(id));
  const coreIds=gd.bondIds.filter(id=>gd.bond(id).isCore),activeCore=eligible.filter(id=>coreIds.includes(id)),nativeLp=gd.bandIds().map(id=>gd.startLp(id));
  const coreProbability=Math.max(0,bans.core-Math.max(0,players-4))/Math.max(1,activeCore.length),addonProbability=bans.addon/Math.max(1,eligible.length-activeCore.length);
  const pools=Object.fromEntries(['initial','hunter','boss'].map(pool=>{const cards=(gd.choices.cards?.bounty||[]).filter(c=>draftBounty(c,pool)&&gd.enemy(c.enemyKey));return [pool,{killValue:cards.reduce((n,c)=>n+(c.payout==='perfect'?0:Math.max(0,c.coin||0)*Math.max(1,c.count||1)*bountyCard(gd,c).rounds),0)/(cards.length||1),eliteCoin:cards.filter(c=>gd.enemy(c.enemyKey)?.rank==='ELITE'&&c.payout!=='perfect').reduce((n,c)=>n+Math.max(0,c.coin||0),0)/Math.max(1,cards.filter(c=>gd.enemy(c.enemyKey)?.rank==='ELITE'&&c.payout!=='perfect').length)}];}));
  const drafts=Object.entries(gd.choices.schedule?.[gd.modeId]?.rounds||{}).filter(([,s])=>s.bountyDraft).map(([round,s])=>({round:Number(round),pool:s.bountyDraft,probability:(s.families||[]).filter(f=>f.family==='bounty').reduce((n,f)=>n+f.weight,0)/Math.max(1,(s.families||[]).reduce((n,f)=>n+f.weight,0))})).sort((a,b)=>a.round-b.round);
  const bountyEconomy={income:Array.from({length:19},(_,r)=>gd.income(r+1)),drafts,pools,secondRound:drafts.find(d=>d.pool!=='initial')?.round||9};
  return {meanLp:nativeLp.reduce((a,b)=>a+b,0)/(nativeLp.length||1),coreIds,coreProbability,addonProbability,players,bountyEconomy,
    probabilities:Object.fromEntries(gd.bondIds.map(id=>[id,gd.modeInactiveBonds.has(id)?1:eligible.includes(id)?coreIds.includes(id)?coreProbability:addonProbability:0]))};
}

export function roundEscalation(round) { return round>=15 ? [1.25,1.5,1.8,2.16,2.16][Math.min(4,round-15)] : 1; }
export function initCustomMatch(m) {
  if (!m.customConfig) return;
  const c=checkCustom(m.customConfig,m.data.bonds);
  if (!c) throw new Error('Invalid custom configuration');
  m.clientCombat=false; // Custom armies are resolved by the server; legacy client report caps remain unchanged.
  m.opts={...m.opts,customSnapshotHz:m.opts.customSnapshotHz||5};
  m.customConfig=Object.freeze(c); m.customBank=[]; m.carnivalPool='initial'; m.carnivalDrafts=0;
  const gd=m.gd; gd.custom=c;gd.customPlayers=m.order.length;
  m.initialPlayerCount=m.order.length;m.baselineKind=m.order.length===1?'single':'multi';
  m.customRulesVersion = CUSTOM_RULES_VERSION;
  const native = new GameData(m.data, `mode_${m.baselineKind}_${m.difficulty.toLowerCase()}`);
  gd.mode={...native.mode,lastRound:c.extraRounds?19:14,bossRound:14,hiddenRound:native.hiddenRound?15:null};
  if(m.order.length===1)Object.defineProperty(gd,'choices',{get:()=>({...native.choices,schedule:{...native.choices.schedule,[m.modeId]:native.choices.schedule?.[native.modeId]}})});
  for (const id of c.requiredBonds) gd.modeInactiveBonds.delete(id);
  const descriptor=(key,value)=>Object.defineProperty(gd,key,{get:()=>value,configurable:true});
  descriptor('deployCap',c.deployCap); if (c.noLeakCap) descriptor('lpCapPerRound',Number.MAX_SAFE_INTEGER);
  const pool=gd.poolCopies.bind(gd); gd.poolCopies=id=>Math.round(pool(id)*c.supply/3);
  const lp=gd.startLp.bind(gd); gd.startLp=id=>c.oneLife?1:c.lastStand?11:lp(id);
  const bans=gd.bans.bind(gd); gd.bans=d=>{const b=bans(d);return {...b,core:Math.max(0,b.core-Math.max(0,m.order.length-4))};};
  const rc=native.roundCfg.bind(native), normalBase=native.bossRound-1;
  gd.waveSourceRound=r=>r===14||r===19?native.bossRound:r===15&&m.hiddenReached&&native.hiddenRound?native.hiddenRound:Math.min(r,normalBase);
  gd.enemyScale=r=>native.enemyScale(gd.waveSourceRound(r));
  gd.roundCfg=r=>{
    const source=r===19?{...rc(native.bossRound),bossTemplates:{...rc(native.bossRound)?.bossTemplates,...rc(native.hiddenRound)?.bossTemplates}}:rc(gd.waveSourceRound(r));
    if (!source) return null;
    return {...source, prepTime:source.prepTime*c.prep/100, combatTimeLimit:source.combatTimeLimit*c.combat/100,levelMaxPlayTime:source.levelMaxPlayTime*c.combat/100};
  };
  const bh=native.bossPoolHp.bind(native);
  gd.bossPoolHp=(id,n)=>Math.max(1,Math.round(bh(id,m.order.length===6?Math.min(4,n):n)*(m.order.length===6?2:1)*c.enemyHp/100*(c.extraRounds?roundEscalation(m.round):1)));
  const context=customScoreContext(m.data,m.difficulty,m.order.length);
  m.customEvaluation=customScore(c,m.difficulty,{...context,coreIds:new Set(context.coreIds)});
  m.customRisk=customWarnings(c,m.customEvaluation);
  if (c.extraRounds) {
    const maps={...rc(native.bossRound)?.bossTemplates,...rc(native.hiddenRound)?.bossTemplates};
    const ids=Object.keys(maps).filter(id=>gd.boss(id)&&gd.wave(maps[id])).sort();
    const rng=createRng(deriveSeed(m.seed,'custom-final-boss'));
    m.extraBossId=ids[Math.floor(rng()*ids.length)]||null;
    if (!m.extraBossId) throw new Error('No custom final boss template');
  }
}

export function scaleSpawns(list, multiplier) {
  // Stable largest remainders preserve the aggregate and double each action exactly at 200%.
  const rows=list.map((s,i)=>({s,i,n:s.tag==='boss'?Number(s.count||1):Math.max(0,Number(s.count??1))*multiplier}));
  const target=Math.round(rows.reduce((n,r)=>n+r.n,0));
  let left=target-rows.reduce((n,r)=>n+Math.floor(r.n),0);
  for (const r of [...rows].sort((a,b)=>(b.n%1)-(a.n%1)||a.i-b.i)) { r.count=Math.floor(r.n)+(left-->0?1:0); }
  return rows.filter(r=>r.count>0).map(r=>({...r.s,count:r.count}));
}
export function captureWhitebird(m) {
  if (!m.customConfig?.whitebird) return;
  if(m.whitebirdCapturedRound===m.round)return;
  m.whitebirdCapturedRound=m.round;
  if([13,18].includes(m.round))m.customBank=[];
  for (const [playerId,result] of m.lastResults) for (const leak of result.leaked||[]) {
    if (leak.counted===false || leak.boss || leak.tag==='boss') continue;
    const mods={...leak.mods}, original=mods.whitebirdOriginal || {...mods};
    delete original.whitebirdOriginal;
    const card=m.players.get(playerId)?.bounties.find(b=>b.id===mods.bountyId)?.card;
    const coins=Math.max(0,Number(original.bountyCoins)||0,card?.payout!=='perfect'&&card?.enemyKey===leak.enemyKey?Number(card.coin)||0:0);
    if(coins>0)original.bountyCoins=coins;
    m.customBank.push({enemyKey:leak.enemyKey, playerId,firstRound:mods.whitebirdRound??m.round, mods:original, bounty:coins>0?{coins,ownerPlayerId:playerId}:null});
  }
}
function carnivalSpawns(m,wave,playerId,side=null){
  if(!m.customConfig?.carnival||!wave)return [];
  const cards=(m.gd.choices.cards?.bounty||[]).filter(card=>draftBounty(card,m.carnivalPool)&&card.payout!=='perfect'&&m.gd.enemy(card.enemyKey)?.rank==='ELITE').sort((a,b)=>String(a.effectId).localeCompare(String(b.effectId)));
  const candidates=[...new Set(cards.map(card=>card.enemyKey))].sort();
  if(m.carnivalEnemyRound?.round!==m.round){const rng=createRng(deriveSeed(m.seed,`custom-carnival:${m.round}`));m.carnivalEnemyRound={round:m.round,key:candidates[Math.floor(rng()*candidates.length)]};}
  const card=cards.find(c=>c.enemyKey===m.carnivalEnemyRound.key);if(!card)return [];
  return bountySpawns(m.gd,m.round,wave,[{id:`custom-carnival:${m.round}`,card:{...card,count:1}}],playerId,{side}).map(s=>({...s,mods:{...s.mods,customCarnival:true,bountyCoins:s.bounty?.coins||0}}));
}
export function decorateBattle(m, opts) {
  const c=m.customConfig; if (!c || opts.flags?.custom) return opts;
  const escalation=c.extraRounds?roundEscalation(m.round):1;
  const extra={enemyHp:c.enemyHp/100*escalation,enemyAtk:c.enemyAtk/100*escalation,enemyAspd:c.enemyAspd/100*escalation,
    allyHp:c.allyHp/100,allyAtk:c.allyAtk/100,allyAspd:c.allyAspd/100,redeploy:c.redeploy/100,layers:c.layers/100,count:c.enemyCount/100*escalation};
  let spawns=opts.spawns||[];
  if (opts.kind==='normal' || opts.kind==='boss' || opts.kind==='hidden') {
    if(c.carnival)for(const player of opts.players||[]){const ps=m.players.get(player.playerId);spawns=[...spawns,...carnivalSpawns(m,(ps?m.bossGroupOf(ps)?.wave:null)||m.wave,player.playerId,player.side)];}
    spawns=scaleSpawns(spawns,c.enemyCount/100*escalation);
  }
  if (opts.kind==='normal' && c.whitebird && [13,18].includes(m.round)) {
    const owner=opts.players[0].playerId, alive=m.alivePlayers();
    const bank=m.customBank.filter(b=>b.playerId===owner || (!alive.some(p=>p.playerId===b.playerId)&&alive[0]?.playerId===owner));
    spawns=[...spawns,...bank.map((b,i)=>({enemyKey:b.enemyKey,time:2+i*.15,routeIndex:0,ownerPlayerId:owner,sourcePlayerId:owner,
      mods:{...b.mods,whitebirdRound:b.firstRound,whitebirdOriginal:b.mods,whitebirdBoost:1+.10*(m.round-b.firstRound)},bounty:b.bounty?{...b.bounty,ownerPlayerId:owner}:null}))];
  }
  if(['normal','boss','hidden'].includes(opts.kind) && c.debt) {
    const alive=m.alivePlayers();
    const lives=m.customCombatLivesRound===m.round?m.customCombatLives:Object.fromEntries(alive.map(p=>[p.playerId,p.lp]));
    const max=Math.max(...alive.map(p=>lives[p.playerId])), receivers=alive.filter(p=>lives[p.playerId]===max).sort((a,b)=>a.seat-b.seat);
    for(const player of opts.players||[]){const owner=player.playerId,index=receivers.findIndex(p=>p.playerId===owner);let remainderSeat=0;
    if(index>=0)for(const dead of m.order.filter(p=>!p.alive&&p.customDebt?.round<m.round)){
      const bounties=(dead.customDebt?.bounties||[]).map(b=>({...b,roundsLeft:b.roundsLeft-(m.round-dead.customDebt.round)})).filter(b=>b.roundsLeft>0);
      let nativeWave=m.wave;
      if(opts.kind!=='normal'){
        m.customDebtWaves ||= new Map();const key=`${m.round}:${dead.playerId}`;
        if(!m.customDebtWaves.has(key)){const bossId=opts.kind==='hidden'?m.hiddenBossId:m.bossId;const rng=createRng(deriveSeed(m.seed,`custom-debt:${key}`));m.customDebtWaves.set(key,buildBossWave(m.gd,rng,m.factions,m.round,{bossId,solo:true}));}
        nativeWave=m.customDebtWaves.get(key);
      }
      const wave=[...withBounties(m.gd,m.round,nativeWave,bounties,dead.playerId),...carnivalSpawns(m,nativeWave,dead.playerId)].filter(s=>s.tag!=='boss'&&s.tag!=='part');
      const scaled=scaleSpawns(wave,c.enemyCount/100*escalation);
      const right=player.side==='R';
      spawns.push(...scaled.map(s=>{
        const remainder=s.count%receivers.length;
        const count=Math.floor(s.count/receivers.length)+((index-remainderSeat+receivers.length)%receivers.length<remainder?1:0);
        remainderSeat=(remainderSeat+remainder)%receivers.length;
        return {...s,count,...(opts.kind!=='normal'?{route:right?mirrorRoute(nativeWave.routes[s.routeIndex]):nativeWave.routes[s.routeIndex]}:{}),...(s.bounty?{bounty:{...s.bounty,ownerPlayerId:owner},mods:{...s.mods,bountyCoins:s.bounty.coins}}:{}),ownerPlayerId:owner,sourcePlayerId:dead.playerId};
      }).filter(s=>s.count>0));
    }}
  }
  return {...opts,spawns,flags:{...opts.flags,custom:extra,customQueue:true}};
}

function mirrorRoute(route){if(!route)return route;const point=p=>Array.isArray(p)?[p[0],20-p[1]]:p;return {...route,start:point(route.start),end:point(route.end),checkpoints:route.checkpoints?.map(p=>Array.isArray(p)?point(p):{...p,pos:point(p.pos)})};}
export function awardFate(m,players,valid=true){
  if(!m.customConfig?.fateWager||!valid||m.customFateRounds?.has(m.round)||!players?.length)return false;
  if(players.some(id=>{const p=m.players.get(id),r=m.lastResults.get(id);return !p?.alive||!r||r.synthetic||r.perfect!==true||(r.leaked||[]).some(l=>l.counted!==false);}))return false;
  m.customFateRounds ||= new Set();m.customFateRounds.add(m.round);
  for(const id of players){const p=m.players.get(id);p.lp=Math.max(0,p.lp)+1;if(m.teamLp!=null)p.lpAtFinal=p.lp;p.dirty();}
  if(m.teamLp!=null)m.teamLp+=players.length;m.markPublic();return true;
}

// Explicit decorators keep custom behavior outside the ordinary flow and its RNG streams.
export function installCustomMatch(Match) {
  const p=Match.prototype;
  p.armDurationLimit=function() {
    if (this._durationTimer || this.ended) return;
    this.durationStartedAt=this.sched.now(); this.durationDeadline=this.durationStartedAt+MATCH_LIMIT_MS;
    this._durationTimer=this.sched.setTimeout(()=>{this._durationTimer=null;if(!this.ended&&!this.disposed)this.finish({victory:false,reason:'duration_limit'});},MATCH_LIMIT_MS);
  };
  p.clearDurationLimit=function(){if(this._durationTimer)this.sched.clearTimeout(this._durationTimer);this._durationTimer=null;};
  const wrap=(key,fn)=>{const original=p[key];p[key]=function(...args){return fn.call(this,original,...args);};};
  wrap('_normalOpts',function(original,ps){return decorateBattle(this,original.call(this,ps));});
  wrap('nextEnemiesFor',function(original,ps){
    if(!this.customConfig)return original.call(this,ps);
    if(this.customConfig.hiddenWar)return [];
    if(!ps.alive || this.round===19)return [];
    const group=this.bossGroupOf(ps),wave=group?.wave||this.wave;if(!wave)return [];
    const spawns=withBounties(this.gd,this.round,wave,ps.bounties,ps.playerId);
    return previewOf(decorateBattle(this,{kind:group?'boss':'normal',spawns,players:[{playerId:ps.playerId}],flags:{}}).spawns);
  });
  wrap('newBattle',function(original,opts){return original.call(this,decorateBattle(this,opts));});
  wrap('_ccField',function(original,rec){return original.call(this,{...rec,opts:decorateBattle(this,rec.opts)});});
  wrap('publicView',function(original){
    const v=original.call(this); v.durationDeadline=this.durationDeadline||0;v.matchPrivacy=this.matchPrivacy;
    if (this.matchPrivacy) for(const row of v.players)delete row.doctorCode;
    if(this.customConfig){v.customConfig=this.customConfig;v.customRulesVersion=this.customRulesVersion;v.customEvaluation=this.customEvaluation;v.roomName=this.opts.roomName;v.customRisk=this.customRisk;v.initialPlayerCount=this.initialPlayerCount;v.baselineKind=this.baselineKind;
      if(this.customConfig.extraRounds){if(this.round===19)v.bossRound=19;if(this.round===15&&!this.hiddenReached)v.hiddenRound=null;}
      if(this.customConfig.hiddenWar){for(const row of v.players){row.bandId=null;row.bonds=[];}if(v.draft)v.draft.picks=Object.fromEntries(Object.keys(v.draft.picks).map(id=>[id,null]));
        v.hiddenWar=true;v.customConfig={...this.customConfig,requiredBonds:[]};v.disabledBonds=[];v.drawnDisabledBonds=[];v.bannedChess=[];v.factions=[];
        if(![PHASE.FINAL_ASSAULT,PHASE.HIDDEN_CORE].includes(this.phase)){v.bossId=null;v.hiddenBossId=null;}
      }
      if(this.round===19 && this.phase!==PHASE.FINAL_ASSAULT){v.bossId=null;v.nextEnemies=[];}
    }
    return v;
  });
  wrap('startCombat',function(original){if(this.customConfig){this.customCombatPlayers=this.alivePlayers().map(p=>p.playerId);this.customCombatLives=Object.fromEntries(this.alivePlayers().map(p=>[p.playerId,p.lp]));this.customCombatLivesRound=this.round;}return original.call(this);});
  wrap('settle',function(original,...args){captureWhitebird(this);const res=original.apply(this,args);this.completedRound=this.round;awardFate(this,this.customCombatPlayers);return res;});
  wrap('startUnite',function(original,plan){
    if(!this.customConfig)return original.call(this,plan);
    const old=this.wave;this.wave={...old,timeLimit:(old?.timeLimit||60)*this.customConfig.unite/this.customConfig.combat};
    const res=original.call(this,plan);this.wave=old;return res;
  });
  wrap('_finishFinal',function(original,hidden,resultOf){if(this.bossPool?.hp<=0)this.completedRound=this.round;return original.call(this,hidden,resultOf);});
  wrap('_pendingLpView',function(original,ps){return this.customConfig?.whitebird?{}:original.call(this,ps);});
  wrap('finishSpDraft',function(original){
    if(this.customConfig && this.sp?.family==='bounty' && this.carnivalDraftRound!==this.round) {
      this.carnivalDraftRound=this.round;this.carnivalDrafts++;
      const kind=this.gd.choices.schedule?.[this.modeId]?.rounds?.[this.round]?.bountyDraft||bountyDraftKind(this.round);
      if(kind!=='initial')this.carnivalPool='boss';
      this.carnivalEnemyRound=null;
    }
    return original.call(this);
  });
  wrap('finish',function(original,outcome){
    if(!this.ended&&!this.disposed&&this.durationDeadline&&this.sched.now()>=this.durationDeadline)outcome={...outcome,victory:false,reason:'duration_limit'};
    if(outcome.reason!=='duration_limit' && this.customConfig && this.teamLp!=null && this.teamLp<=0)outcome={...outcome,victory:false,reason:'defeat'};
    if(this.customConfig?.extraRounds && outcome.victory && this.round>=14 && this.round<19 && outcome.reason!=='duration_limit') {
      this.extraHiddenCleared ||= !!outcome.hiddenCleared;this.bossPool=null;this.teamLp=null;this._finalEnding=null;
      this.startRound(this.round+1);return;
    }
    return original.call(this,{...outcome,hiddenCleared:outcome.hiddenCleared||this.extraHiddenCleared});
  });
}
