// Server profiles own avatars. Host-only cookies cache only the explicitly tagged profile.
import { createStore, store } from '../store.js';
import { identity, net as profileNet } from '../net.js';
import { doctorIdentity, doctorProfileKey } from '../../../shared/doctor.js';
import { DEFAULT_AVATAR, isAvatarChoice, sameAvatar } from '../../../shared/avatar.js';
import { toast } from './toasts.js';
import { t, N_ } from '../../../shared/i18n.js';

export const AVATAR_PREF = 'sp.avatar';
const CHUNK_SIZE = 3000, MAX_CHUNKS = 12, MAX_AGE = 365 * 24 * 60 * 60;
const OWNER_COOKIE = 'sp.avatar.owner';
const DATA_PREFIX = 'data:image/webp;base64,';

function cookieMap(doc) {
  return new Map((doc?.cookie || '').split(/;\s*/).map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? [part, ''] : [part.slice(0, index), part.slice(index + 1)];
  }));
}
function parts(meta) {
  if (typeof meta !== 'string' || !/^[a-z0-9_-]{1,48}\.(?:[1-9]|1[0-2])$/.test(meta)) return [];
  const [id, count] = meta.split('.');
  return Array.from({ length: Number(count) }, (_, i) => `${AVATAR_PREF}.${id}.${i}`);
}
function writeCookie(doc, key, value, age = MAX_AGE) {
  doc.cookie = `${key}=${value}; Path=/; Max-Age=${age}; SameSite=Lax${globalThis.location?.protocol === 'https:' ? '; Secure' : ''}`;
}

export function loadAvatar(cookieDocument = globalThis.document) {
  try {
    const cookies = cookieMap(cookieDocument), keys = parts(cookies.get(AVATAR_PREF));
    if (!keys.length || keys.some((key) => !cookies.get(key) || cookies.get(key).length > CHUNK_SIZE)) return DEFAULT_AVATAR;
    const raw = keys.map((key) => cookies.get(key)).join('');
    let avatar;
    if (raw === 'd') avatar = DEFAULT_AVATAR;
    else if (/^o\.char_[A-Za-z0-9_]+\.[01]$/.test(raw)) {
      const [, charId, e2] = raw.split('.'); avatar = { kind: 'operator', charId, e2: e2 === '1' };
    } else if (/^c\.[A-Za-z0-9_-]+={0,2}$/.test(raw)) {
      avatar = { kind: 'custom', dataUrl: DATA_PREFIX + raw.slice(2).replace(/-/g, '+').replace(/_/g, '/') };
    }
    return isAvatarChoice(avatar) ? avatar : DEFAULT_AVATAR;
  } catch { return DEFAULT_AVATAR; }
}

export function loadProfileAvatar(rawName, cookieDocument = globalThis.document) {
  const key = doctorProfileKey(rawName);
  try { return key && cookieMap(cookieDocument).get(OWNER_COOKIE) === encodeURIComponent(key) ? loadAvatar(cookieDocument) : DEFAULT_AVATAR; }
  catch { return DEFAULT_AVATAR; }
}
const initialOwner = doctorProfileKey(identity.loadName());
export const avatarStore = createStore({ avatar: loadProfileAvatar(initialOwner), profileKey: initialOwner, open: false, name: '', sync: 'idle' });
export const openAvatar = (name = store.get().me.name) => avatarStore.set({ open: true, name });
export const closeAvatar = () => avatarStore.set({ open: false });

/** Publish a complete cookie generation, preserving the old image if a write fails. */
export function persistAvatar(avatar, { cookieDocument = globalThis.document } = {}) {
  if (!isAvatarChoice(avatar)) throw new Error(N_('头像数据无效'));
  if (!cookieDocument) throw new Error(N_('浏览器无法保存头像'));
  const before = cookieMap(cookieDocument), oldMeta = before.get(AVATAR_PREF);
  const raw = avatar.kind === 'default' ? 'd' : avatar.kind === 'operator' ? `o.${avatar.charId}.${avatar.e2 ? 1 : 0}`
    : 'c.' + avatar.dataUrl.slice(DATA_PREFIX.length).replace(/\+/g, '-').replace(/\//g, '_');
  const count = Math.ceil(raw.length / CHUNK_SIZE);
  if (count > MAX_CHUNKS) throw new Error(N_('头像数据无效'));
  const meta = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}.${count}`, keys = parts(meta);
  try {
    // Write a fresh generation before publishing its pointer, so partial writes preserve the old choice.
    for (let i = 0; i < keys.length; i++) writeCookie(cookieDocument, keys[i], raw.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
    const written = cookieMap(cookieDocument);
    if (keys.some((key, i) => written.get(key) !== raw.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE))) throw new Error(N_('浏览器无法保存头像 Cookie，请允许此网站使用 Cookie'));
    writeCookie(cookieDocument, AVATAR_PREF, meta);
    if (cookieMap(cookieDocument).get(AVATAR_PREF) !== meta || !sameAvatar(loadAvatar(cookieDocument), avatar)) throw new Error(N_('浏览器无法保存头像 Cookie，请允许此网站使用 Cookie'));
  } catch (error) {
    try {
      for (const key of parts(oldMeta)) if (before.has(key)) writeCookie(cookieDocument, key, before.get(key));
      writeCookie(cookieDocument, AVATAR_PREF, oldMeta || '', oldMeta ? MAX_AGE : 0);
      for (const key of keys) writeCookie(cookieDocument, key, '', 0);
    } catch { /* Cookie writes remain unavailable; the in-memory choice has not changed. */ }
    throw error;
  }
  try { for (const key of parts(oldMeta)) writeCookie(cookieDocument, key, '', 0); } catch { /* Old parts expire naturally. */ }
}

/** Remove the previous owner's label before publishing another account's cache. */
export function persistProfileAvatar(avatar, profileKey, cookieDocument = globalThis.document) {
  const key = doctorProfileKey(profileKey);
  if (!key || !cookieDocument) throw new Error(N_('浏览器无法保存头像'));
  const owner = encodeURIComponent(key);
  if (cookieMap(cookieDocument).get(OWNER_COOKIE) !== owner) {
    writeCookie(cookieDocument, OWNER_COOKIE, '', 0);
    if (cookieMap(cookieDocument).has(OWNER_COOKIE)) throw new Error(N_('浏览器无法保存头像'));
  }
  persistAvatar(avatar, { cookieDocument });
  writeCookie(cookieDocument, OWNER_COOKIE, owner);
  if (cookieMap(cookieDocument).get(OWNER_COOKIE) !== owner) throw new Error(N_('浏览器无法保存头像'));
}

export function commitAvatar(avatar, expectedProfileKey = avatarStore.get().profileKey) {
  if (!isAvatarChoice(avatar)) throw new Error(N_('头像数据无效'));
  if (expectedProfileKey !== avatarStore.get().profileKey) throw new Error(N_('博士档案已切换，请重新打开头像设置'));
  const me = store.get().me;
  if (expectedProfileKey && expectedProfileKey !== doctorProfileKey(`${me.name}#${me.doctorCode}`)) throw new Error(N_('无法读取博士档案，请检查服务器连接'));
  let cacheFailed = false;
  try {
    if (expectedProfileKey) persistProfileAvatar(avatar, expectedProfileKey);
    else persistAvatar(avatar);
  } catch (error) {
    if (!expectedProfileKey) throw error;
    cacheFailed = true; toast(t('头像缓存无法保存，仍会同步到服务器档案'), 'warn');
  }
  avatarStore.set({ avatar, cacheFailed });
  store.patch('me', { avatar });
  try { avatarChannel?.postMessage('updated'); } catch { /* Other tabs can still refresh on focus. */ }
}

/** Editing from the title first resolves its two fields; the editor never modifies the previous login. */
export function openAvatarForProfile(rawName, net = profileNet) {
  const wanted = doctorIdentity(rawName); if (!wanted) return Promise.reject(new Error(N_('请填写代号或代号#四位数字代码')));
  if (net.status === 'online' && wanted.code && doctorProfileKey(rawName) === avatarStore.get().profileKey) { openAvatar(wanted.name); return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const done = (error) => { clearTimeout(timer); offWelcome(); offError(); if (error) reject(error); else { openAvatar(wanted.name); resolve(); } };
    const offWelcome = net.on('welcome', (msg) => { if (msg.name === wanted.name && (!wanted.code || msg.doctorCode === wanted.code)) done(); });
    const offError = net.on('helloError', done);
    const timer = setTimeout(() => done(new Error(N_('无法读取博士档案，请检查服务器连接'))), 10000);
    net.setName(rawName);
  });
}

// Cookies have no storage event. Broadcast updates within an origin and reread on tab focus.
const avatarChannel = (() => {
  try { return globalThis.document && typeof BroadcastChannel === 'function' ? new BroadcastChannel('sp.avatar') : null; }
  catch { return null; }
})();

/** An unsaved edit survives a same-account reconnect; switching accounts cancels its retries. */
export function installAvatarSync({ net, target = avatarStore, notify = (text) => toast(t(text), 'warn') }) {
  let revision = 0, timer = null, disposed = false, restoring = false, profileKey = null, cookieFailed = false, changing = false;
  const provider = () => target.get().avatar;
  net.getAvatar = provider;
  store.patch('me', { avatar: provider() });
  async function sync() {
    clearTimeout(timer);
    if (disposed || net.status !== 'online') { target.set({ sync: 'pending' }); return; }
    const current = ++revision, avatar = provider();
    target.set({ sync: 'sending' });
    try {
      await net.request('profile.avatar', { avatar });
      if (!disposed && current === revision && sameAvatar(avatar, provider())) target.set({ sync: 'synced' });
    } catch (error) {
      if (disposed || current !== revision || !sameAvatar(avatar, provider())) return;
      if (error.code === 'RATE') {
        target.set({ sync: 'pending' });
        timer = setTimeout(() => void sync(), 1200);
      } else {
        target.set({ sync: 'error' });
        notify(N_('头像暂未保存到服务器，请保持页面打开，重连后重试'));
      }
    }
  }
  const offStore = target.subscribe((s, prev) => {
    if (sameAvatar(s.avatar, prev.avatar)) return;
    store.patch('me', { avatar: s.avatar });
    if (!restoring) void sync();
  });
  const offProfile = net.on('profileChanging', ({ name }) => {
    revision++; clearTimeout(timer); profileKey = doctorProfileKey(name); cookieFailed = false; changing = true;
    restoring = true; target.set({ profileKey, avatar: loadProfileAvatar(name), open: false, sync: 'idle' }); store.patch('me', { avatar: provider() }); restoring = false;
  });
  const offWelcome = net.on('welcome', (msg) => {
    changing = false;
    if (msg.doctorCode && isAvatarChoice(msg.avatar)) {
      const key = `${msg.name}#${msg.doctorCode}`;
      if (key !== profileKey || !['pending', 'sending', 'error'].includes(target.get().sync)) {
        revision++; clearTimeout(timer); restoring = true;
        try { persistProfileAvatar(msg.avatar, key); cookieFailed = false; } catch { cookieFailed = true; notify(N_('浏览器无法保存头像')); }
        target.set({ profileKey: key, avatar: msg.avatar, sync: 'synced', cacheFailed: cookieFailed }); store.patch('me', { avatar: msg.avatar }); restoring = false;
        profileKey = key; return;
      }
      profileKey = key;
    }
    if (sameAvatar(msg.avatar, provider())) target.set({ sync: 'synced' });
    else void sync();
  });
  const refresh = () => {
    if (changing) return;
    const owner = cookieMap(globalThis.document).get(OWNER_COOKIE);
    if (profileKey && owner !== encodeURIComponent(profileKey)) return;
    if (!cookieFailed && !target.get().cacheFailed && !globalThis.document?.hidden) target.set({ avatar: loadAvatar() });
  };
  globalThis.addEventListener?.('focus', refresh);
  globalThis.document?.addEventListener('visibilitychange', refresh);
  avatarChannel?.addEventListener('message', refresh);
  return () => {
    disposed = true; revision++; clearTimeout(timer); offStore(); offWelcome(); offProfile();
    globalThis.removeEventListener?.('focus', refresh);
    globalThis.document?.removeEventListener('visibilitychange', refresh);
    avatarChannel?.removeEventListener('message', refresh);
    if (net.getAvatar === provider) net.getAvatar = () => null;
  };
}

export const rememberedProfileName = () => store.get().me.name || identity.loadName();
