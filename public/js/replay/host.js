import { createReplayCache, chunkAt } from './chunks.js';
import { prepSnapshot } from '../ui/prepSnapshot.js';
import { CommunicationFeed as CommunicationDisplay, useCommunicationReplayAudio } from '../ui/communications.js';
import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, Icon, PhaseBanner, ResultDialog } from '../ui/components.js';
import { useStore } from '../store.js';
import { settingsStore } from '../ui/settings.js';
import { shortcutFor, phaseBanner, phaseMode, phaseTotalSeconds, prepCameraFor, snapHud, isCombatPhase, indexPieces, previewEnemyKey, uniteResultBox, battleResultBox } from '../ui/gameLogic.js';
import { useGameData, UnitThumb } from '../ui/gameComponents.js';
import { useFieldView } from '../ui/fieldHost.js';
import { ResultScreen, LineupThumb } from '../screens/result.js';
import { RestrictionsDialog } from './restrictions.js';
import { t, N_ } from '../../../shared/i18n.js';
import { PHASE, PHASE_NAMES } from '../../../shared/constants.js';
import { historyStore, openHistory, closeHistory, fetchReplay } from './history.js';
import { stateAt, hudAt, fieldFrame, sceneMeta, fmtTime } from './timeline.js';

import { TeamPanel } from '../ui/teamPanel.js';
import { BondPopup } from '../ui/bondStrip.js';
import { DetailPanel, resolveDetail } from '../ui/detailPanel.js';
import { TopBar, liveLp } from '../ui/hud.js';
import { ShopBar } from '../ui/shopBar.js';
import { BondStrip } from '../ui/bondStrip.js';
import { EffectsList } from '../ui/effectsList.js';
import { EnemyDrawer } from '../ui/enemyDrawer.js';
import { BriefingScreen } from '../screens/briefing.js';
import { BandDraftScreen } from '../screens/bandDraft.js';
import { ChoiceView } from '../ui/choiceOverlay.js';
import { normalizeSp } from '../ui/gameLogic.js';
import { FullscreenButton } from '../ui/device.js';

const LABELS = { buy: N_('购买'), move: N_('布阵 / 撤退'), sell: N_('出售'), equip: N_('配发装备'), art: N_('使用道具'), destroy: N_('销毁'),
  reward: N_('选择奖励'), choice: N_('选择机变'), band: N_('选择策略'), loadout: N_('选择技能 / 模组'), refresh: N_('刷新商店'), freeze: N_('冻结商店'), level: N_('升级商店'), ready: N_('准备状态') };
function Decision({ event, onClick, selected }) {
  const item = event.detail?.item || event.detail?.unit;
  const gd = useGameData();
  const args = event.detail?.args || [];
  const name = item?.id ? (gd.chess(item.id)?.name || gd.item(item.id)?.name || item.name || item.id) : event.type === 'band' ? gd.band(args[0])?.name || args[0] : item?.name || '';
  const target = args[1];
  const position = event.type === 'move' && target ? target.area === 'board' ? t('战场 ({row}, {col})', { row: target.row, col: target.col }) : t('整备区 {n}', { n: (target.idx ?? 0) + 1 }) : '';
  const kit = event.type === 'loadout' ? Object.entries(args[0] || {}).map(([id, entry]) => `${gd.chess(id)?.name || id} · S${(entry.skill ?? 0) + 1} · ${entry.module || '—'}`).join(' / ') : '';
  const equipped = event.type === 'equip' ? [...(event.state?.private?.board || []), ...(event.state?.private?.hand || []), ...(event.state?.private?.temp || [])].filter(Boolean).find((u) => u.uid === args[1]) : null;
  return html`<button class=${`replay-event${selected ? ' is-active' : ''}`} onClick=${onClick}>
    <span class="num">${fmtTime(event.at)}</span><span><b>${t(LABELS[event.type] || event.type)}</b> ${name}${position || kit || equipped ? html`<small>${position || kit || gd.chess(equipped?.id)?.name} ${event.type === 'move' ? args[2] || '' : ''}</small>` : null}</span>
    ${item?.price != null ? html`<span class="num t-gold">−${item.price}</span>` : null}
  </button>`;
}
function SelectionSummary({ priv, gd }) {
  const nameOf = (id) => gd.chess(id)?.name || gd.list('chess').find((c) => c.charId === id)?.name || id;
  const kits = Object.entries(priv?.loadout || {}), picks = Object.entries(priv?.diy || {});
  return html`<details class="replay-kits"><summary>${t('干员配置')}</summary><div>
    ${kits.map(([id, kit]) => html`<p>${nameOf(id)} · S${(kit.skill ?? 0) + 1} · ${kit.module || '—'}</p>`)}
    ${picks.map(([id, pick]) => html`<p>${nameOf(id)} → ${nameOf(pick.charId)} · S${(pick.skillIndex ?? 0) + 1} · ${pick.uniEquipId || '—'}</p>`)}
    ${(priv?.standIns || []).map((id) => html`<p>${nameOf(id)} · ${t('替补')}</p>`)}
    ${!kits.length && !picks.length && !priv?.standIns?.length ? html`<p>${t('使用默认干员配置')}</p>` : null}
  </div></details>`;
}
function ReplayPlayer({ record, entry, onBack }) {
  const seekRevision = useRef(0);
  const cache = useRef(createReplayCache());
  const [loadedChunk, setLoadedChunk] = useState(null), [chunkError, setChunkError] = useState('');
  const [time, setTime] = useState(0), [playing, setPlaying] = useState(false), [speed, setSpeed] = useState(1);
  const [who, setWho] = useState(entry.playerId || record.participants[0]?.playerId), [info, setInfo] = useState(false);
  const [detailTarget, setDetailTarget] = useState(null), [bond, setBond] = useState(null);
  const [actionsOpen, setActionsOpen] = useState(true), [controlsOpen, setControlsOpen] = useState(true);
  const [drawer, setDrawer] = useState(null), [pen, setPen] = useState(false), [collapsed, setCollapsed] = useState(false);
  const controlsRef = useRef(null);
  useEffect(() => { if (!controlsRef.current) return; const el = controlsRef.current; const resize = () => el.parentElement.style.setProperty('--replay-controls-height', `${el.offsetHeight}px`); const observer = new ResizeObserver(resize); observer.observe(el); resize(); return () => observer.disconnect(); }, []);
  const host = useRef(null), drawing = useRef({ key: null, index: -1, time: -1 }), drawingView = useRef(null), clock = useRef(null);
  const { view } = useFieldView(host);
  const current = useMemo(() => stateAt(record, time, who), [record, time, who]);
  const gd = useGameData();
  const { pub, clock: frozenAt } = useMemo(() => hudAt(record, time), [record, time]);
  const priv = current.state?.private;
  const prep = current.node?.phase === PHASE.PREP;
  const banner = phaseBanner(pub.phase, pub, { alive: priv?.alive !== false });
  const settledField = record.fields.findLast((f) => f.kind === 'normal' && f.round === pub.round && f.players.includes(who));
  const resultBox = pub.phase === PHASE.SETTLE ? uniteResultBox(pub.uniteResult, who) || (settledField ? battleResultBox({ leaks: settledField.frames?.at(-1)?.progress?.leaks ?? settledField.result?.perPlayer?.[who]?.leaked?.filter((l) => l.counted !== false).length ?? 0, cap: gd.config?.lpCapPerRound }) : null) : null;
  const wantedField = current.field;
  const gt = wantedField ? fieldFrame(wantedField,time).gt : 0;
  const chunkIndex = wantedField?.chunks ? chunkAt(wantedField,gt) : null;
  const chunkKey = chunkIndex == null ? null : wantedField.id + ':' + chunkIndex;
  const activeField = chunkKey ? loadedChunk?.key === chunkKey ? {...wantedField,meta:loadedChunk.data.meta,frames:loadedChunk.data.frames,restoreEvents:loadedChunk.data.restoreEvents,chunkKey} : null : wantedField;
  const trackReady = !chunkKey || !!activeField;
  useEffect(() => {
    if(!chunkKey)return;
    const existing=cache.current.get(chunkKey);
    if(existing){setLoadedChunk({key:chunkKey,data:existing});return;}
    const controller=new AbortController();setChunkError('');setLoadedChunk(null);
    void fetchReplay(entry,undefined,false,{tracks:true,field:wantedField.trackField,chunk:chunkIndex,signal:controller.signal}).then((data)=>{
      if(controller.signal.aborted)return;
      cache.current.put(chunkKey,data,wantedField.chunks[chunkIndex].bytes);
      setLoadedChunk({key:chunkKey,data});
    }).catch((e)=>{if(!controller.signal.aborted){setChunkError(e.message);setPlaying(false);}});
    return()=>controller.abort();
  },[chunkKey]);
  useEffect(()=>()=>cache.current.clear(),[]);
  const frame = activeField?.frames?.length ? fieldFrame(activeField, time).frame : null;
  const hud = snapHud(frame?.snap);
  const player = pub.players.find((p) => p.playerId === who);
  const live = liveLp(null, { phase: pub.phase, round: pub.round, lp: priv?.lp, leaks: player?.pendingLp || 0, cap: gd.config?.lpCapPerRound, alive: priv?.alive !== false, uniteLeft: player?.uniteLeft });
  const elapsed = time - (current.node?.at || 0) - (record.pauses || []).reduce((sum, p) => sum + Math.max(0, Math.min(time, p.to ?? time) - Math.max(current.node?.at || 0, p.from)), 0);
  useEffect(() => { setPen(false); setDrawer(null); }, [current.node?.phase, who]);
  const offBonds = useMemo(() => new Set(record.restrictions.disabledBonds || []), [record]);
  const openDetail = (id, kind, count) => { setBond(null); setDetailTarget({ id, kind, count }); };
  const detail = resolveDetail(detailTarget, indexPieces(priv), { priv });
  useEffect(() => { if (!view) return; return view.on('pieceClick', (e) => { if (!e) return; setBond(null); setDetailTarget(previewEnemyKey(e) ? { kind: 'enemy', id: previewEnemyKey(e) } : e.unitId != null || e.unit ? { kind: 'unit', unit: e.unit || null, unitId: e.unitId, uid: e.uid } : { kind: 'piece', uid: e.uid }); }); }, [view]);
  const changePlayer = (id) => { seekRevision.current++;setWho(id); setDetailTarget(null); setBond(null); };
  const events = record.events.filter((e) => e.playerId === who);
  useEffect(() => {
    if (!playing || !trackReady) { clock.current = null; return; }
    let handle;
    const tick = (now) => {
      const delta = clock.current == null ? 0 : Math.max(0, now - clock.current) * speed;
      if (delta) setTime((at) => { const next = Math.min(record.durationMs, at + delta); if (next === record.durationMs) setPlaying(false); return next; });
      clock.current = now; handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick); return () => { cancelAnimationFrame(handle); clock.current = null; };
  }, [playing, speed, record, trackReady]);
  useEffect(() => {
    if (!view) return;
    if (drawingView.current !== view) { drawingView.current = view; drawing.current = { key: null, index: -1, time: -1 }; }
    const field = activeField;
    if (!trackReady) return;

    if (field?.frames?.length) {
      const { gt, index, frame, next } = fieldFrame(field, time), d = drawing.current;
      const fieldKey = field.chunkKey || field.id;
      const reset = d.key !== fieldKey || time < d.time || Math.abs(time - d.time) > 500;
      if (reset) { view.enterBattle(sceneMeta(field, index)); if (field.restoreEvents?.length) view.pushEvents(field.restoreEvents); view.setCamera(field.kind, { instant: true, rect: field.spec.rect }); d.index = -1; }
      for (let i = d.index + 1; i <= index; i++) view.pushEvents({ fieldId: field.fieldId, gt: field.frames[i].gt, ev: field.frames[i].ev });
      view.pushSnapshot(frame.snap); if (next) view.pushSnapshot(next.snap);
      view.setReplayTime?.(gt, playing && !(field.pauses || []).some((p) => time >= p.from && time < p.to), speed * field.speed); drawing.current = { key: fieldKey, index, time };
    } else {
      const meta = current.state?.field;
      if (meta && (drawing.current.key !== meta || !drawing.current.prep || drawing.current.pen !== pen || drawing.current.collapsed !== collapsed)) { view.enterBattle(meta); view.pushSnapshot(prepSnapshot(meta)); const cam = prepCameraFor(pub, who, collapsed); view.setCamera(pen ? 'pen' : cam.kind, { ...cam.opts, instant: true }); drawing.current = { key: meta, prep: true, pen, collapsed, time }; }
      view.setReplayTime?.(null, false);
    }
  }, [view, current, activeField, trackReady, time, playing, pen, collapsed]);
  const seek = (next) => { seekRevision.current++; setTime(Math.max(0, Math.min(record.durationMs, next))); };
  const diagnostics = useRef(null);
  diagnostics.current = { time, who, trackReady, chunkKey, cache: cache.current.stats(), seek };
  useEffect(() => { const hook = { stats: () => diagnostics.current }; globalThis.__SP_REPLAY__ = hook; return () => { if (globalThis.__SP_REPLAY__ === hook) delete globalThis.__SP_REPLAY__; }; }, []);
  const nextNode = (dir) => { const nodes = record.nodes.filter((n) => dir > 0 ? n.at > time + 1 : n.at < time - 1); seek(dir > 0 ? nodes[0]?.at ?? record.durationMs : nodes.at(-1)?.at ?? 0); };
  useEffect(() => {
    const keys = (e) => { if (e.key === 'Escape' && (detailTarget || bond)) { e.stopImmediatePropagation(); setDetailTarget(null); setBond(null); return; } if (e.target?.matches('input,select,textarea') || info || detailTarget || bond) return; if (shortcutFor(e, settingsStore.get().keys) === 'ready') { e.preventDefault(); setPlaying((on) => !on); } if (e.key === 'ArrowRight') nextNode(1); if (e.key === 'ArrowLeft') nextNode(-1); };
    window.addEventListener('keydown', keys); return () => window.removeEventListener('keydown', keys);
  });
  useCommunicationReplayAudio(record.communications, time, playing, who, seekRevision.current);
  const briefing = pub.phase === PHASE.INFO_CHECK || pub.phase === PHASE.BAND_DRAFT;
  return html`<div class=${`screen gm gm--${phaseMode(pub.phase)} replay-player${briefing ? ' is-replay-briefing' : ''}${controlsOpen ? ' has-replay-controls' : ''}${collapsed ? ' is-collapsed' : ''}${pen ? ' is-pen' : ''}`} data-player=${who} data-camera=${pen ? 'pen' : prep ? 'prep' : current.field?.kind}>
    ${chunkError ? html`<p class="replay-loading" role="alert">${chunkError}</p>` : !trackReady ? html`<p class="replay-loading" role="status">${t('正在读取回放片段…')}</p>` : null}
    <div class="gm__field" ref=${host} onContextMenu=${(e) => e.preventDefault()}></div><div class="gm__vignette" aria-hidden="true"></div>
    <div class="gm__hud">
      <${TopBar} pub=${pub} priv=${priv} hud=${hud} total=${phaseTotalSeconds(pub, gd.config)} drawer=${drawer} onExit=${onBack}
        onDrawer=${(tab) => setDrawer(drawer ? null : tab)} onReady=${() => {}} readyCount=${pub.players.filter((p) => p.ready).length} playerCount=${pub.players.filter((p) => p.alive !== false).length}
        pen=${pen} penAvail=${prep} onPen=${setPen} config=${gd.config} frozenAt=${frozenAt} replay=${true} live=${live}
        pause=${{ show: true, paused: !playing, onToggle: () => setPlaying(!playing) }} />
      <div class="gm__bonds"><${BondStrip} bonds=${priv?.bonds || []} layersDisabled=${isCombatPhase(pub.phase)} openId=${bond} onOpen=${(id) => { setDetailTarget(null); setBond(id); }} /></div>
      <${TeamPanel} pub=${pub} myId=${entry.socialIdentity ? null : entry.playerId} watching=${`n:${who}`} onWatch=${(p) => changePlayer(p.playerId)} />
      <div class="gm__effects"><${EffectsList} effects=${priv?.effects} /></div>
      ${prep && priv ? html`<${ShopBar} priv=${priv} editable=${priv?.alive !== false && !priv.ready} readOnly=${true} collapsed=${collapsed || pen} onCollapse=${setCollapsed} offBonds=${offBonds} onDetail=${openDetail} reward=${priv.shop?.rewardOffer} />` : null}
      ${drawer ? html`<${EnemyDrawer} tab=${drawer} onTab=${setDrawer} pub=${pub} priv=${priv} bandId=${priv?.bandId} onClose=${() => setDrawer(null)} onEnemy=${(id, count) => openDetail(id, 'enemy', count)} onChess=${(id) => openDetail(id, 'chess')} />` : null}
      <${DetailPanel} detail=${detail} editable=${false} onClose=${() => setDetailTarget(null)} bonds=${priv?.bonds} offBonds=${offBonds} loadout=${priv?.loadout} />
      ${bond ? html`<${BondPopup} bondId=${bond} entry=${priv?.bonds?.find((b) => b.bondId === bond)} priv=${priv} banned=${record.restrictions.bannedChess} off=${offBonds.has(bond)} onClose=${() => setBond(null)} onMember=${(id) => openDetail(id, 'chess')} />` : null}
      <${CommunicationDisplay} owners=${[who, ...(current.field?.units || []).map((u) => u.ownerId)].filter(Boolean)} events=${record.communications||[]} time=${time} round=${pub.round} fieldId=${current.field?.fieldId||`n:${who}`} view=${view} />
      <div class="gm__corner"><${FullscreenButton} class="gm__gear gm__fs" /></div>
    </div>
    ${pub.phase === PHASE.INFO_CHECK ? html`<div class="replay-original-screen"><${BriefingScreen} replay=${{ pub, priv, myId: who, frozenAt, onExit: onBack }} /></div>` : pub.phase === PHASE.BAND_DRAFT ? html`<div class="replay-original-screen"><${BandDraftScreen} replay=${{ pub, priv, myId: who, frozenAt, onExit: onBack }} /></div>` : null}
    ${pub.phase === PHASE.SP_DRAFT ? html`<${ChoiceView} pub=${pub} sp=${normalizeSp(pub.sp, pub.players)} myId=${who} solo=${String(pub.modeId).includes('single')} busyIdx=${-1} total=${phaseTotalSeconds(pub, gd.config)} readOnly=${true} frozenAt=${frozenAt} />` : null}
    ${banner ? html`<${PhaseBanner} key=${current.node.seq} mode="overlay" title=${banner.title} sub=${banner.sub} micro=${banner.micro} tone=${banner.tone} duration=${banner.duration || 1500} elapsed=${elapsed} />` : null}
    ${resultBox ? html`<${ResultDialog} key=${current.node.seq} ...${resultBox} elapsed=${elapsed} />` : null}
    <button class=${`replay-handle replay-handle--actions${actionsOpen ? ' is-open' : ''}`} aria-label=${t('玩家操作时间线')} aria-expanded=${actionsOpen} aria-controls="replay-actions" onClick=${() => setActionsOpen(!actionsOpen)}><${Icon} name=${actionsOpen ? 'chevronRight' : 'chevronLeft'} /></button>
    <aside id="replay-actions" class=${`replay-decisions${actionsOpen ? ' is-open' : ''}`} inert=${!actionsOpen} aria-hidden=${!actionsOpen}>
      <h3>${t('玩家操作时间线')}</h3><div class="replay-event-list">${events.length ? events.map((e, i) => html`<${Decision} key=${i} event=${e} selected=${e.at <= time && (!events[i + 1] || events[i + 1].at > time)} onClick=${() => seek(e.at)} />`) : html`<p class="t-dim">${t('该玩家没有记录操作')}</p>`}</div>
      <h3>${t('当前阵容')}</h3><div class="replay-lineup">${(current.state?.private?.board || []).map((u) => html`<${LineupThumb} u=${u} gd=${gd} />`)}</div>
      ${prep ? html`<h3>${t('整备区')}</h3><div class="replay-lineup">${[...(priv?.hand || []), ...(priv?.temp || [])].filter(Boolean).map((u) => u.kind === 'item' ? html`<${UnitThumb} kind="item" id=${u.id} size="sm" />` : html`<${LineupThumb} u=${u} gd=${gd} />`)}</div>` : null}
      <${SelectionSummary} priv=${current.state?.private} gd=${gd} />
    </aside>
    <button class=${`replay-handle replay-handle--controls${controlsOpen ? ' is-open' : ''}`} aria-label=${t('回放进度')} aria-expanded=${controlsOpen} aria-controls="replay-controls" onClick=${() => setControlsOpen(!controlsOpen)}><${Icon} name=${controlsOpen ? 'chevronRight' : 'chevronLeft'} /></button>
    <footer ref=${controlsRef} id="replay-controls" class=${`replay-controls${controlsOpen ? ' is-open' : ''}`} inert=${!controlsOpen} aria-hidden=${!controlsOpen}><div class="replay-toolbar"><${Button} class="replay-toggle" variant="primary" onClick=${() => setPlaying((on) => !on)}>${playing ? t('暂停') : t('继续')}<//>
      <${Button} size="sm" onClick=${() => nextNode(-1)}>${t('上一节点')}<//><${Button} size="sm" onClick=${() => nextNode(1)}>${t('下一节点')}<//>
      <select aria-label=${t('回放速度')} class="replay-select" value=${speed} onChange=${(e) => setSpeed(Number(e.currentTarget.value))}>${[0.5, 1, 2, 4, 8].map((n) => html`<option value=${n}>${n}×</option>`)}</select>
      <b class="num">${fmtTime(time)} / ${fmtTime(record.durationMs)}</b></div>
      <input class="replay-range" aria-label=${t('回放进度')} type="range" min="0" max=${record.durationMs || 1} step="1" value=${time} onInput=${(e) => seek(Number(e.currentTarget.value))} />
      <div class="replay-nodes">${record.nodes.map((n) => html`<button onClick=${() => seek(n.at)} class=${current.node === n ? 'is-active' : ''} title=${fmtTime(n.at)}>R${n.round} ${t(PHASE_NAMES[n.phase] || n.phase)}</button>`)}</div>
    </footer><${RestrictionsDialog} open=${info} onClose=${() => setInfo(false)} restrictions=${record.restrictions} priv=${current.state?.private} />
  </div>`;
}
function HistoryContent() {
  const { selected, mode } = useStore((s) => s, Object.is, historyStore);
  const [record, setRecord] = useState(null), [error, setError] = useState('');
  useEffect(() => {
    setRecord(null); setError(''); if (!selected) return;
    let dead = false, timer, controller;
    let completeTrack = false, loaded = false;
    const load = async () => {
      try {
        controller?.abort(); controller = new AbortController();
        let r = await fetchReplay(selected, undefined, mode !== 'replay' || completeTrack, { tracks:mode === 'replay' && !completeTrack, signal: controller.signal });
        if (dead) return; loaded = true;
        // Settlement/polls need only metadata; fetch a full track once when actually entering playback.
        if (mode === 'replay' && ['ready', 'partial'].includes(r.status) && !completeTrack) completeTrack = true;
        if (!completeTrack || mode !== 'replay' || r.status === 'expired') setRecord(r);
        else setRecord((previous) => previous?.status === r.status ? previous : r);
        if (r.status !== 'expired') timer = setTimeout(load, r.status === 'processing' ? 1500 : 30000);
      } catch (e) { if (!dead) { if (!loaded || e.code === 403 || e.code === 401) { setRecord(null); setError(e.message); } else timer = setTimeout(load, 5000); } }
    };
    void load(); return () => { dead = true; controller?.abort(); clearTimeout(timer); };
  }, [selected, mode]);
  if (!selected) return null;
  if (error) return html`<div class="history-message"><p>${error}</p><${Button} onClick=${() => openHistory()}>${t('返回记录')}<//></div>`;
  if (!record) return html`<div class="history-message"><p>${t('正在读取游玩记录…')}</p><${Button} onClick=${() => openHistory()}>${t('返回记录')}<//></div>`;
  if (mode === 'replay' && ['ready', 'partial'].includes(record.status)) return html`<${ReplayPlayer} record=${record} entry=${selected} onBack=${() => openHistory(selected, 'result')} />`;
  return html`<div class="history-result"><${ResultScreen} archived=${record} archivedPlayerId=${selected.shared || selected.socialIdentity ? 'shared-viewer' : selected.playerId} shared=${selected.shared} onBack=${selected.shared ? closeHistory : () => openHistory()} onReplay=${() => openHistory(selected, 'replay')} />
    <button class="history-close history-close--floating" aria-label=${t('关闭游玩记录')} onClick=${closeHistory}>×</button>
    ${record.status === 'processing' ? html`<div class="replay-generating">${t('正在生成完整战斗回放，请稍候…')}</div>` : null}</div>`;
}
export function HistoryHost() {
  const open = useStore((s) => s.open, Object.is, historyStore);
  useEffect(() => { if (!open) return; const key = (e) => { if (e.key === 'Escape' && !document.querySelector('.history-overlay .modal')) closeHistory(); }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [open]);
  return open ? html`<div class="history-overlay" role="dialog" aria-modal="true" aria-label=${t('游玩记录')}><${HistoryContent} /></div>` : null;
}
