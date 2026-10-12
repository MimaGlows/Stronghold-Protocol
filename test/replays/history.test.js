import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readHistory, rememberMatch, historyStore, fetchReplay, shareReplayUrl, parseSharedReplay, openSharedReplay, restoreHistory, beginHistoryProfile } from '../../public/js/replay/history.js';
import { net } from '../../public/js/net.js';
import { profileViewStore, loadProfileView, clearProfileView } from '../../public/js/ui/profileView.js';
const ticket = { id: '4f32d412-6f3b-4c6d-bf21-43efa8ae932d', key: 'a'.repeat(48), startedAt: 1000 };
test('live records do not write browser storage; switching identities clears the replay selection', async () => {
  let writes = 0; const storage = { getItem: () => JSON.stringify({ owner: '博士#0001', items: [ticket] }), setItem() { writes++; } };
  historyStore.set({ profileKey: '博士#0001', items: [], selected: null, mode: 'list' });
  rememberMatch({ t: 'm.result', replay: ticket, players: [{ playerId: 'p1' }] }, 'p1', storage);
  assert.equal(writes, 0); assert.deepEqual(historyStore.get().items, []);
  restoreHistory([ticket], storage); assert.equal(writes, 0);
  historyStore.set({ selected: ticket }); beginHistoryProfile('博士#0002', storage);
  assert.deepEqual(historyStore.get().items, []); assert.equal(historyStore.get().selected, null);
  beginHistoryProfile('博士#0001', storage); assert.deepEqual(historyStore.get().items, []);
  assert.equal(readHistory(storage, '博士#0002').length, 0);
  let request; const body = { v: 1, nodes: [], fields: [] };
  await fetchReplay({ ...ticket, owner: 'b'.repeat(64) }, async (...args) => { request = args; return { ok: true, json: async () => body }; });
  assert.ok(request[0].includes('?owner=')); assert.ok(!request[0].includes(ticket.key));
  assert.equal(request[1].headers.Authorization, 'Bearer ' + ticket.key);
});

test('shared links contain only the match code and never enter personal history', async () => {
  const code = 'aB01cD23eF45gH67', url = shareReplayUrl(code, 'https://example.org/?room=ABCD#other');
  assert.equal(url, `https://example.org/#replay=${code}`); assert.equal(parseSharedReplay(new URL(url).hash), code);
  assert.equal(parseSharedReplay('#replay=bad'), null); assert.equal(shareReplayUrl('bad', 'https://example.org'), '');
  const items = historyStore.get().items; openSharedReplay(code); restoreHistory(items, { setItem() {} });
  const entry = historyStore.get().selected; assert.equal(entry.shared, true); assert.equal(entry.key, undefined); assert.deepEqual(historyStore.get().items, items);
  let request; await fetchReplay(entry, async (...args) => { request = args; return { ok: true, json: async () => ({ v: 1, nodes: [], fields: [] }) }; });
  assert.equal(request[0], `/api/shared-replays/${code}`); assert.deepEqual(request[1].headers, {});
});
test('official stats player view never replaces personal history and drops stale account responses', async () => {
  const original = { fetch: globalThis.fetch, name: net.name, status: net.status };
  net.name = '本人#0001'; net.status = 'online';
  try {
    historyStore.set({ profileKey: '本人#0001', items: [ticket] });
    let request;
    globalThis.fetch = async (...args) => { request = args; return { ok: true, json: async () => ({ profileKey:'队友#0001', records: [{ id:ticket.id }], revision:1, total:1 }) }; };
    await loadProfileView('队友#0001');
    assert.deepEqual(historyStore.get().items, [ticket]); assert.equal(profileViewStore.get().records[0].key, undefined);
    assert.match(request[0], /api\/social-history\?identity=/);
    let complete; globalThis.fetch = () => new Promise(resolve => { complete = resolve; });
    const waiting = loadProfileView('队友#0002');
    clearProfileView(); net.name = '本人#0002'; beginHistoryProfile(net.name);
    complete({ ok:true, json:async () => ({ records:[{ id:ticket.id }],revision:1 }) }); await waiting;
    assert.deepEqual(profileViewStore.get().records, []); assert.equal(profileViewStore.get().profileKey, null);
    globalThis.fetch = async () => ({ ok:false,status:403 }); await loadProfileView('队友#0001');
    assert.match(profileViewStore.get().error, /不可见/); assert.deepEqual(profileViewStore.get().records, []);
  } finally { globalThis.fetch = original.fetch; net.name = original.name; net.status = original.status; clearProfileView(); }
});
