import { t } from '../../../shared/i18n.js';
// Pure random-access helpers shared by UI and tests; a seek never submits a live-game intent.
export function floorIndex(list, value, key = 'at') {
  let lo = 0, hi = list.length - 1, answer = -1;
  while (lo <= hi) { const mid = (lo + hi) >>> 1; if (list[mid][key] <= value) { answer = mid; lo = mid + 1; } else hi = mid - 1; }
  return answer;
}
export function stateAt(record, time, playerId) {
  const node = record.nodes[Math.max(0, floorIndex(record.nodes, time))];
  let state = node?.players?.[playerId];
  // A phase checkpoint is a full state, so actions from earlier phases cannot override it.
  for (let i = floorIndex(record.events, time); i >= 0; i--) {
    const e = record.events[i]; if (e.at < (node?.at ?? 0)) break;
    if (e.at === node?.at && e.seq < node.seq) continue;
    if (e.playerId === playerId) { state = e.state; break; }
  }
  const fields = record.fields.filter((f) => f.players.includes(playerId) && f.at <= time && time <= (f.endedAt ?? f.at + (f.endGt ?? 0) / f.speed * 1000));
  const settled = node?.phase === 'SETTLE' ? record.fields.findLast((f) => f.players.includes(playerId) && f.round === node.round && f.at <= time) : null;
  return { node, state, field: fields.at(-1) || settled || null };
}
// Archived clock only: playback pause/seek and original match pauses must never use Date.now().
export function hudAt(record, time) {
  const node = record.nodes[Math.max(0, floorIndex(record.nodes, time))];
  const tracked = record.publicTrack?.[floorIndex(record.publicTrack, time)];
  const pub = tracked && tracked.at >= (node?.at || 0) ? tracked.public : node?.public || {};
  const pausedMs = (record.pauses || []).reduce((sum, p) => sum + Math.max(0, Math.min(time, p.to ?? time) - Math.max(tracked?.at >= (node?.at || 0) ? tracked.at : node?.at ?? 0, p.from)), 0);
  const remaining = pub.deadline > 0 && Number.isFinite(pub.serverNow)
    ? Math.max(0, Math.ceil((pub.deadline - pub.serverNow - (time - (tracked?.at >= node.at ? tracked.at : node.at) - pausedMs)) / 1000)) : null;
  const players = record.participants.map((p) => {
    const base = pub.players?.find((x) => x.playerId === p.playerId) || p;
    const current = stateAt(record, time, p.playerId), priv = current.state?.private;
    const progress = current.field?.frames?.length ? fieldFrame(current.field, time).frame?.progress
      : current.field?.progressTrack?.[floorIndex(current.field.progressTrack, fieldFrame(current.field,time).gt,'gt')]?.progress;
    const pendingLp = pub.phase === 'COMBAT' ? Math.min(10, progress?.leaks ?? base.pendingLp ?? 0) : pub.phase === 'UNITE' ? Math.min(10, progress?.left?.[p.playerId] ?? base.uniteLeft ?? base.pendingLp ?? 0) : 0;
    return { ...base, ...p, fieldId: `n:${p.playerId}`, lp: priv?.lp ?? base.lp, bandId: priv?.bandId ?? base.bandId,
      pendingLp, uniteLeft: progress?.left?.[p.playerId] ?? base.uniteLeft, ready: priv?.ready ?? base.ready, status: pub.phase === 'PREP' ? priv?.ready ? 'ready' : 'acting' : base.status };
  });
  return { pub: { ...pub, players }, remaining, clock: (pub.serverNow || record.startedAt + (node?.at || 0)) + time - (tracked?.at >= (node?.at || 0) ? tracked.at : node?.at || 0) - pausedMs };
}
export function fieldFrame(field, time) {
  const pausedMs = (field.pauses || []).reduce((sum, p) => sum + Math.max(0, Math.min(time, p.to ?? time) - Math.max(field.at, p.from)), 0);
  const gt = Math.max(0, Math.min(field.endGt || 0, (time - field.at - pausedMs) / 1000 * field.speed));
  const index = Math.max(0, floorIndex(field.frames || [], gt, 'gt'));
  return { gt, index, frame: field.frames?.[index], next: field.frames?.[index + 1] };
}
export function sceneMeta(field, index) {
  const infos = new Map((field.meta?.units || []).map((u) => [u.id, u]));
  for (let i = 0; i <= index; i++) for (const e of field.frames[i]?.ev || []) if (e[0] === 'spawn') infos.set(e[1].id, e[1]);
  return { ...field.meta, fieldId: field.fieldId, kind: field.kind, stageId: field.spec.stageId, rect: field.spec.rect, units: [...infos.values()] };
}
export function fmtTime(ms) { const seconds = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; }

export function expiryHint(record, _now) {
  if (record.status === 'expired') return record.expiryReason === 'version' ? t('该回放已因版本更新过期') : record.expiryReason === 'size-limit' ? t('回放超过储存上限，结算记录已保留') : t('该回放已过期，统计记录仍保留');
  if (record.status === 'incompatible') return t('回放格式或生成引擎不兼容，原始轨道已保留');
  return t('仅保留虚拟账号最近30条对局记录中的回放，兼容的更新不会使其过期');
}
