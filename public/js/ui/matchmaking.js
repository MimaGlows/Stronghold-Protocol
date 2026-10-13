import { useEffect, useLayoutEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, Modal, useTicker } from './components.js';
import { net } from '../net.js';
import { BondGlyph, GIcon } from './gameComponents.js';
import { PlayerAvatar } from './avatarPicker.js';
import { store, useStore } from '../store.js';
import { data, useData } from '../data.js';
import { t } from '../../../shared/i18n.js';
import { CORE_PREFERENCES, validPreference } from '../../../shared/matchmaking.js';
import { toastError } from './toasts.js';
import { useSettings } from './settings.js';
import { createQueueMotion, matchingAnimate } from './matchingMotion.js';
import { showMatchingAdmissionError } from './matchingFeedback.js';

function MatchingModal({ open, ...props }) {
  const { matchingMotion }=useSettings(), [present,setPresent]=useState(open), host=useRef(null);
  useLayoutEffect(() => {
    if (open && !present) { setPresent(true); return undefined; }
    if (!present) return undefined;
    const box=host.current?.querySelector('.modal__box');
    if (matchingMotion === 'reduced' || !box?.animate) { if (!open) setPresent(false); return undefined; }
    const a=matchingAnimate(box,open ? [{opacity:0,transform:'translateY(18px)'},{opacity:1,transform:'translateY(0)'}] : [{opacity:getComputedStyle(box).opacity,transform:getComputedStyle(box).transform},{opacity:0,transform:'translateY(8px)'}],open ? 220 : 160,open ? 'matching-modal-enter' : 'matching-modal-exit');
    let active=true;
    if (!open) a.finished.then(()=>{if(active)setPresent(false);},()=>{});
    return () => { active=false; a.cancel(); };
  },[open,present,matchingMotion]);
  return html`<div ref=${host} class="matching-modal-host" inert=${!open ? true : undefined}><${Modal} ...${props} open=${present} interactive=${open} /></div>`;
}

async function request(type, fields = {}) { try { await net.request(type, fields); } catch (error) { if (!showMatchingAdmissionError(error)) toastError(error); } }
export function MatchingAccount({ iconOnly = false }) {
  const matching = useStore((s) => s.matching);
  const [open, setOpen] = useState(false);
  useTicker(1000); const now = Date.now();
  const minutes = Math.max(0, Math.ceil((matching.bannedUntil - now - matching.offset) / 60_000));
  return html`<div class=${'matching-account '+(iconOnly ? 'matching-blacklist-entry' : '')}>
    ${!iconOnly && minutes > 0 ? html`<span role="status">${t('匹配禁用剩余 {minutes} 分钟', { minutes })}</span>` : null}
    <${Button} class=${iconOnly ? 'matching-blacklist' : ''} size=${iconOnly ? 'xl' : 'sm'} square=${iconOnly} aria-label=${t('黑名单管理')} title=${t('黑名单管理')} onClick=${() => setOpen(true)}>
      ${iconOnly ? html`<${GIcon} name="shield" class="btn__icon" />` : html`${t('匹配黑名单')} (${matching.blocks.length}/20)`}<//>
    <${MatchingModal} open=${open} title=${t('黑名单管理')} micro="PERSONNEL EXCLUSION" class="matching-blacklist-modal" onClose=${() => setOpen(false)} actions=${html`<${Button} onClick=${() => setOpen(false)}>${t('关闭')}<//>`}>
      <p>${t('任一方拉黑后，双方无法进入同一匹配对局。')}</p>
      ${matching.blocks.length ? matching.blocks.map((id) => html`<div class="matching-block" key=${id}><span>${matching.restricted ? id.split('#')[0] : id}</span><${Button} size="sm" onClick=${() => request('matching.unblock', { identity: id })}>${t('解除拉黑')}<//></div>`) : html`<p>${t('暂无匹配黑名单')}</p>`}
    <//>
  </div>`;
}
export function MatchingStartButton({ difficulty, online, compact = false, onChoose }) {
  const matching = useStore((s) => s.matching), myId = useStore((s) => s.me.playerId), party = matching.party;
  const [open,setOpen]=useState(false), mine=party?.members.find(m=>m.playerId===myId), locked=party && party.phase!=='idle';
  return html`<${Button} variant="primary" size=${compact ? 'lg' : 'xl'} block=${true} iconRight="chevrons" class=${compact ? 'matching-prepare' : 'matching-start'} disabled=${!online || !!locked || !!mine?.ready || matching.bannedUntil > Date.now()+matching.offset} onClick=${onChoose || (()=>setOpen(true))}>
    ${compact ? t('选择同盟并完成准备') : locked ? t('正在匹配') : mine?.ready ? t('等待队员准备') : t('开始匹配')}<//>
    ${!onChoose ? html`<${AlliancePicker} open=${open} onClose=${()=>setOpen(false)} difficulty=${difficulty} online=${online} />` : null}`;
}
export function AlliancePicker({ open, onClose, difficulty, online, room = null, enableBackfill = false }) {
  useEffect(() => {
    if (!open) return undefined;
    document.body.classList.add('sp-alliance-picker');
    return () => document.body.classList.remove('sp-alliance-picker');
  }, [open]);
  useData('bonds'); useData('config'); useData('assets');
  const matching = useStore((s) => s.matching), party = matching.party;
  const [choice, setChoice] = useState(undefined), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const locked = room ? room.inMatch : party && party.phase !== 'idle';
  const selectedDifficulty = room?.difficulty || party?.difficulty || difficulty;
  useEffect(() => { if (locked) onClose(); }, [locked]);
  useLayoutEffect(() => { if (open) { setChoice(undefined); setRevision(room?.matching?.revision || 0); } }, [open]);
  useEffect(() => { if (!validPreference({ config: data.getRaw('config') }, selectedDifficulty, choice)) setChoice(undefined); }, [selectedDifficulty]);
  const confirm = async () => {
    if (busy || choice === undefined) return;
    setBusy(true);
    try {
      const current = store.get().matching.party;
      if (room) await net.request(enableBackfill ? 'matching.setEnabled' : 'matching.roomPrepare', { ...(enableBackfill ? { on: true } : {}), revision, bond: choice });
      else await net.request('matching.prepare', { partyId: current?.id || null, revision: current?.revision || 0, difficulty: current?.difficulty || selectedDifficulty, bond: choice });
      onClose();
    } catch (error) { if (room && error.code === 'MATCH_STALE') setRevision(store.get().room?.matching?.revision || 0); if (!showMatchingAdmissionError(error)) toastError(error); } finally { setBusy(false); }
  };
  return html`<${MatchingModal} open=${open} title=${t('选择你的盟约')} micro="ALLIANCE DECLARATION" class="alliance-picker" width="min(11.8rem, calc(100vw - .5rem))" closeOnBackdrop=${!busy} onClose=${() => { if (!busy) onClose(); }} actions=${html`
      <${Button} variant="ghost" size="lg" disabled=${busy} onClick=${onClose}>${t('取消')}<//>
      <${Button} class="alliance-confirm" variant="primary" size="lg" iconRight="chevrons" loading=${busy} disabled=${choice === undefined || !online || busy} onClick=${confirm}>${room ? t('选择盟约并完成准备') : party ? t('选择同盟并完成准备') : t('选择并开始匹配')}<//>`}>
      <div class="alliance-picker__intro"><span class="alliance-picker__number num">01</span><p>${t('选择一个盟约，确认后完成准备。')}</p></div>
      <div class="alliance-options" role="group" aria-label=${t('预选择盟约')}>
        ${[null,...CORE_PREFERENCES].map((bond,i) => {
          const available = validPreference({ config: data.getRaw('config') }, selectedDifficulty, bond), selected = choice === bond;
          return html`<button type="button" key=${bond || 'any'} data-bond=${bond || 'any'} class=${'alliance-option '+(selected ? 'is-selected' : '')} aria-pressed=${selected} disabled=${!available || busy} onClick=${() => setChoice(bond)}>
            <span class="alliance-option__serial num">${String(i).padStart(2,'0')}</span>
            <span class="alliance-option__glyph">${bond ? html`<${BondGlyph} bondId=${bond} />` : html`<${GIcon} name="refresh" />`}</span>
            <strong>${bond ? data.get('bonds')?.[bond]?.name || bond : t('不限')}</strong>
            <span class="alliance-option__state">${!available ? t('当前难度不可用') : selected ? t('已选定') : null}</span>
            <span class="alliance-option__check" aria-hidden="true">${selected ? '✓' : '+'}</span>
          </button>`;
        })}
      </div>
      <p class="alliance-picker__note">${room ? t('房主预选盟约优先，其他预选其次；所有预选仍可能被禁用。') : t('偏好盟约至少60%概率可用，不保证策略卡或干员。')}</p>
    <//>`;
}
export function MatchingCooldown() {
  const state = useStore((s) => s.matching); useTicker(1000);
  const minutes = Math.max(0, Math.ceil((state.bannedUntil-Date.now()-state.offset)/60000));
  return minutes ? html`<p class="matching-cooldown" role="status">${t('匹配禁用剩余 {minutes} 分钟', { minutes })}</p>` : null;
}
export function MatchingQueue({ online }) {
  const matching = useStore((s) => s.matching), myId = useStore((s) => s.me.playerId), p = matching.party;
  const [busy, setBusy] = useState(false), [picker,setPicker]=useState(false), root=useRef(null), motion=useRef(null);
  const { matchingMotion }=useSettings(); useTicker(1000); useData('bonds');
  const roster=JSON.stringify([p?.members.map(m=>[m.playerId,m.ready,m.preference]),p?.invites.map(i=>i.id)]);
  useLayoutEffect(()=>{
    if (!root.current) { motion.current?.destroy(); motion.current=null; return; }
    if (!motion.current) motion.current=createQueueMotion(root.current);
    motion.current.update({attempt:p?.attemptId || null,mode:matchingMotion,extended:p?.phase==='extended',members:p?.members.length || 0,invites:p?.invites.length || 0});
  },[p?.id,p?.attemptId,p?.phase,roster,matchingMotion]);
  useEffect(()=>()=>motion.current?.destroy(),[]);
  if (!p || !['idle','searching','extended'].includes(p.phase)) return null;
  const searching = !!p.attemptId, mine = p.members.find((m) => m.playerId === myId);
  const seconds = searching ? Math.max(0, Math.floor((Date.now()+matching.offset-p.startedAt)/1000)) : 0;
  const send = async (type, fields = {}) => { if (busy) return; setBusy(true); await request(type, { partyId: p.id, revision: p.revision, ...fields }); setBusy(false); };
  const slots = [...p.members, ...p.invites.map((i) => ({ ...i, pending: true, name: i.identity.split('#')[0] }))];
  while (slots.length < 4) slots.push(null);
  return html`<section ref=${root} class="matching-queue" data-party=${p.id} data-attempt=${p.attemptId || ''} aria-label=${t('匹配队列')}>
    <div class="matching-queue__art" aria-hidden="true"><div class="matching-refresh"><${GIcon} name="refresh" /></div></div>
    <div class="matching-queue__status" role="status">
      <div><span class="matching-queue__micro">${searching ? 'SEARCHING' : 'SQUAD STANDBY'}</span><h3>${searching ? t('正在匹配') : t('好友匹配队伍')}</h3>
        ${searching ? html`<b class="matching-queue__time num">${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}</b>` : html`<span class="matching-ready-count"><span><b class="num">${p.members.filter(m=>m.ready).length}</b> / ${p.members.length}</span><span>${t('等待队员准备')}</span></span>`}
      </div></div>
    <div class="matching-queue__members">${slots.map((m,i) => html`<div key=${m?.playerId || m?.id || i} data-member=${m?.playerId || m?.id || `empty-${i}`} class=${'matching-member '+(m?.pending ? 'is-pending' : '')} title=${m ? `${m.name} · ${m.pending ? t('等待接受邀请') : data.get('bonds')?.[m.preference]?.name || t('不限')}` : t('空闲席位')} aria-label=${m ? `${m.name} · ${m.ready ? t('已就绪') : t('未就绪')}` : t('空闲席位')}>
      <span class="matching-member__seat num">${String(i+1).padStart(2,'0')}</span><${PlayerAvatar} avatar=${m?.avatar} name=${m?.name || '?'} size="md" />
      <span class="matching-member__bond" aria-hidden="true">${m && !m.pending ? m.preference ? html`<${BondGlyph} bondId=${m.preference} />` : html`<${GIcon} name="refresh" />` : null}</span>
      <div class="matching-member__info" aria-hidden=${searching ? 'true' : undefined}><b>${m?.name || t('空闲席位')}</b><span>${m?.pending ? t('等待接受邀请') : m ? html`${m.preference ? html`<${BondGlyph} bondId=${m.preference} />` : null}${data.get('bonds')?.[m.preference]?.name || t('不限')}` : null}</span><small>${m && !m.pending ? m.ready ? t('已就绪') : t('未就绪') : null}</small></div>
      ${m ? html`<span class=${'matching-member__ready '+(m.ready ? 'is-ready' : '')} aria-label=${m.pending ? t('等待接受邀请') : !m.connected ? t('离线') : m.ready ? t('已就绪') : t('未就绪')}>${m.pending ? '…' : !m.connected ? '!' : m.ready ? '✓' : '—'}</span>` : null}
    </div>`)}</div>
    <div class="matching-queue__actions">
      ${searching || mine?.ready ? html`<${Button} class="matching-unready" disabled=${busy || !online} onClick=${() => send('matching.ready', { ready: false, ...(searching ? { attemptId: p.attemptId } : {}) })}>${t('取消准备')}<//>` : html`<${MatchingStartButton} difficulty=${p.difficulty} online=${online} compact=${true} onChoose=${()=>setPicker(true)} />`}
      ${!searching ? html`<${Button} variant="ghost" size="sm" disabled=${busy || !online} onClick=${() => send('matching.leave')}>${t('离开队伍')}<//>` : null}
    </div>
    ${p.phase === 'extended' ? html`<p class="matching-queue__extended">${t('匹配超过一分钟，系统正在尝试将队伍加入开启匹配补位的同盟。')}</p>` : null}
  </section><${AlliancePicker} open=${picker} onClose=${()=>setPicker(false)} difficulty=${p.difficulty} online=${online} />`;
}
export function MatchingBackfillToggle({ room, myId, online }) {
  const [busy, setBusy] = useState(false), [open, setOpen] = useState(false);
  if (room.mode !== 'coop' || room.matching?.generated || !room.seats.some((s) => s?.playerId === myId)) return null;
  const host = room.hostId === myId;
  return html`<label class="matching-toggle"><input type="checkbox" checked=${!!room.matching?.enabled} disabled=${!host || room.inMatch || busy || !online}
      onChange=${async (e) => { if (e.currentTarget.checked) { setOpen(true); return; } setBusy(true); await request('matching.setEnabled', { on: false, revision: room.matching.revision }); setBusy(false); }} />${t('是否同意匹配玩家补位')}</label>
    <${AlliancePicker} open=${open && host} onClose=${() => setOpen(false)} room=${room} enableBackfill=${true} difficulty=${room.difficulty} online=${online} />`;
}
export function RoomAllianceButton({ room, online, ready }) {
  const [open, setOpen] = useState(false);
  return html`<${Button} variant="secondary" size="lg" disabled=${!online || room.inMatch} onClick=${() => setOpen(true)}>${ready ? t('重新选择盟约') : t('选择盟约并完成准备')}<//>
    <${AlliancePicker} open=${open} onClose=${() => setOpen(false)} room=${room} difficulty=${room.difficulty} online=${online} />`;
}
export function MatchingResult({ result, myId }) {
  const state = useStore((s) => s.matching);
  const [busy, setBusy] = useState(false);
  const self = result?.matching?.participants?.find((p) => p.playerId === myId);
  if (!self || self.identity !== state.identity) return null;
  const block = async (identity) => { if (busy) return; setBusy(true); await request('matching.block', { matchId: result.matching.id, identity }); setBusy(false); };
  return html`<section class="matching-result" aria-label=${t('匹配队友')}><h3>${t('匹配队友')}</h3>
    ${result.matching.participants.filter((p) => p.playerId !== myId).map((p) => html`<div class="matching-block" key=${p.identity}><span>${p.identity.split('#')[0]}</span>
      <${Button} size="sm" disabled=${busy || state.blocks.includes(p.identity)} onClick=${() => block(p.identity)}>${state.blocks.includes(p.identity) ? t('已拉黑') : t('拉黑匹配队友')}<//></div>`)}
    <${MatchingAccount} />
  </section>`;
}
