// Browser-local capability index; replay bodies and frames live on the server, never in avatar cookies.
import { createStore } from '../store.js';
import { t } from '../../../shared/i18n.js';
import { doctorProfileKey } from '../../../shared/doctor.js';
import { identity, net } from '../net.js';
import { openStats, closeStats } from '../screens/stats.js';
const KEY = 'sp.play-history.v1';
export function readHistory(storage, profileKey) {
  try {
    const cached = JSON.parse((storage ?? globalThis.localStorage)?.getItem(KEY) || '[]');
    if (profileKey !== undefined && (!profileKey || Array.isArray(cached) || cached.owner !== profileKey)) return [];
    const items = Array.isArray(cached) ? cached : cached.items;
    return Array.isArray(items) ? items.filter((r) => /^[a-f0-9-]{36}$/.test(r.id) && /^[a-f0-9]{48}$/.test(r.key)).slice(0, 200) : [];
  }
  catch { return []; }
}
const initialOwner = doctorProfileKey(identity.loadName());
export const historyStore = createStore({ items: [], profileKey: initialOwner, open: false, selected: null, mode: 'list' });
export function openPlayerHistory(profileKey) { openStats('history', profileKey); }
export function rememberMatch() { /* authoritative records are pushed by the server */ }
export function openHistory(entry = null, mode = 'list') { if (!entry) { const target=historyStore.get().selected?.socialIdentity; closeHistory(); openStats('history', target); return; } closeStats(); historyStore.set({ open: true, selected: entry, mode }); }
export function closeHistory() { historyStore.set({ open: false }); if (parseSharedReplay(globalThis.location?.hash)) globalThis.history?.replaceState(null, '', `${location.pathname}${location.search}`); }
export function parseSharedReplay(hash) { const code = new URLSearchParams(String(hash || '').replace(/^#/, '')).get('replay'); return /^[A-Za-z0-9_-]{16}$/.test(code || '') ? code : null; }
export function shareReplayUrl(code, base = globalThis.location?.href) {
  if (!/^[A-Za-z0-9_-]{16}$/.test(code || '')) return '';
  const url = new URL(base); url.search = ''; url.hash = `replay=${code}`; return url.href;
}
export function openSharedReplay(code) { if (/^[A-Za-z0-9_-]{16}$/.test(code || '')) openHistory({ shareCode: code, shared: true }, 'result'); }
export async function fetchReplay(entry, fetchFn = globalThis.fetch, summaryOnly = false, options = {}) {
  const viewer=net.name;
  const response = await fetchFn(`${entry.socialIdentity ? '/api/social-history?'+new URLSearchParams({identity:entry.socialIdentity,id:entry.id,...(summaryOnly?{summary:'1'}:{})}) : entry.shared ? '/api/shared-replays/' + entry.shareCode : '/api/replays/' + entry.id}${!entry.socialIdentity && entry.owner ? '?owner=' + entry.owner + (summaryOnly ? '&summary=1' : '') : !entry.socialIdentity && summaryOnly ? '?summary=1' : ''}` + (options.tracks ? ((entry.socialIdentity || entry.owner || summaryOnly) ? '&' : '?') + new URLSearchParams({tracks:'1',...(options.field != null ? {field:options.field,chunk:options.chunk} : {})}) : ''), { signal: options.signal, headers: entry.shared ? {} : { Authorization: `Bearer ${entry.socialIdentity ? identity.getToken() : entry.key}` }, cache: 'no-store' });
  if (!response.ok) { const error=new Error(response.status===403?t('对方的资料不可见'):t('记录不存在、已被删除或服务器暂不可用')); error.code=response.status; throw error; }
  const record = await response.json();
  if(entry.socialIdentity && (net.status !== 'online'||viewer!==net.name)) throw new Error(t('状态暂不可用'));
  if (options.field != null) { if (!Array.isArray(record.frames)) throw new Error(t('游玩记录格式不支持')); return record; }
  if (record.v !== 1 || !Array.isArray(record.nodes) || !Array.isArray(record.fields)) throw new Error(t('游玩记录格式不支持'));
  if (record.serverNow != null) record.receivedAt = Date.now();
  return record;
}

/** Server profile is authoritative when switching callsign/code; never mix another profile's records. */
export function beginHistoryProfile(rawName, _storage = globalThis.localStorage) {
  const key = doctorProfileKey(rawName), previous = historyStore.get();
  if (key && key === previous.profileKey) return;
  historyStore.set({ profileKey: key, items: [], selected: previous.selected?.shared ? previous.selected : null, mode: previous.selected?.shared ? previous.mode : 'list' });
}
export function restoreHistory(items, _storage = globalThis.localStorage, profileKey = historyStore.get().profileKey) {
  const valid = Array.isArray(items) ? items.filter((r) => /^[a-f0-9-]{36}$/.test(r.id) && /^[a-f0-9]{48}$/.test(r.key)).slice(0, 200) : [];
  const previous = historyStore.get(), selected = previous.selected && (previous.selected.shared || previous.selected.socialIdentity || valid.some((e) => e.id === previous.selected.id && e.playerId === previous.selected.playerId)) ? previous.selected : null;
  historyStore.set({ profileKey, items: valid, selected, mode: selected ? previous.mode : 'list' });
}
