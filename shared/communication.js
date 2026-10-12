// In-match communications are display events, never game-state mutations.
import { PHASE } from './constants.js';
import { t, N_, tName } from './i18n.js';

export const COMMUNICATION_PHASES = Object.freeze([PHASE.BAND_DRAFT, PHASE.ROUND_START, PHASE.SP_DRAFT, PHASE.PREP, PHASE.COMBAT, PHASE.UNITE, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE, PHASE.SETTLE]);
export const RADIO_LINES = Object.freeze([N_('我来兜住！'), N_('怎么会这样！'), N_('真是精彩！'), N_('先升本'), N_('先晋升干员')]);
export const MESSAGE_MS = 8000;
export const MARKER_MS = 4000;
export const HOLD_MS = 300;
const id = (v) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v);
const integer = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
/** Exact shapes: clients cannot inject text or authoritative display values. */
export function isPingTarget(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype || !id(v.playerId)) return false;
  const shapes = { strategy: [], life: [], bond: ['bondId'], tile: ['row', 'col', 'intent'], piece: ['uid'], shop: ['slot', 'id'], level: [], funds: [], enemy: ['enemyKey'], bounty: ['idx', 'choiceId'], choice: ['idx','choiceId'], 'band-offer': ['bandId'], reward: ['slot','id'], 'battle-piece': ['uid','battleId'] };
  if (!Object.hasOwn(shapes, v.kind) || Object.keys(v).some((k) => !['kind', 'playerId', ...shapes[v.kind]].includes(k))) return false;
  if (v.kind === 'band-offer') return id(v.bandId);
  if (v.kind === 'battle-piece') return integer(v.uid,1,2 ** 31) && id(v.battleId);
  if (v.kind === 'reward') return integer(v.slot,0,9) && id(v.id);
  if (v.kind === 'bounty' || v.kind === 'choice') return integer(v.idx, 0, 5) && (v.choiceId === undefined || id(v.choiceId));
  if (v.kind === 'bond') return id(v.bondId);
  if (v.kind === 'piece') return integer(v.uid, 1, 2 ** 31);
  if (v.kind === 'tile') return integer(v.row, 0, 18) && integer(v.col, 0, 20) && ['location', 'danger', 'missing', 'good'].includes(v.intent);
  if (v.kind === 'shop') return integer(v.slot, 0, 9) && id(v.id);
  if (v.kind === 'enemy') return id(v.enemyKey);
  return true;
}
export const communicationCombat = (phase) => [PHASE.COMBAT, PHASE.UNITE, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE].includes(phase);

/** Format accepted data, also used by replay; player codes are never rendered. */
export function communicationText(e) {
  const d = e.display || {}, sender = e.senderName || '', owner = e.playerId === e.targetPlayerId ? t('自己') : e.targetName || '';
  const p = { sender, owner, name: tName(d.name || ''), n: d.n ?? 0 };
  switch (e.kind) {
    case 'choice': case 'band-offer': case 'reward':
    case 'bounty': return t('{sender}想要选择{name}', { sender, name: tName(d.name || '') });
    case 'radio': return `${sender}：${t(RADIO_LINES[e.radio] || '')}`;
    case 'strategy': return t('{sender}标记了{owner}的{name}策略', { ...p, name: d.name ? tName(d.name) : t('未选择') });
    case 'life': return t('{sender}标记了{owner}的生命值剩余{n}', { ...p, owner: e.targetName || '' });
    case 'bond': return t('{sender}标记了{owner}的{name}盟约，{active}（{count}/{threshold}），层数：{layers}', { ...p, active: d.active ? t('已激活') : t('未激活'), count: d.count, threshold: d.threshold ?? '-', layers: d.layers }) + (d.off ? ` · ${t('本局禁用')}` : '');
    case 'tile': return t('{sender}标记了{owner}的一处位置', p);
    case 'danger': return t('{sender}警告{owner}可能有危险。', p);
    case 'missing': return t('{sender}提示{owner}敌人已不见踪影', p);
    case 'good': return t('{sender}认为{owner}这个地方很不错！', p);
    case 'battle-piece':
    case 'deployed': return t('{sender}标记了{owner}的{name}', p) + (d.items?.length ? t('，持有{items}', { items: d.items.map((name) => tName(name)).join(t('和')) }) : t('，未持有装备'));
    case 'bench': return t('{sender}标记了{owner}尚未部署的{name}', p);
    case 'item': return t('{sender}标记了{owner}尚未装备的{name}', p);
    case 'level': return t('{sender}现在的等级为{n}', p);
    case 'shop-chess': return t('{sender}标记了一位待购买干员{name}，费用{n}', p);
    case 'shop-item': return t('{sender}标记了一位待购买装备{name}，费用{n}', p);
    case 'funds': return t('{sender}当前还剩下{n}G', p);
    case 'enemy': return t('{sender}标记了一名敌人：{name}', p);
    default: return '';
  }
}

export function wheelDirection(dx, dy) {
  if (Math.hypot(dx, dy) < 22) return 'cancel';
  return Math.abs(dx) > Math.abs(dy) ? dx > 0 ? 'missing' : 'good' : dy < 0 ? 'danger' : 'cancel';
}
/** Random access uses the playback clock, not wall time. Old archives have no track. */
export function communicationsAt(track, at, round) {
  const events = (track || []).filter((e) => e.at <= at && at - e.at < MESSAGE_MS);
  return { messages: events.slice(-5), markers: events.filter((e) => e.location && e.round === round && at - e.at < MARKER_MS) };
}

/** Explicit seek revision makes even a small forward seek silent. */
export function crossedReplayRadio(track, old, current) {
  return !!(old?.playing && current.playing && old.revision === current.revision && old.who === current.who &&
    current.time > old.time && current.time - old.time < 500 &&
    (track || []).some((e) => e.kind === 'radio' && e.at > old.time && e.at <= current.time));
}
