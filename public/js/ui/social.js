import { useEffect, useLayoutEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { createStore, store, useStore, loadPref, savePref } from '../store.js';
import { net } from '../net.js';
import { doctorProfileKey, doctorIdentity } from '../../../shared/doctor.js';
import { presenceRank } from '../../../shared/social.js';
import { DIFFICULTY_NAMES, NAME_MAX_LEN } from '../../../shared/constants.js';
import { html, Button, Modal, TextField, Icon } from './components.js';
import { PlayerAvatar } from './avatarPicker.js';
import { toast } from './toasts.js';
import { useData, getBand } from '../data.js';
import { t } from '../../../shared/i18n.js';
import { openPlayerHistory } from '../replay/history.js';
import { useMatchingPrivacy } from './matchingIdentity.js';
import { showMatchingAdmissionError } from './matchingFeedback.js';
import { useSettings } from './settings.js';
import { matchingAnimate } from './matchingMotion.js';

const empty = () => ({ owner: null, online: false, ready: false, open: false, friends: [], recent: [], avatars: {}, invites: [], search: null, truncated: false, query: '', code: '', error: '', notificationHint: '', notifications: !!loadPref('inviteNotifications', true) });
export function socialSearchQuery(name, code) {
  const callsign = name.normalize('NFC').trim(), digits = code.trim();
  if (!callsign || callsign.includes('#') || !/^\d{4}$/.test(digits)) return null;
  const parsed = doctorIdentity(digits ? `${callsign}#${digits}` : callsign);
  return parsed ? (parsed.code ? `${parsed.name}#${parsed.code}` : parsed.name) : null;
}
export const socialStore = createStore(empty());
const notifications = new Map();
let prompting = false, permissionAttempted = false;
export function requestInvitePermissionOnGesture(event) {
  if (event && !event.isTrusted) return;
  if (!socialStore.get().notifications || permissionAttempted || prompting || notificationAvailability() !== 'default') return;
  permissionAttempted = true; void enableInviteNotifications();
}
let avatarTimer = null, avatarQueue = [], requestedAvatars = new Set();
function closeNotifications() { for (const n of notifications.values()) n.close(); notifications.clear(); }
export function beginSocialProfile(raw) {
  const owner = doctorProfileKey(raw);
  if (socialStore.get().owner === owner) return;
  closeNotifications(); clearTimeout(avatarTimer); avatarQueue = []; requestedAvatars = new Set();
  socialStore.set({ ...empty(), owner });
}
const belongs = (msg) => !!msg.profileKey && msg.profileKey === socialStore.get().owner && msg.profileKey === doctorProfileKey(net.name);
const current = (owner) => owner === socialStore.get().owner && owner === doctorProfileKey(net.name);
export async function socialAction(type, fields = {}) {
  const owner = socialStore.get().owner;
  if (!current(owner) || net.status !== 'online') return false;
  try { await net.request(type, fields); return current(owner); }
  catch (err) { if (current(owner) && !showMatchingAdmissionError(err)) toast(t(err.detail || '好友操作失败，请重试'), 'warn'); return false; }
}
async function syncSocial() {
  const owner = socialStore.get().owner;
  try { await net.request('social.sync'); }
  catch (err) { if (current(owner)) socialStore.set({ error: t(err.detail || '好友列表加载失败，请重试') }); }
}
function pumpAvatars() {
  clearTimeout(avatarTimer);
  const item = avatarQueue.shift(); if (!item) return;
  if (current(item.owner) && net.status === 'online') {
    void net.request('social.avatar', { identity: item.identity }).catch(() => { requestedAvatars.delete(item.key); });
  } else requestedAvatars.delete(item.key);
  avatarTimer = setTimeout(pumpAvatars, 550);
}
export function requestSocialAvatar(row) {
  const s = socialStore.get(), key = `${s.owner}:${row.identity}:${row.avatarRevision}`;
  if (!s.online || requestedAvatars.has(key) || s.avatars[row.identity]?.revision === row.avatarRevision) return;
  requestedAvatars.add(key); avatarQueue.push({ owner: s.owner, identity: row.identity, key });
  if (avatarQueue.length === 1 && !avatarTimer) pumpAvatars();
  else if (avatarQueue.length === 1) { clearTimeout(avatarTimer); avatarTimer = setTimeout(pumpAvatars, 550); }
}
export function notificationAvailability(win = globalThis) {
  if (!win.Notification) return 'unsupported';
  if (!win.isSecureContext) return 'insecure';
  return win.Notification.permission;
}
function notificationReason(state) {
  return state === 'insecure' ? t('系统通知需要 HTTPS 或 localhost；当前保留游戏内邀请提示')
    : state === 'unsupported' ? t('此浏览器不支持系统通知，仍可接收游戏内邀请')
      : t('通知权限未获允许，请在浏览器网站设置中启用');
}
export async function enableInviteNotifications() {
  const state = notificationAvailability();
  if (state === 'insecure' || state === 'unsupported' || state === 'denied') { socialStore.set({ notificationHint: notificationReason(state) }); return; }
  let permission;
  try { prompting = true; permission = state === 'granted' ? state : await Notification.requestPermission(); }
  catch { socialStore.set({ notificationHint: t('系统通知无法显示，仍可使用游戏内邀请') }); return; }
  finally { prompting = false; }
  const enabled = permission === 'granted';
  // A permission dismissal is not the user's explicit notification preference.
  if (enabled) savePref('inviteNotifications', true);
  socialStore.set({ notifications: enabled, notificationHint: enabled ? t('邀请系统通知已启用；操作系统需允许 Chrome 通知') : notificationReason(permission) });
}
export function inviteNotificationText(invite) {
  return t('{name}邀请你加入【{difficulty}】【{destination}】',{name:doctorIdentity(invite.from)?.name || invite.from,difficulty:t(DIFFICULTY_NAMES[invite.difficulty] || invite.difficulty),destination:invite.kind==='matching' ? t('匹配队列') : t('房间')});
}
export function notifyInvite(invite, win = globalThis) {
  const s = socialStore.get();
  if (!s.notifications || notificationAvailability(win) !== 'granted' || notifications.has(invite.inviteId)) return;
  const claim = `sp.invite-notified:${s.owner}:${invite.inviteId}`;
  // Same-origin Chrome tabs share one short-lived claim; other devices may notify independently.
  try {
    const at = Number(win.localStorage?.getItem(claim));
    if (at > Date.now() - 120000) return;
    win.localStorage?.setItem(claim, String(Date.now()));
    const timer = setTimeout(() => { try { win.localStorage?.removeItem(claim); } catch { /* blocked storage */ } }, 120000);
    timer.unref?.();
  } catch { /* Notification tag still coalesces identical invitations. */ }
  try {
    const owner = s.owner;
    const n = new win.Notification(inviteNotificationText(invite), { tag: `sp-invite-${invite.inviteId}` });
    notifications.set(invite.inviteId, n);
    n.onerror = () => { if (current(owner)) socialStore.set({ notificationHint: t('系统通知无法显示，仍可使用游戏内邀请') }); };
    n.onclick = () => {
      if (current(owner) && socialStore.get().invites.some((i) => i.inviteId === invite.inviteId && i.deadline > Date.now())) { win.focus?.(); socialStore.set({ open: true }); }
      n.close();
    };
  } catch { socialStore.set({ notificationHint: t('系统通知无法显示，仍可使用游戏内邀请') }); }
}
export function installSocial() {
  globalThis.addEventListener?.('storage', (event) => {
    if (event.key !== 'sp.pref.inviteNotifications') return;
    let enabled = false; try { enabled = JSON.parse(event.newValue) === true; } catch { /* cleared or invalid device preference */ }
    socialStore.set({ notifications: enabled }); if (!enabled) closeNotifications();
  });
  net.on('profileChanging', ({ name }) => beginSocialProfile(name));
  net.on('welcome', (msg) => {
    beginSocialProfile(`${msg.name}#${msg.doctorCode || ''}`); socialStore.set({ online: true }); void syncSocial();
  });
  net.on('status', ({ status }) => {
    const online = status === 'online'; socialStore.set({ online });
    if (!online) { closeNotifications(); socialStore.set({ invites: [], search: null }); }
  });
  net.on('social.state', (msg) => { if (!belongs(msg)) return;
    // Reject malformed/incomplete snapshots as a whole; never replace lists with undefined.
    if (!Array.isArray(msg.friends) || !Array.isArray(msg.recent) || [...msg.friends, ...msg.recent].some((r) => !r || typeof r.identity !== 'string')) return;
    socialStore.set({ friends: msg.friends, recent: msg.recent, ready: true, error: '' }); });
  net.on('social.presence', (msg) => {
    if (!belongs(msg) || !Array.isArray(msg.entries) || msg.entries.some((row)=>!row || typeof row.identity !== 'string')) return;
    const changed = new Map(msg.entries.map((row) => [row.identity, row])), s = socialStore.get();
    socialStore.set({ friends: s.friends.map((r) => changed.get(r.identity) || r).sort((a, b) => presenceRank(a.status) - presenceRank(b.status) || a.identity.localeCompare(b.identity)), recent: s.recent.map((r) => changed.get(r.identity) || r) });
  });
  net.on('social.search', (msg) => {
    const s = socialStore.get();
    if (belongs(msg) && msg.query === socialSearchQuery(s.query, s.code)) socialStore.set({ search: msg.entries || (msg.entry ? [msg.entry] : []), truncated: !!msg.truncated });
  });
  net.on('social.avatar', (msg) => {
    if (!belongs(msg)) return;
    const s = socialStore.get(), row = [...s.friends, ...s.recent].find((r) => r.identity === msg.identity);
    if (row?.avatarRevision === msg.avatarRevision) socialStore.set({ avatars: { ...s.avatars, [msg.identity]: { revision: msg.avatarRevision, avatar: msg.avatar } } });
  });
  net.on('social.invite', (msg) => {
    if (!belongs(msg)) return;
    const s = socialStore.get(), invite = { ...msg, deadline: Date.now() + Math.max(0, msg.expiresAt - msg.serverNow) };
    if (s.invites.some((i) => i.inviteId === invite.inviteId)) return;
    socialStore.set({ invites: [...s.invites, invite] }); notifyInvite(invite);
  });
  net.on('social.inviteEnded', (msg) => {
    if (!belongs(msg)) return;
    notifications.get(msg.inviteId)?.close(); notifications.delete(msg.inviteId);
    socialStore.set({ invites: socialStore.get().invites.filter((i) => i.inviteId !== msg.inviteId) });
  });
}
function statusText(row, online) {
  if (!online) return t('状态暂不可用');
  const status = { offline: t('离线'), online: t('在线'), room: t('房间中'), playing: t('正在游玩'), spectating: t('观战中') }[row.status] || t('在线');
  if (!['playing', 'spectating'].includes(row.status)) return status;
  const band = row.bandId ? getBand(row.bandId)?.name || row.bandId : t('未选择');
  return `${status} · ${t(DIFFICULTY_NAMES[row.difficulty] || '')} · ${band} · ${t('第 {round} 回合', { round: row.round || 0 })}${row.lp == null ? '' : ` · ${t('剩余生命 {lp}', { lp: row.lp })}`}`;
}
function FriendIdentity({ row, onClick = null, disabled = false }) {
  const hidden = useMatchingPrivacy() || row.hideCode;
  const identity = doctorIdentity(row.identity);
  const content = html`<strong title=${hidden ? identity?.name || row.name : row.identity}>${identity?.name || row.name}${hidden ? null : html`<span class="friend-identity__code">#${identity?.code || row.code}</span>`}</strong>`;
  return onClick ? html`<button class="friend-profile-link" disabled=${disabled} title=${row.canViewProfile ? t('查看对局记录') : t('对方未向你开放个人资料')} onClick=${onClick}>${content}</button>` : content;
}
function FriendRow({ row, friend, canInvite, canMatchInvite, online, avatar }) {
  const hidden = useMatchingPrivacy() || row.hideCode;
  const ref = useRef(null);
  useEffect(() => {
    if (!online) return;
    if (!globalThis.IntersectionObserver) { requestSocialAvatar(row); return; }
    const observer = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) requestSocialAvatar(row); });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [row.identity, row.avatarRevision, online]);
  const action = (type) => { void socialAction(type, { identity: row.identity }); };
  const openProfile = () => { socialStore.set({ open: false }); void openPlayerHistory(row.identity); };
  return html`<article ref=${ref} class=${`friend-row friend-row--${row.status}`} data-identity=${row.identity}>
    <button class="friend-profile-avatar" disabled=${!online || !row.canViewProfile} aria-label=${t('查看 {name} 的对局记录', { name: hidden ? row.name : row.identity })} title=${row.canViewProfile ? t('查看对局记录') : t('对方未向你开放个人资料')} onClick=${openProfile}><${PlayerAvatar} avatar=${avatar} name=${row.name} size="sm" offline=${row.status === 'offline'} /></button>
    <div class="friend-row__body"><${FriendIdentity} row=${row} onClick=${openProfile} disabled=${!online || !row.canViewProfile} /><p class="friend-row__status">${statusText(row, online)}</p>
      <div class="friend-row__actions">
        ${!friend ? html`<${Button} size="sm" disabled=${!online} onClick=${() => action('social.add')}>${t('添加好友')}<//>` : null}
        ${friend && row.canJoin ? html`<${Button} size="sm" disabled=${!online} onClick=${() => action('social.join')}>${t('加入房间')}<//>` : null}
        ${friend && row.canSpectate ? html`<${Button} size="sm" disabled=${!online} onClick=${() => action('social.spectate')}>${t('观战')}<//>` : null}
        ${canMatchInvite ? html`<${Button} size="sm" disabled=${!online || row.status === 'offline'} onClick=${() => { const p = store.get().matching.party; void socialAction('matching.invite', { identity: row.identity, difficulty: p?.difficulty || loadPref('lobby.difficulty','FUNNY') }); }}>${t('邀请加入匹配队伍')}<//>` : null}
        ${canInvite ? html`<${Button} size="sm" disabled=${!online || row.status === 'offline'} onClick=${() => action('social.invite')}>${t('邀请')}<//>` : null}
        ${friend ? html`<button class="friend-row__remove" disabled=${!online} onClick=${() => action('social.remove')} aria-label=${t('移除好友')}>${t('移除')}<//>` : null}
      </div>
    </div>
  </article>`;
}
export function FriendsDrawer({ visible }) {
  const s = useStore((value) => value, Object.is, socialStore);
  const drawer=useRef(null), motion=useRef([]), phase=useRef(null), [showRows,setShowRows]=useState(s.open);
  const {matchingMotion}=useSettings();
  useLayoutEffect(()=>{
    const root=drawer.current;
    if(!root){motion.current.forEach(a=>a?.cancel());motion.current=[];phase.current=null;return;}
    const panel=root.querySelector('.friends-panel'), handle=root.querySelector('.friends-handle');
    const active=a=>a && ['running','paused'].includes(a.playState), wasOpen=!!phase.current?.open;
    const width=root.getBoundingClientRect().width;
    const from=active(motion.current[0]) ? getComputedStyle(panel).transform : `translateX(${wasOpen ? '0' : '100%'})`;
    const opacity=active(motion.current[0]) ? getComputedStyle(panel).opacity : wasOpen ? 1 : 0;
    const handleFrom=active(motion.current[1]) ? getComputedStyle(handle).transform : `translateX(${wasOpen ? -width : 0}px)`;
    motion.current.forEach(a=>a?.cancel());motion.current=[];
    const target=getComputedStyle(panel).transform, handleTarget=getComputedStyle(handle).transform;
    phase.current={open:s.open};
    if(s.open) setShowRows(true);
    if(matchingMotion==='reduced' || !panel.animate || (!s.open && !wasOpen)){panel.style.visibility='';if(!s.open)setShowRows(false);return;}
    panel.style.visibility='visible';
    const a=matchingAnimate(panel,[{transform:from,opacity},{transform:target,opacity:s.open ? 1 : 0}],s.open ? 280 : 180,s.open ? 'friends-open' : 'friends-close');
    const b=matchingAnimate(handle,[{transform:handleFrom},{transform:handleTarget}],s.open ? 280 : 180,'friends-handle');
    motion.current=[a,b];
    a?.finished.then(()=>{if(motion.current[0]!==a)return;panel.style.visibility='';if(!s.open)setShowRows(false);},()=>{});
  },[s.open,visible,matchingMotion]);
  useEffect(()=>()=>motion.current.forEach(a=>a?.cancel()),[]);
  const room = useStore((value) => value.room), me = useStore((value) => value.me.playerId);
  const party = useStore((value) => value.matching.party);
  const canMatchInvite = !room && (!party || (party.phase === 'idle' && party.leaderId === me));
  const canInvite = room?.mode === 'coop' && !room.inMatch && (!room.matching || room.matching.phase === 'idle') && room.seats?.some((seat) => seat?.playerId === me);
  useData('bands');
  if (!visible) return null;
  const search = (event) => {
    event.preventDefault();
    if (!s.query.trim()) { socialStore.set({ search: null, error: t('请输入代号，不能只输入代码') }); return; }
    const identity = socialSearchQuery(s.query, s.code);
    if (!identity) { socialStore.set({ search: null, error: t('请输入完整代号及四位数字代码') }); return; }
    socialStore.set({ search: null, error: '', truncated: false }); void socialAction('social.search', { identity });
  };
  return html`<div ref=${drawer} class=${`friends-drawer ${s.open ? 'is-open' : ''}`}>
    <button class="friends-handle" aria-label=${s.open ? t('收起好友列表') : t('展开好友列表')} aria-expanded=${s.open} onClick=${() => socialStore.set({ open: !s.open })}><${Icon} name="users" /><span>${t('好友')}</span>${s.invites.length ? html`<b>${s.invites.length}</b>` : null}</button>
    <aside class="friends-panel" aria-label=${t('好友列表')} aria-hidden=${!s.open} inert=${!s.open}>
      <header><span class="micro">SOCIAL / ALLIANCE</span><h2>${t('好友列表')}</h2><button aria-label=${t('收起好友列表')} onClick=${() => socialStore.set({ open: false })}><${Icon} name="close" /></button></header>
      <form class="friends-search" onSubmit=${search}><${TextField} class="friends-search__name" value=${s.query} maxLength=${NAME_MAX_LEN} placeholder=${t('代号')} ariaLabel=${t('搜索代号')} onInput=${(value) => socialStore.set({ query: value, search: null, error: '' })} /><span class="friends-search__separator" aria-hidden="true">#</span><${TextField} class="friends-search__code" value=${s.code} maxLength=${4} placeholder="0001" inputMode="numeric" ariaLabel=${t('搜索代码（可留空）')} transform=${(value) => value.replace(/\D/g, '').slice(0, 4)} onInput=${(value) => socialStore.set({ code: value, search: null, error: '' })} /><${Button} type="submit" size="sm" disabled=${!s.online}>${t('搜索')}<//></form>
      ${s.error ? html`<p class="friends-note" role="alert">${s.error}<button onClick=${() => { void syncSocial(); }}>${t('重试')}</button></p>` : null}
      <div class="friends-scroll">
        ${s.search?.length === 0 ? html`<p class="friends-note">${t('未找到匹配的玩家')}</p>` : s.search?.map((row) => html`<div key=${row.identity} class="friends-search-result"><${FriendIdentity} row=${row} /><${Button} size="sm" disabled=${!s.online} onClick=${async () => { const owner = s.owner; if (await socialAction('social.add', { identity: row.identity }) && current(owner)) socialStore.set({ search: null }); }}>${t('添加好友')}<//></div>`)}
        ${s.search && s.truncated ? html`<p class="friends-note">${t('仅显示前 20 项，请补全代号或代码缩小范围')}</p>` : null}
        ${s.ready ? ['friends', 'recent'].map((key) => html`<details open key=${key} class="friends-section"><summary>${key === 'friends' ? t('好友') : t('一同游玩过的玩家')}<span>${s[key].length}</span></summary>
        ${showRows ? s[key].map((row) => html`<${FriendRow} key=${row.identity} row=${row} friend=${key === 'friends'} canInvite=${canInvite} canMatchInvite=${canMatchInvite} online=${s.online} avatar=${s.avatars[row.identity]?.avatar} />`) : null}
        ${!s[key].length ? html`<p class="friends-note">${key === 'friends' ? t('暂无好友，搜索代号即可添加') : t('最近五场对局暂无其他玩家')}</p>` : null}
      </details>`) : html`<p class="friends-note">${s.online ? t('正在加载好友列表…') : t('状态暂不可用')}</p>`}</div>
      <footer><${Button} size="sm" onClick=${() => { void enableInviteNotifications(); }}>${s.notifications && notificationAvailability() === 'granted' ? t('邀请通知已启用') : t('启用邀请通知')}<//>${s.notifications ? html`<button onClick=${() => { savePref('inviteNotifications', false); socialStore.set({ notifications: false }); closeNotifications(); }}>${t('关闭通知')}</button>` : null}<p>${s.notificationHint || (notificationAvailability() === 'insecure' ? notificationReason('insecure') : t('网页保持打开时可接收邀请'))}</p></footer>
    </aside>
  </div>`;
}
export function SocialInviteHost() {
  const s = useStore((value) => value, Object.is, socialStore), room = useStore((value) => value.room);
  const [now, setNow] = useState(Date.now()), [busy, setBusy] = useState(false);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const invite = s.invites.find((item) => item.deadline > now);
  useEffect(() => { setBusy(false); }, [s.owner, invite?.inviteId]);
  if (!invite) return null;
  const respond = async (accept) => { setBusy(true); await socialAction(invite.kind === 'matching' ? 'matching.inviteRespond' : 'social.inviteRespond', { inviteId: invite.inviteId, accept }); setBusy(false); };
  return html`<div class="social-invite-layer"><${Modal} open=${true} title=${invite.kind === 'matching' ? t('匹配队伍邀请') : t('同盟邀请')} micro="ALLIANCE INVITATION" width="min(480px,94vw)" onClose=${() => { void respond(false); }} actions=${html`<${Button} disabled=${busy} onClick=${() => { void respond(false); }}>${t('拒绝')}<//><${Button} variant="primary" disabled=${busy || !s.online || !!room?.inMatch || (invite.kind === 'matching' && !!room)} onClick=${() => { void respond(true); }}>${room && invite.kind !== 'matching' ? t('接受并离开当前同盟') : t('接受邀请')}<//>`}>
    <p class="modal__text">${inviteNotificationText(invite)}</p>
    ${room?.inMatch ? html`<p class="modal__text">${t('请先退出当前对局；不会自动转移正在进行的游戏')}</p>` : null}
    <p class="modal__text">${t('邀请将在 {seconds} 秒后过期', { seconds: Math.max(0, Math.ceil((invite.deadline - now) / 1000)) })}</p>
  <//></div>`;
}
