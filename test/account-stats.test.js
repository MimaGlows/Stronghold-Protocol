import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProfileStore } from '../server/profiles/store.js';
import { AccountStats } from '../server/profiles/stats.js';
import { ReplayArchive } from '../server/replays/archive.js';
import { buildRecord, aggregateStats } from '../shared/stats.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
const quiet = { info() {}, warn() {}, error() {} };
function settled(id = randomUUID(), t = 100, pid = 'p') {
  return { ...buildRecord({ victory: true, roundsPassed: 14, modeId: 'mode_single_normal', difficulty: 'NORMAL', durationMs: 1000,
    players: [{ playerId: pid, name: 'same', alive: true, victory: true, roundsPassed: 14, bandId: 'band_amiya', stats: { kills: 17 } }] }, { myId: pid, now: t }), id };
}
function archiveRecord(a, participants, id = randomUUID()) {
  const record = { v: 1, id, key: 'a'.repeat(48), version: 'test', startedAt: 100, endedAt: 200, status: 'ready', participants,
    result: { victory: true, roundsPassed: 14, difficulty: 'NORMAL', modeId: 'mode_multi_normal', players: participants.map(p => ({ ...p, alive: true, victory: true, roundsPassed: 14, stats: { kills: 17 } })) },
    nodes: [], fields: [{ players: [], spec: { v: 1 }, frames: [{ gt: 0, snap: { units: [] }, ev: [] }] }], events: [], publicTrack: [], pauses: [], errors: [] };
  a.write(record); return record;
}
async function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-account-stats-'));
  const profiles = new ProfileStore(path.join(dir, 'profiles')), archive = new ReplayArchive(dir, quiet, { version: 'test' });
  try { await fn({ dir, profiles, archive }); } finally { await archive.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}
test('migration preserves owned settlements, unknown legacy summaries and account isolation; repeat is byte-identical', () => fixture(({ profiles, archive }) => {
  const p = profiles.resolve('same', '0001').profile, other = profiles.resolve('same', '0002').profile;
  archiveRecord(archive, [{ playerId: 'p', name: 'same', doctorCode: '0001', seat: 0 }]);
  profiles.remember(p, { id: 'missing', startedAt: 20 }, 'old', { victory: false, players: [{ playerId: 'old', name: 'same' }] });
  let service = new AccountStats(profiles, archive, quiet);
  assert.equal(service.snapshot(p).total, 2); assert.equal(service.snapshot(other).total, 0); assert.equal(service.snapshot(p).aggregate.sums.kills, 17);
  const before = fs.readFileSync(profiles.file(p.name, p.code)); service = new AccountStats(profiles, archive, quiet);
  assert.deepEqual(fs.readFileSync(profiles.file(p.name, p.code)), before);
}));
test('30 records include quits; replay expires per account while another participant retains it', () => fixture(({ profiles, archive }) => {
  const a = profiles.resolve('same', '0001').profile, b = profiles.resolve('same', '0002').profile;
  const replay = archiveRecord(archive, [{ playerId: 'p', name: 'same', doctorCode: '0001' }, { playerId: 'q', name: 'same', doctorCode: '0002' }]);
  const service = new AccountStats(profiles, archive, quiet);
  const ticketA = service.snapshot(a).records[0].replay, ticketB = service.snapshot(b).records[0].replay;
  for (let i = 0; i < 29; i++) service.put(a, { ...settled(undefined, 1000 + i), end: 'quit' });
  assert.equal(service.getReplay(replay.id, ticketA.key, ticketA.owner, {}).status, 'ready');
  service.put(a, { ...settled(undefined, 2000), end: 'quit' });
  assert.equal(service.getReplay(replay.id, ticketA.key, ticketA.owner, {}).expiryReason, 'retention');
  assert.equal(service.getReplay(replay.id, ticketB.key, ticketB.owner, {}).status, 'ready');
  assert.equal(service.getReplay(replay.id, ticketA.key, ticketB.owner, {}), null);
  for (let i = 0; i < 30; i++) service.put(b, { ...settled(undefined, 3000 + i, 'q'), end: 'quit' });
  assert.equal(archive.getShared(replay.shareCode).expiryReason, 'retention');
  assert.deepEqual(archive.getShared(replay.shareCode).fields, []);
}));
test('repeated result never duplicates or overwrites a quit; older summaries still aggregate', () => fixture(({ profiles, archive }) => {
  const p = profiles.resolve('same', '0001').profile, service = new AccountStats(profiles, archive, quiet), id = randomUUID();
  service.put(p, { ...settled(id), end: 'quit', roundsPassed: 0, players: [{ playerId: 'p', alive: true, roundsPassed: 0 }] });
  service.put(p, settled(id)); assert.equal(service.snapshot(p).total, 1); assert.equal(service.snapshot(p).aggregate.count, 0);
  for (let i = 0; i < 35; i++) service.put(p, settled(undefined, i + 1000));
  assert.equal(service.snapshot(p).aggregate.sums.kills, 35 * 17); assert.equal(service.read(p).statistics.records[30].compact, true);
}));
test('pagination has bounded rows and summaries across 1000 records; no browser budget truncation', () => fixture(({ profiles, archive }) => {
  const p = profiles.resolve('same', '0001').profile;
  p.statistics = { v: 1, revision: 4, records: Array.from({ length: 1000 }, (_, i) => settled(undefined, i)).reverse() }; profiles.save(p);
  const service = new AccountStats(profiles, archive, quiet), first = service.snapshot(p), second = service.snapshot(p, first.next);
  assert.equal(first.records.length, 50); assert.equal(second.records.length, 50); assert.equal(first.aggregate.count, 1000);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 64 * 1024); assert.equal(service.snapshot(p, 950).next, null);
  service.put(p, settled(undefined, 2000)); assert.equal(service.snapshot(p).total, 1000);
}));
test('default archive retention ignores old wall-clock expiry and UI build versions', () => fixture(({ archive }) => {
  const r = archiveRecord(archive, []); r.expiresAt = 1; archive.write(r);
  assert.equal(archive.get(r.id, r.key).status, 'ready'); r.version = 'old'; archive.write(r);
  assert.equal(archive.get(r.id, r.key).status, 'ready');
}));
test('retention revokes queued and running replay work without resurrecting frames', () => fixture(async ({ archive, dir }) => {
  const r = archiveRecord(archive, []); r.status = 'processing'; archive.save(r, {});
  assert.ok(fs.existsSync(path.join(dir, `${r.id}.inputs.gz`)));
  archive.expire(r, 'retention');
  assert.equal(archive.pending.has(r.id), false); assert.equal(archive.queue.some(t => t.record.id === r.id), false);
  assert.equal(fs.existsSync(path.join(dir, `${r.id}.inputs.gz`)), false);
  for (let i = 0; archive.worker && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(archive.get(r.id, r.key).status, 'expired'); assert.deepEqual(archive.get(r.id, r.key).fields, []);
}));
test('migration of departed humans does not invent settlement titles or combat totals', () => fixture(({ profiles, archive }) => {
  const p = profiles.resolve('same', '0001').profile;
  const r = archiveRecord(archive, [{ playerId: 'p', name: 'same', doctorCode: '0001' }]);
  Object.assign(r.result.players[0], { left: true, title: { id: 'comment_1' } }); archive.write(r);
  const stats = new AccountStats(profiles, archive, quiet).snapshot(p);
  assert.equal(stats.records[0].end, 'quit'); assert.deepEqual(stats.aggregate.titles, {}); assert.deepEqual(stats.aggregate.sums, {});
}));
test('failed atomic profile write does not publish new statistics and can be retried', () => fixture(({ profiles, archive }) => {
  const p = profiles.resolve('same', '0001').profile, service = new AccountStats(profiles, archive, quiet), save = profiles.save.bind(profiles), rec = settled();
  profiles.save = () => { throw new Error('disk full'); }; assert.throws(() => service.put(p, rec), /disk full/);
  assert.equal(service.snapshot(p).total, 0); profiles.save = save; service.put(p, rec); assert.equal(service.snapshot(p).total, 1);
}));
test('authenticated websocket exposes only own stats; real solo quit persists immediately without replay and survives restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-stats-ws-')); let server, client;
  try {
    server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, replayDir: dir });
    client = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`); await client.hello('same#0001');
    assert.equal((await client.request({ t: 'profile.stats.get', owner: 'same#0002' })).profileKey, 'same#0001');
    await client.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' }); await client.request({ t: 'room.start' });
    await client.request({ t: 'g.leave' });
    let stats = await client.request({ t: 'profile.stats.get' }); assert.equal(stats.total, 1); assert.equal(stats.records[0].end, 'quit'); assert.equal(stats.aggregate.count, 0); assert.equal(stats.records[0].replay, undefined);
    await client.close(); await server.close(); server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, replayDir: dir });
    client = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`); await client.hello('same#0001'); stats = await client.request({ t: 'profile.stats.get' }); assert.equal(stats.total, 1);
    await client.hello('same#0002'); stats = await client.request({ t: 'profile.stats.get' }); assert.equal(stats.total, 0);
  } finally { await client?.close(); await server?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('shared pure aggregate matches official counting semantics', () => {
  const r = settled(), early = { ...settled(), end: 'quit', players: [{ playerId: 'p', alive: true, roundsPassed: 0 }] };
  assert.equal(aggregateStats([r, early]).count, 1); assert.equal(aggregateStats([r, early]).excluded, 1);
});
test('co-op quit remains a quit after teammate settlement; spectators and bots create no statistics', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-stats-coop-')), clients = [];
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, replayDir: dir });
  try {
    for (const name of ['same#0001', 'same#0002', 'viewer#0001']) {
      const c = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`); await c.hello(name); clients.push(c);
    }
    const [a, b, observer] = clients;
    await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    const room = [...server.lobby.rooms.values()][0];
    await b.request({ t: 'room.join', code: room.code }); await observer.request({ t: 'room.spectate', code: room.code });
    await a.request({ t: 'room.addBot' }); await b.request({ t: 'room.ready', ready: true }); await a.request({ t: 'room.start' });
    const match = room.match; assert.ok(match);
    await a.request({ t: 'g.leave' }); match.finish({ victory: true });
    const first = await a.request({ t: 'profile.stats.get' }), second = await b.request({ t: 'profile.stats.get' }), third = await observer.request({ t: 'profile.stats.get' });
    assert.equal(first.total, 1); assert.equal(first.records[0].end, 'quit'); assert.equal(first.records[0].replay, undefined);
    assert.equal(second.total, 1); assert.equal(second.records[0].end, 'settled'); assert.ok(second.records[0].replay);
    assert.equal(third.total, 0); assert.equal(server.lobby.accountStats.allProfiles().length, 3);
    const ticket = second.records[0].replay;
    const result = await fetch(`${server.url}/api/replays/${ticket.id}?owner=${ticket.owner}&summary=1`, { headers: { Authorization: `Bearer ${ticket.key}` } });
    assert.equal(result.status, 200); assert.equal((await result.json()).key, undefined);
  } finally { await Promise.all(clients.map(c => c.close())); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('client discards old-account responses and refreshes pagination on revision mismatch without local storage', async () => {
  const { accountStatsStore, beginStatsProfile, refreshStats } = await import('../public/js/ui/accountStats.js');
  const { net } = await import('../public/js/net.js');
  const previous = { request: net.request, status: net.status }, replies = [];
  net.status = 'online'; net.request = () => new Promise(resolve => replies.push(resolve));
  try {
    beginStatsProfile('a#0001'); const a = refreshStats(); beginStatsProfile('a#0002'); const b = refreshStats();
    replies[1]({ profileKey: 'a#0002', revision: 1, total: 1, records: [settled()], aggregate: aggregateStats([]), next: null }); await b;
    replies[0]({ profileKey: 'a#0001', revision: 1, total: 99, records: [settled()], aggregate: aggregateStats([]), next: null }); await a;
    assert.equal(accountStatsStore.get().profileKey, 'a#0002'); assert.equal(accountStatsStore.get().total, 1);
    beginStatsProfile('a#0003'); assert.deepEqual(accountStatsStore.get().records, []);
    accountStatsStore.set({ revision: 1, next: 50, records: [settled()], total: 60 });
    const more = refreshStats(true);
    replies[2]({ profileKey: 'a#0003', revision: 2, total: 61, records: [settled()], aggregate: aggregateStats([]), next: null });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(replies.length, 4);
    replies[3]({ profileKey: 'a#0003', revision: 2, total: 61, records: [settled()], aggregate: aggregateStats([]), next: 50 }); await more;
    assert.equal(accountStatsStore.get().records.length, 1); assert.equal(accountStatsStore.get().revision, 2);
  } finally { net.request = previous.request; net.status = previous.status; }
});
