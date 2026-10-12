import { PHASE, ERR } from '../../shared/constants.js';
import { COMMUNICATION_PHASES, RADIO_LINES, isPingTarget, communicationCombat, communicationText } from '../../shared/communication.js';
import { fieldTile } from './board.js';
import { bondList, offBondCounts } from './bondsMeta.js';
import { OK, fail } from './match/common.js';

/** Only data already visible on the sender's field may be revealed by a ping. */
function canView(m, ps, target) {
  if (m.fields.length) {
    const fid = m.watchers.get(ps.playerId) || m.fieldOf(ps);
    return m.fields.some((f) => f.fieldId === fid && f.players.includes(target.playerId));
  }
  const pid = (m.watchers.get(ps.playerId) || `n:${ps.playerId}`).slice(2);
  const seen = m.players.get(pid);
  return pid === target.playerId || m._bossMateOf(seen)?.mate === target;
}
function location(m, target, row, col) {
  const f0 = m.fields.find((f) => f.players.includes(target.playerId)), body = f0?.spec?.players?.find((p) => p.playerId === target.playerId);
  const placement = body && ['boss', 'hidden'].includes(f0.kind) ? body.side === 'R' ? 'bossR' : 'bossL' : m.deployFieldOf(target);
  const [r, c] = fieldTile(placement, row, col);
  const f = m.fields.find((f) => f.players.includes(target.playerId));
  const offset = body?.colOffset ?? (f?.kind === 'unite' && f.players.length > 1 && f.players[0] === target.playerId ? 8 : 0);
  return { ownerId: target.playerId, boardRow: row, boardCol: col, row: r, col: c + offset, fieldId: m.fieldOf(target) || `n:${target.playerId}` };
}
export function sendCommunication(m, ps, msg) {
  if (!COMMUNICATION_PHASES.includes(m.phase) || msg.phase !== m.phase || msg.round !== m.round) return fail(ERR.WRONG_PHASE);
  if (msg.t === 'g.radio' && (!Number.isInteger(msg.id) || !RADIO_LINES[msg.id])) return fail(ERR.BAD_MSG);
  if (msg.t === 'g.ping' && !isPingTarget(msg.target)) return fail(ERR.BAD_MSG);
  const e = { t: 'm.communication', round: m.round, phase: m.phase, playerId: ps.playerId, senderName: ps.name };
  if (msg.t === 'g.radio') { e.kind = 'radio'; e.radio = msg.id; }
  else {
    const q = msg.target, target = m.players.get(q.playerId);
    if (!target || target.left) return fail(ERR.BAD_TARGET);
    e.kind = q.kind; e.targetPlayerId = target.playerId; e.targetName = target.name; e.display = {};
    const gd = target.gd || m.gd, combat = communicationCombat(m.phase);
    const privateTarget = ['level', 'funds', 'shop'].includes(q.kind);
    if (privateTarget && (target !== ps || !ps.alive)) return fail(ERR.BAD_TARGET);
    if (['bond', 'tile', 'piece', 'battle-piece', 'enemy'].includes(q.kind) && !canView(m, ps, target)) return fail(ERR.BAD_TARGET);
    switch (q.kind) {
      case 'choice':
      case 'bounty': {
        if (target !== ps || !ps.alive) return fail(ERR.BAD_TARGET);
        const personal = q.choiceId != null;
        const draft = personal ? ps.personalChoice : m.sp;
        if (personal ? m.phase !== PHASE.PREP || draft?.id !== q.choiceId || draft?.round !== m.round
          : m.phase !== PHASE.SP_DRAFT || (q.kind === 'bounty' && draft?.family !== 'bounty') || draft?.taken?.[q.idx] != null) return fail(ERR.WRONG_PHASE);
        const card = draft?.cards?.find((c, i) => (c.idx ?? i) === q.idx);
        if (!card || card.takenBy || card.soldOut || (card.kind === 'item' && !m.itemPool.canGain(card.id)) || (q.kind === 'bounty' && card.kind !== 'bounty' && !gd.choices?.cards?.bounty?.[card.id] && !personal && draft.family !== 'bounty')) return fail(ERR.BAD_TARGET);
        e.display.name = card.name || gd.effect(card.effectId || card.id)?.name || card.id;
        if (!e.display.name) return fail(ERR.BAD_TARGET);
        break;
      }
      case 'band-offer': {
        if (target !== ps || !ps.alive || m.phase !== PHASE.BAND_DRAFT || !gd.bandAllowed(q.bandId) || m.bandTaken(q.bandId,ps.playerId)) return fail(ERR.BAD_TARGET);
        e.display.name=gd.band(q.bandId)?.name || q.bandId; break;
      }
      case 'reward': {
        if (target !== ps || !ps.alive || m.phase !== PHASE.PREP) return fail(ERR.BAD_TARGET);
        const offer=target.privateView().shop.rewardOffer, slot=offer?.slots?.[q.slot];
        if(!slot || slot.sold || slot.id !== q.id)return fail(ERR.BAD_TARGET);
        e.display.name=(slot.kind === 'item' ? gd.item(slot.id) : target.fieldRecord(gd.chess(slot.id)))?.name || slot.id;break;
      }
      case 'battle-piece': {
        if(!combat)return fail(ERR.WRONG_PHASE);
        const f=m.fields.find((f)=>f.battleId===q.battleId && f.players.includes(target.playerId));
        const body=f?.spec?.players?.find((p)=>p.playerId===target.playerId);
        const unit=body?.units?.find((u)=>u.uid===q.uid && u.kind!=='token');
        if(!unit)return fail(ERR.BAD_TARGET);
        const piece=target.find(q.uid)?.piece;
        e.display={name:target.fieldRecord(gd.chess(unit.chessId))?.name || unit.chessId,items:(piece?.items||[]).map((i)=>gd.item(i.id)?.name||i.id)};
        e.location={ownerId:target.playerId,fieldId:f.fieldId,uid:q.uid,battleId:f.battleId};break;
      }
      case 'strategy': e.display.name = gd.band(target.bandId)?.name || ''; break;
      case 'life': {
        const pending = m._pendingLpView(target).pendingLp || 0;
        e.display.n = [PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE].includes(m.phase) ? Math.max(0, Math.round(m.teamLp || 0)) : Math.max(0, target.lp - pending); break;
      }
      case 'bond': {
        const b = bondList(gd, target.bondsView(), { full: true, off: offBondCounts(gd, target) }).find((b) => b.bondId === q.bondId);
        if (!b) return fail(ERR.BAD_TARGET);
        const th = b.thresholds || [];
        e.display = { name: gd.bond(q.bondId)?.name || q.bondId, count: b.count, threshold: th.find((n) => n > b.count) ?? th.at(-1) ?? null, active: !!b.active, off: !!b.off, layers: b.layers }; break;
      }
      case 'tile': {
        if (!target.alive || !target.deployMap().has(`${q.row},${q.col}`) || (combat && target.board.has(`${q.row},${q.col}`))) return fail(ERR.BAD_TARGET);
        e.kind = q.intent === 'location' ? 'tile' : q.intent; e.location = location(m, target, q.row, q.col); break;
      }
      case 'piece': {
        const found = target.find(q.uid);
        if (!found || !target.alive || combat) return fail(ERR.BAD_TARGET);
        const { piece, area } = found;
        if (area === 'board' && piece.kind === 'item') return fail(ERR.BAD_TARGET);
        const u = m.prepFieldMeta(target).units.find((u) => u.uid === q.uid && u.ownerId === target.playerId);
        if (!u) return fail(ERR.BAD_TARGET);
        e.kind = area === 'board' ? 'deployed' : piece.kind === 'item' ? 'item' : 'bench';
        e.display = { name: u.name, items: (piece.items || []).map((it) => gd.item(it.id)?.name || it.id) };
        if (area === 'board') e.location = location(m, target, ...found.key.split(',').map(Number)); break;
      }
      case 'level': e.display.n = target.shop.level; break;
      case 'funds': e.display.n = target.funds; break;
      case 'shop': {
        if (![PHASE.PREP, PHASE.ROUND_START, PHASE.SP_DRAFT].includes(m.phase)) return fail(ERR.WRONG_PHASE);
        const s = target.privateView().shop.slots[q.slot];
        if (!s || s.sold || s.id !== q.id) return fail(ERR.BAD_TARGET);
        const rec = s.kind === 'item' ? gd.item(s.id) : target.fieldRecord(gd.chess(s.id));
        e.kind = s.kind === 'item' ? 'shop-item' : 'shop-chess'; e.display = { name: rec?.name || s.id, n: s.price }; break;
      }
      case 'enemy': {
        if (combat || !m.nextEnemiesFor(target).some((x) => x.enemyKey === q.enemyKey)) return fail(ERR.BAD_TARGET);
        e.display.name = gd.enemy(q.enemyKey)?.name || q.enemyKey; break;
      }
      default: return fail(ERR.BAD_MSG);
    }
  }
  const now = m.sched.now();
  const radio = msg.t === 'g.radio', key = radio ? 'radioTimes' : 'communicationTimes';
  const recent = (ps[key] || []).filter((at) => now - at < 10000);
  if (recent.length >= (radio ? 5 : 40) || (recent.length && now - recent.at(-1) < (radio ? 1000 : 125))) return fail(ERR.RATE);
  ps[key] = [...recent, now];
  e.id = `${m.battlePrefix}:${m.communicationSeq = (m.communicationSeq || 0) + 1}`;
  e.serverNow = now; e.text = communicationText(e);
  m.broadcast(e);
  return OK;
}
