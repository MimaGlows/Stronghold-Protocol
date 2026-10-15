import { N_ } from './i18n.js';

export const CUSTOM_VERSION = 2;
export const CUSTOM_SCORE_VERSION = 3;
export const CUSTOM_CAPACITIES = [1,4,5,6];
export const CUSTOM_REQUIRED_LIMITS = Object.freeze({total:3,core:2,addon:1});
export function canRequireBond(selected,id,bonds){const ids=[...new Set([...selected,id])];return ids.length<=CUSTOM_REQUIRED_LIMITS.total&&ids.filter(k=>bonds[k]?.isCore).length<=CUSTOM_REQUIRED_LIMITS.core&&ids.filter(k=>!bonds[k]?.isCore).length<=CUSTOM_REQUIRED_LIMITS.addon;}
export const MATCH_LIMIT_MS = 100 * 60 * 1000;
export const CUSTOM_NUMBERS = {
  capacity: [1, 6, 4, N_('玩家人数'), 'basic'],
  enemyHp: [50, 300, 100, N_('敌人生命值'), 'enemy'],
  enemyAtk: [40, 400, 100, N_('敌人攻击力'), 'enemy'],
  enemyAspd: [40, 400, 100, N_('敌人攻击速度'), 'enemy'],
  enemyCount: [10, 1000, 100, N_('敌人数量'), 'enemy'],
  deployCap: [4, 12, 8, N_('初始同时可部署人数'), 'ally'],
  allyHp: [50, 300, 100, N_('干员生命值'), 'ally'],
  allyAtk: [40, 400, 100, N_('干员攻击力'), 'ally'],
  allyAspd: [40, 400, 100, N_('干员攻击速度'), 'ally'],
  redeploy: [0, 200, 100, N_('干员重新部署时间'), 'ally'],
  supply: [3, 12, 3, N_('干员供给等级'), 'growth'],
  gold: [50, 500, 100, N_('金币获取倍率'), 'growth'],
  layers: [50, 500, 100, N_('盟约层数获取倍率'), 'growth'],
  prep: [60, 200, 100, N_('准备阶段时间'), 'time'],
  combat: [60, 200, 100, N_('作战阶段时间'), 'time'],
  unite: [60, 200, 100, N_('协防阶段时间'), 'time'],
};
export const CUSTOM_FLAGS = {
  carnival: [N_('悬赏狂欢'), 'contracts'], extraRounds: [N_('额外回合'), 'basic'],
  hiddenWar: [N_('隐秘战争'), 'contracts'], lastStand: [N_('背水一战'), 'contracts'],
  oneLife: [N_('万无一失'), 'contracts'], noLeakCap: [N_('落网之鱼'), 'contracts'],
  debt: [N_('债务转移'), 'contracts'], tourist: [N_('观光游客'), 'contracts'],
  wildfire: [N_('野火不息'), 'contracts'], whitebird: [N_('白鸟河滩'), 'contracts'],
  fateWager: [N_('命运赌约'), 'contracts'],
};
export const CUSTOM_GROUPS = {
  basic: N_('基础与盟约'), enemy: N_('敌军'), ally: N_('我方'),
  growth: N_('经济与成长'), time: N_('回合与时间'), contracts: N_('历战合约'),
};
export const CUSTOM_DESCRIPTIONS={
  hiddenWar:N_('隐藏BOSS、敌人信息、盟约信息和玩家的盟约选择。'),
  lastStand:N_('每名玩家初始生命值设为11。'),
  oneLife:N_('每名玩家初始生命值设为1。（与“背水一战”词条排斥）'),
  noLeakCap:N_('取消每回合失去生命值的10命上限。'),
  fateWager:N_('在所有玩家都完美通过一回合时，所有存活的玩家的生命值+1'),
  debt:N_('玩家淘汰后，在接下来的回合中，淘汰玩家本应分配的敌人会全部转移到生命值最高的玩家处。'),
  tourist:N_('生命值耗尽也不会被淘汰，但是在BOSS关卡，合并后的队伍生命值会-10/每位被淘汰的玩家。'),
  wildfire:N_('联防时，联防的玩家的干员会全部重新部署。'),
  whitebird:N_('逃漏敌人不会造成生命损失，也不触发联防；但是所有逃漏的敌人会在BOSS回合的前一回合全部返场，并随时间增强。'),
  carnival:N_('每回合额外加入一种随机精英敌人；第二轮悬赏选择完成后，随机池切换到第二轮悬赏池。额外敌人数量受“敌人数量”倍率影响。击败精英敌人也会掉落赏金。'),
};
/** @returns {Record<string, any>} */
export function defaultCustom() {
  return { version: CUSTOM_VERSION, ...Object.fromEntries(Object.entries(CUSTOM_NUMBERS).map(([k,v]) => [k,v[2]])),
    ...Object.fromEntries(Object.keys(CUSTOM_FLAGS).map(k => [k,false])), requiredBonds: [] };
}
export function checkCustom(raw, bonds = null, {legacy=false} = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = defaultCustom();
  if (Object.keys(raw).some(k => !Object.hasOwn(out,k))) return null;
  if (raw.version != null && ![1,CUSTOM_VERSION].includes(raw.version)) return null;
  out.version=raw.version??CUSTOM_VERSION;
  for (const [k,[min,max]] of Object.entries(CUSTOM_NUMBERS)) {
    const v = raw[k] ?? out[k];
    if (!Number.isInteger(v) || v < min || v > max) return null;
    out[k] = v;
  }
  for (const k of Object.keys(CUSTOM_FLAGS)) {
    if (raw[k] != null && typeof raw[k] !== 'boolean') return null;
    out[k] = raw[k] ?? false;
  }
  if (out.lastStand && out.oneLife) return null;
  if(!CUSTOM_CAPACITIES.includes(out.capacity))return null;
  const required = raw.requiredBonds ?? [];
  if (!Array.isArray(required) || required.length > 32 || required.some(k => typeof k !== 'string' || !/^\w{1,80}$/.test(k) || (bonds && !bonds[k]))) return null;
  out.requiredBonds = [...new Set(required)].sort();
  if(!legacy&&(out.requiredBonds.length>CUSTOM_REQUIRED_LIMITS.total||(bonds&&out.requiredBonds.some(id=>Number(bonds[id].weight)<=0||!canRequireBond(out.requiredBonds,id,bonds)))))return null;
  return out;
}
export function customRoomName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFKC').trim();
  if (!name || /[\p{Cc}\p{Cf}]/u.test(name)) return null;
  const chars = [...new Intl.Segmenter(undefined, {granularity:'grapheme'}).segment(name)];
  return chars.length <= 10 ? name : null;
}
// [ASSUMED] v3 includes usable kill-bounty income, not a prediction of win rate.
export function customScore(c, difficulty, { meanLp = 28, coreProbability = 0.375, addonProbability = 4/15, probabilities = {}, coreIds = new Set(), players = c.capacity,bountyEconomy=null,modelVersion=CUSTOM_SCORE_VERSION } = {}) {
  const base = {FUNNY:200,NORMAL:400,HARD:600,ABYSS:800}[difficulty] || 200;
  const hp = x => x * (1 + .35*Math.max(0,x-2));
  const atk = x => x * (1 + .25*Math.max(0,Math.min(1,(x-2)/2)));
  const enemy = hp(c.enemyHp/100)**.65 * atk(c.enemyAtk/100)**.55 * (c.enemyAspd/100)**.55 * (c.enemyCount/100)**.70;
  const ally = hp(c.allyHp/100)**.45 * atk(c.allyAtk/100)**.85 * (c.allyAspd/100)**.85 * (c.deployCap/8)**.60 * (c.supply/3)**.22 * (c.gold/100)**.25 * (c.layers/100)**.30;
  const time = (c.prep/100)**(-.10) * (c.combat/100)**(-.25) * (c.unite/100)**(-.12) * ((c.redeploy/100+.25)/1.25)**.18;
  const factors = [];
  const add = (on, key, factor) => { if (on) factors.push({key,factor}); };
  add(c.extraRounds,'extraRounds',1.35); add(c.carnival,'carnival',1.20);
  add(c.noLeakCap && !c.tourist,'noLeakCap',1.15);
  add(c.debt && !c.tourist && players>1,'debt',1.15);
  add(c.wildfire,'wildfire',.85); add(c.tourist,'tourist',.20);
  add(!c.tourist && (c.lastStand || c.oneLife),'life',(meanLp/(c.oneLife?1:11))**.35);
  const life=Math.max(1,c.oneLife?1:c.lastStand?11:meanLp);
  add(c.fateWager,'fateWager',(life/(life+.5*(c.extraRounds?19:14)))**.35);
  let bountyEstimate=null;
  if(modelVersion>=3){
    const rounds=c.extraRounds?19:14,usable=rounds-1,ctx=bountyEconomy;
    const income=Math.max(1,ctx?.income?.slice(0,rounds).reduce((n,x)=>n+x,0)||130+(rounds-14)*12);
    const native=ctx?.drafts?.reduce((n,d)=>n+(d.round<=usable?(ctx.pools[d.pool]?.killValue||0)*d.probability:0),0)??24;
    const second=ctx?.secondRound||9,first=Math.min(usable,second-1),last=Math.max(0,usable-first);
    const carnival=c.carnival?first*(ctx?.pools.initial.eliteCoin??2.5)+last*(ctx?.pools.boss.eliteCoin??3):0;
    const debt=c.debt&&!c.tourist&&players>1?.15*(players-1)/players:0;
    const baseline=income+.75*native,estimated=income+.75*(native+carnival)*(c.enemyCount/100)*(1+debt);
    bountyEstimate={income,native,carnival,debt,killProbability:.75,baseline,estimated};
    add(Math.abs(estimated-baseline)>1e-9,'bountyEconomy',(estimated/baseline)**(-.25));
  }
  for (const id of c.requiredBonds) add(true,id,(coreIds.has(id)?.96:.985)**(probabilities[id]??(coreIds.has(id)?coreProbability:addonProbability)));
  // whitebird intentionally never appears in this calculation, including indirect factors.
  const score = Math.max(1,Math.round(base*enemy/ally*time*factors.reduce((n,f)=>n*f.factor,1)));
  return { version:modelVersion, base, score, ratio:score/base, factors, enemy, ally, time,...(bountyEstimate?{bountyEstimate}:{}) };
}
export function customWarnings(c, evaluation) {
  const warnings = [];
  if (evaluation.ratio>=4) warnings.push(N_('极难配置：压力达到基准四倍，开始前需要确认'));
  else if (evaluation.ratio>=2) warnings.push(N_('高难配置：压力达到基准两倍'));
  if (c.enemyCount>=500 || (c.debt && c.enemyCount>=200)) warnings.push(N_('敌群规模较大，超出同时存活上限的敌人将等待生成，可能接近100分钟时限'));
  if (c.extraRounds && (c.prep>=150 || c.combat>=150)) warnings.push(N_('额外回合与较长阶段时间可能触及100分钟总时限'));
  if (c.deployCap>=10 && c.supply===3) warnings.push(N_('部署上限较高，有限共享干员池可能限制编队成型'));
  if (c.whitebird) warnings.push(N_('白鸟河滩不影响难度系数；不触发协防，协防时间和野火不息设置仅保留'));
  if (c.tourist && c.debt) warnings.push(N_('观光游客不会因生命耗尽淘汰，债务转移通常不会触发'));
  return warnings;
}
