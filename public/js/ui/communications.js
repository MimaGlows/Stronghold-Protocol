import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Icon } from './components.js';
import { COMMUNICATION_PHASES, RADIO_LINES, communicationCombat, communicationText, communicationsAt, crossedReplayRadio } from '../../../shared/communication.js';
import { t } from '../../../shared/i18n.js';
import { createStore, store, useStore, serverNow } from '../store.js';
import { net } from '../net.js';
import { audio } from '../audio.js';
import { settingsStore, hotkeyMigration } from './settings.js';
import { actionForKey, shortcutFor, hotkeyLabel, deployFieldOf, boardTileOf, deployMap } from './gameLogic.js';
import { createCommunicationInput } from './communicationInput.js';
import { toast, toastError } from './toasts.js';

export const communicationStore = createStore({ events: [], generation: 0 });
let installed = false, lastSound = -Infinity, migrationShown = false;
export function installCommunications() {
  if (installed) return;
  installed = true;
  const reset = () => communicationStore.set((s) => ({ events: [], generation: s.generation + 1 }));
  net.on('profileChanging', reset);
  net.on('status', (s) => { if (s.status !== 'online') reset(); });
  store.subscribe((s, prev) => { if (s.room?.code !== prev.room?.code || s.room?.inMatch !== prev.room?.inMatch || s.me.playerId !== prev.me.playerId) reset(); });
  net.on('m.communication', (e) => {
    const s = store.get();
    if (!s.room?.inMatch || e.round !== s.match.public?.round || !COMMUNICATION_PHASES.includes(e.phase)) return;
    const old = communicationStore.get().events;
    if (old.some((x) => x.id === e.id)) return;
    const now = serverNow();
    communicationStore.set({ events: [...old.filter((x) => now - x.at < 8000), { ...e, at: Math.min(e.serverNow, now) }].slice(-40) });
    if (e.kind === 'radio' && now - lastSound >= 1000) { lastSound = now; audio.sfx('yourTurn', { volume: 0.5 }); }
  });
}

const glyph = (e) => e.kind === 'good' ? html`<${Icon} name="thumbsUp" class="communication-thumb" />` : ({ danger: '!', missing: '?', radio: '▥' }[e.kind] || '◇');
/** Shared display-only layer: feed lifetime and geometry use the supplied live/replay clock. */
export function CommunicationFeed({ events = [], time, round, view, fieldId, owners = [] }) {
  const [positions, setPositions] = useState([]);
  const recent = communicationsAt(events, time, round), live = useRef(null);
  live.current = { recent, view, fieldId, owners };
  useEffect(() => {
    let handle;
    const update = () => {
      const s = live.current;
      const marks = s.recent.markers.filter((e) => s.owners.includes(e.location.ownerId) || s.fieldId === e.location.fieldId);
      const next = marks.map((e) => ({ e, point: e.location.uid != null ? s.view?.unitScreen(e.location.ownerId,e.location.uid) : s.view?.fieldTileScreen(e.location.row, e.location.col) })).filter((x) => x.point && Number.isFinite(x.point.x) && Number.isFinite(x.point.y));
      setPositions((prev) => JSON.stringify(prev) === JSON.stringify(next) ? prev : next);
      handle = requestAnimationFrame(update);
    };
    handle = requestAnimationFrame(update); return () => cancelAnimationFrame(handle);
  }, []);
  return html`<div class="communication-feed" role="log" aria-live="polite" aria-label=${t('标点与无线电消息')}>
    ${recent.messages.map((e) => html`<div key=${e.id} class=${`communication-line is-${e.kind}`} style=${`opacity:${Math.min(1, Math.max(0, (8000 - (time - e.at)) / 400))}`}><span aria-hidden="true">${glyph(e)}</span>${communicationText(e)}</div>`)}
  </div><div class="communication-markers" aria-hidden="true">${positions.map(({ e, point }) => html`<div key=${e.id} class=${`communication-marker is-${e.kind}`} style=${`left:${point.x}px;top:${point.y}px;opacity:${Math.min(1, Math.max(0, (4000 - (time - e.at)) / 400))}`}><b>${glyph(e)}</b><small>${e.senderName}</small></div>`)}</div>`;
}

export function resolveCommunicationTarget(e, { view, pub, myId, ownerId, stage, priv, field }) {
  const dom = e.target?.closest?.('[data-comm]');
  if (dom) {
    const playerId = dom.dataset.player || ownerId, kind = dom.dataset.comm;
    if (kind === 'band-offer') return {target:{kind,playerId:myId,bandId:dom.dataset.band}};
    if (kind === 'bounty' || kind === 'choice') return { target: { kind, playerId: myId, idx: Number(dom.dataset.idx), ...(dom.dataset.choiceId ? { choiceId: dom.dataset.choiceId } : {}) } };
    if (kind === 'shop' || kind === 'reward') return { target: { kind, playerId: myId, slot: Number(dom.dataset.slot), id: dom.dataset.id } };
    if (kind === 'level' || kind === 'funds') return { target: { kind, playerId: myId } };
    if (kind === 'enemy') return { target: { kind, playerId, enemyKey: dom.dataset.enemy } };
    if (kind === 'bond') return { target: { kind, playerId, bondId: dom.dataset.bond } };
    return { target: { kind, playerId } };
  }
  if (!e.target?.closest?.('.gm__field')) return null;
  const hit = view?.pickCommunication(e.clientX, e.clientY);
  if (!hit) return null;
  const combat = communicationCombat(pub.phase);
  if (hit.type === 'enemy') return combat ? null : { target: { kind: 'enemy', playerId: ownerId, enemyKey: hit.enemyKey } };
  if (hit.type === 'unit') {
    if (hit.unit?.side === 'enemy' || !hit.unit?.uid) return null;
    if (combat) {
      const battle=pub.fields?.find((f)=>f.fieldId===field?.fieldId);
      const battleId=field?.battleId || battle?.battleId;
      if(!battleId || hit.unit.kind !== 'op')return null;
      return {target:{kind:'battle-piece',playerId:hit.unit.ownerId,uid:hit.unit.uid,battleId}};
    }
    const playerId = hit.unit.ownerId || ownerId;
    const [r, c] = hit.unit.pos || [hit.unit.y, hit.unit.x];
    const [row, col] = boardTileOf(deployFieldOf(pub, playerId), r, c);
    const tile = deployMap(stage, { field: deployFieldOf(pub, playerId) }).has(`${row},${col}`) ? { kind: 'tile', playerId, row, col, intent: 'location' } : null;
    return { target: { kind: 'piece', playerId, uid: hit.unit.uid }, tile };
  }
  if (hit.type === 'piece') {
    const target = { kind: 'piece', playerId: ownerId, uid: hit.uid };
    const tile = hit.area === 'board' ? { kind: 'tile', playerId: ownerId, row: hit.row, col: hit.col, intent: 'location' } : null;
    return combat ? null : { target, tile };
  }
  if (hit.type !== 'tile') return null;
  let playerId = ownerId, placement = deployFieldOf(pub, ownerId), offset = 0;
  const shown = pub.fields?.find((f) => f.fieldId === field?.fieldId) || pub.fields?.find((f) => f.players.includes(ownerId));
  const boss = pub.round === pub.bossRound || pub.round === pub.hiddenRound;
  if (boss && hit.space === 'field') {
    const side = hit.col > 10 ? 'R' : 'L';
    const alive = pub.players.filter((p) => p.alive !== false).sort((a, b) => a.seat - b.seat);
    const index = alive.findIndex((p) => p.playerId === ownerId);
    const members = shown?.players || alive.slice(index - index % 2, index - index % 2 + 2).map((p) => p.playerId);
    const specs = field?.spec?.players || [];
    playerId = specs.find((p) => members.includes(p.playerId) && p.side === side)?.playerId
      || members.find((pid) => deployFieldOf(pub, pid) === (side === 'R' ? 'bossR' : 'bossL'));
    if (!playerId) return null;
    placement = side === 'R' ? 'bossR' : 'bossL';
  } else if (shown?.kind === 'unite' && hit.space === 'field' && shown.players.length > 1) {
    const preferred = shown.players.indexOf(ownerId), index = hit.col === 10 && preferred >= 0 ? preferred : hit.col >= 10 ? 0 : 1;
    playerId = shown.players[index]; offset = index === 0 ? 8 : 0; placement = 'normal';
  }
  const [row, col] = hit.space === 'field' ? boardTileOf(placement, hit.row, hit.col - offset) : [hit.row, hit.col];
  if (!deployMap(stage, { field: placement }).has(row + ',' + col)) return null;
  const units = field?.units || [];
  if (combat && (units.some((u) => u.side === 'ally' && u.ownerId === playerId && (u.pos?.[0] ?? u.y) === hit.row && (u.pos?.[1] ?? u.x) === hit.col)
    || playerId === myId && priv?.board?.some((u) => u.row === row && u.col === col))) return null;
  const tile = { kind: 'tile', playerId, row, col, intent: 'location' };
  return { target: tile, tile };
}

export function Communications({ view, pub, myId, ownerId, field, priv, stage, spectator, blocked, emoteOpen, onCloseEmote }) {
  const s = useStore((s) => s, Object.is, communicationStore);
  const conn = useStore((s) => s.connection.status);
  const [ui, setUi] = useState({ active: false, radio: false, wheel: null });
  const [now, setNow] = useState(serverNow());
  const current = useRef(null), controller = useRef(null), radioPanel = useRef(null), radioBottom = useRef(null);
  const enabled = !spectator && conn === 'online' && COMMUNICATION_PHASES.includes(pub.phase);
  const change = (patch) => { setUi((s) => ({ ...s, ...patch })); if (patch.active || patch.radio) onCloseEmote(); };
  const submit = async (target, radio) => {
    const initial = current.current;
    if (!initial.enabled || net.status !== 'online') { toast(t('连接已中断，通讯未发送'), 'warn'); return; }
    const generation = communicationStore.get().generation;
    try { await net.request(radio == null ? 'g.ping' : 'g.radio', { round: initial.pub.round, phase: initial.pub.phase, ...(radio == null ? { target } : { id: radio }) }, { timeout: 4000 }); }
    catch (e) { if (generation === communicationStore.get().generation) toastError(e); }
  };
  current.current = { enabled, blocked: !!blocked || !!document.activeElement?.matches('input,textarea,select,[contenteditable=true]') || !!document.querySelector('.modal, .guide, .history-overlay'), pub, view, myId, ownerId, stage, priv, field, radio: ui.radio,
    contains: (el) => !!el?.closest?.('.screen.gm:not(.replay-player), .screen.draft-screen, .screen.draft'), action: (e) => shortcutFor(e, settingsStore.get().keys),
    releasePing: (e) => actionForKey(e, settingsStore.get().keys) === 'ping' };
  useEffect(() => {
    controller.current = createCommunicationInput({ surface: window, get: () => current.current,
      resolve: (e) => resolveCommunicationTarget(e, current.current), send: (target) => submit(target), change });
    const timer = setInterval(() => {
      setNow(serverNow()); if (current.current.blocked) controller.current.cancel();
      const shop = document.querySelector('.screen.gm:not(.replay-player) .shopbar');
      if (shop) radioBottom.current = Math.max(8, innerHeight - shop.getBoundingClientRect().top + 8);
      if (radioPanel.current) {
        const bottom = radioBottom.current ?? parseFloat(getComputedStyle(document.documentElement).fontSize) * 3.45;
        radioPanel.current.style.bottom = `${bottom}px`;
        radioPanel.current.style.maxHeight = `${Math.max(88, innerHeight - bottom - 16)}px`;
      }
    }, 100);
    return () => { clearInterval(timer); controller.current.dispose(); controller.current = null; };
  }, []);
  useEffect(() => {
    const field = document.querySelector('.screen.gm:not(.replay-player) .gm__field');
    if (field && ui.active) { const old = field.style.touchAction; field.style.touchAction = 'none'; return () => { field.style.touchAction = old; }; }
  }, [ui.active]);
  useEffect(() => { controller.current?.cancel(); }, [s.generation, pub.round, pub.phase, enabled, emoteOpen]);
  useEffect(() => { if (hotkeyMigration.length && !migrationShown) { migrationShown = true; toast(t('通讯快捷键已启用，出售默认改为 C；调整详情见设置'), 'info'); } }, []);
  const prep = !communicationCombat(pub.phase);
  const mate = field?.prep ? field.mate?.playerId : priv?.bossMate?.playerId;
  const owners = prep ? [ownerId, mate].filter(Boolean) : pub.fields?.find((f) => f.fieldId === field?.fieldId)?.players || [];
  return html`<${CommunicationFeed} events=${s.events} time=${Math.max(now, s.events.at(-1)?.at || 0)} round=${pub.round} view=${view} fieldId=${prep ? null : field?.fieldId} owners=${owners} />
    ${enabled ? html`<div class="communication-controls" data-communication-control>
      <button class=${ui.active ? 'is-active' : ''} type="button" aria-pressed=${ui.active} onClick=${() => controller.current?.touchToggle()}>${t('标点')} <kbd>${hotkeyLabel(settingsStore.get().keys.ping)}</kbd></button>
      <button type="button" aria-expanded=${ui.radio} onClick=${() => { controller.current?.cancel(); change({ radio: !ui.radio }); }}>${t('无线电')} <kbd>${hotkeyLabel(settingsStore.get().keys.radio)}</kbd></button>
    </div>` : null}
    ${ui.active ? html`<div class="communication-hint">${t('单击标记 · 长按左键展开转盘')}</div>` : null}
    ${ui.radio ? html`<aside ref=${radioPanel} class="radio-menu brackets" data-communication-control role="dialog" aria-label=${t('无线电')}><header>${t('无线电')}<button type="button" aria-label=${t('关闭')} onClick=${() => change({ radio: false })}>×</button></header>${RADIO_LINES.map((line, i) => html`<button type="button" onClick=${() => { change({ radio: false }); submit(null, i); }}>${t(line)}</button>`)}</aside>` : null}
    ${ui.wheel ? html`<div class="ping-wheel" role="menu" aria-label=${t('标点转盘')} style=${`left:${ui.wheel.x}px;top:${ui.wheel.y}px`}>
      ${[['danger', '!', t('危险')], ['missing', '?', t('敌人不见踪影')], ['good', null, t('这个地方很不错')], ['cancel', '×', t('取消')]].map(([id, mark, label]) => html`<div class=${`ping-wheel__${id}${ui.wheel.direction === id ? ' is-selected' : ''}`} role="menuitem" aria-label=${label}><b>${id === 'good' ? glyph({ kind: 'good' }) : mark}</b></div>`)}
    </div>` : null}`;
}

/** Replay audio only on uninterrupted forward playback, not on seek or player changes. */
export function useCommunicationReplayAudio(track, time, playing, who, revision) {
  const previous = useRef(null), last = useRef(-Infinity);
  useEffect(() => {
    const current = { time, playing, who, revision }, now = performance.now();
    if (crossedReplayRadio(track, previous.current, current) && now - last.current >= 1000) {
      last.current = now; audio.sfx('yourTurn', { volume: 0.5 });
    }
    previous.current = current;
  }, [track, time, playing, who, revision]);
}
