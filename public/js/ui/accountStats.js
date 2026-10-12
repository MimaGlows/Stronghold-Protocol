import { createStore } from '../store.js';
import { net } from '../net.js';
import { aggregateStats } from '../../../shared/stats.js';

export const accountStatsStore = createStore({ profileKey: null, revision: -1, records: [], aggregate: aggregateStats([]), total: 0, next: null, loading: false, error: '' });
let epoch = 0, request = 0;
export function beginStatsProfile(profileKey, revision) {
  const old = accountStatsStore.get();
  if (old.profileKey !== profileKey) {
    epoch++; request++;
    accountStatsStore.set({ profileKey, revision: -1, records: [], aggregate: aggregateStats([]), total: 0, next: null, loading: false, error: '' });
  } else if (revision !== undefined && revision !== old.revision) { epoch++; }
}
export async function refreshStats(more = false) {
  const state = accountStatsStore.get(), owner = state.profileKey;
  if (!owner || net.status !== 'online') return;
  if (more && (state.loading || state.next == null)) return;
  const seq = ++request, generation = epoch, offset = more ? state.next : 0;
  accountStatsStore.set({ loading: true, error: '' });
  try {
    const msg = await net.request('profile.stats.get', { offset });
    if (seq !== request || generation !== epoch || msg.profileKey !== accountStatsStore.get().profileKey) return;
    if (more && msg.revision !== state.revision) { accountStatsStore.set({ loading: false }); return refreshStats(); }
    accountStatsStore.set({ records: more ? [...state.records, ...msg.records] : msg.records, aggregate: msg.aggregate, revision: msg.revision, total: msg.total, next: msg.next, loading: false });
  } catch (error) {
    if (seq === request && generation === epoch) accountStatsStore.set({ loading: false, error: String(error.message || error) });
  }
}
