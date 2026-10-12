import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { ReplayArchive } from '../../server/replays/archive.js';
import { packRecord, unpackRecord } from '../../server/replays/codec.js';
import { expiryHint } from '../../public/js/replay/timeline.js';
import { replayVersion } from '../../server/replays/version.js';
const quiet = { error() {} };
test('identical deployment contents have the same replay version on Windows and POSIX', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-portable-version-'));
  try {
    for (const name of ['server', 'shared', 'public/js', 'public/css', 'data']) fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{"version":"0.2.1"}');
    fs.writeFileSync(path.join(dir, 'server', 'entry.js'), 'export const value = 1;');
    const posix = replayVersion(dir);
    const windows = replayVersion(dir, (from, to) => path.relative(from, to).replaceAll('/', '\\'));
    assert.equal(windows, posix);
    fs.writeFileSync(path.join(dir, 'server', 'entry.js'), 'export const value = 2;');
    assert.notEqual(replayVersion(dir), posix);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
function record() { return { v: 1, id: randomUUID(), key: 'a'.repeat(48), version: 'v1', ttlMs: 72 * 3600 * 1000, startedAt: 100, endedAt: 200, expiresAt: 200 + 72 * 3600 * 1000, status: 'ready', errors: [], result: { victory: true }, restrictions: { difficulty: 'NORMAL' }, nodes: [{ public: { round: 14 }, players: { p: { private: { funds: 8 } } } }], events: [], publicTrack: [], fields: [] }; }
test('snapshot codec is lossless across changes, removals, order, empty frames and keyframes', () => {
  const r = record(); r.fields = [{ frames: Array.from({ length: 220 }, (_, i) => ({ gt: i / 10, snap: { t: i / 10, units: i % 11 ? [[i % 3, 1, i / 3], [7, 2, 10]] : [], killed: i, boss: { hp: 100 - i } }, ev: [['attack', i]], progress: { leaks: i } })) }];
  assert.deepEqual(unpackRecord(packRecord(r)), r);
});
test('explicit legacy TTL can still expire archived inputs; current UI describes count retention', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-expiry-')); let now = 200;
  let a = new ReplayArchive(dir, quiet, { now: () => now, version: 'v1', ttlMs: 72 * 3600 * 1000 });
  try {
    const r = record(); r.communications = [{ kind: 'radio', radio: 0, at: 1 }]; r.fields = [{ players:['p'], spec:{v:1}, frames: [{ snap: { units: [[1, 2, 3, 10, 10]] }, ev: [], gt: 0 }] }]; a.write(r);
    const summary = a.get(r.id, r.key, { summaryOnly: true }); assert.deepEqual(summary.fields, []); assert.deepEqual(summary.communications, []); assert.deepEqual(a.get(r.id, r.key).communications, r.communications); assert.deepEqual(summary.result, r.result);
    now = r.expiresAt - 60000; assert.equal(a.get(r.id, r.key).status, 'ready');
    assert.match(expiryHint(r, now), /最近30条/);
    now = r.expiresAt; const expired = a.get(r.id, r.key);
    assert.equal(expired.status, 'expired'); assert.equal(expired.expiryReason, 'time'); assert.deepEqual(expired.communications, []); assert.deepEqual(expired.fields, []); assert.deepEqual(expired.result, r.result); assert.deepEqual(expired.nodes[0].players, {});
    assert.match(expiryHint(expired, now), /已过期/);
    await a.close(); a = new ReplayArchive(dir, quiet, { now: () => now, version: 'v1', ttlMs: 72 * 3600 * 1000 }); assert.equal(a.get(r.id, r.key).status, 'expired');
  } finally { await a.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('UI version updates retain compatible playback and archived result', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-version-')); let a = new ReplayArchive(dir, quiet, { now: () => 200, version: 'v1', ttlMs: 72 * 3600 * 1000 });
  try { const r = record(); a.write(r); await a.close(); a = new ReplayArchive(dir, quiet, { now: () => 200, version: 'v2' }); const old = a.get(r.id, r.key); assert.equal(old.status, 'ready'); assert.equal(old.expiryReason, undefined); assert.match(expiryHint(old, 200), /兼容/); assert.deepEqual(old.result, r.result); }
  finally { await a.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('compressed replay hard budget rejects oversized inputs without losing settlement', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-size-')); const a = new ReplayArchive(dir, quiet, { now: () => 200, version: 'v1', ttlMs: 72 * 3600 * 1000, maxBytes: 4000 });
  try { const r = record(); r.status = 'processing'; r.events = [{ random: randomBytes(16000).toString('hex') }]; a.save(r, {}); const saved = a.get(r.id, r.key); assert.equal(saved.status, 'expired'); assert.equal(saved.expiryReason, 'size-limit'); assert.deepEqual(saved.result, r.result); assert.ok(fs.statSync(a.file(r.id)).size < 4000); assert.ok(!fs.existsSync(path.join(dir, `${r.id}.inputs.gz`))); }
  finally { await a.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed final archive writes retain durable worker inputs for restart recovery', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-write-fail-')); const a = new ReplayArchive(dir, quiet, { now: () => 200, version: 'v1', ttlMs: 72 * 3600 * 1000 });
  try {
    const r = record(); r.status = 'processing'; const original = a.writeBuffer.bind(a); let rejectFinal = false;
    a.writeBuffer = (target, buffer) => { if (rejectFinal && target === a.file(r.id)) throw new Error('disk full'); original(target, buffer); };
    a.save(r, {}); rejectFinal = true;
    for (let i = 0; i < 200 && a.pending.get(r.id)?.status !== 'partial'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(a.pending.get(r.id)?.status, 'partial'); assert.ok(fs.existsSync(path.join(dir, `${r.id}.inputs.gz`)));
    await a.close(); const restarted = new ReplayArchive(dir, quiet, { now: () => 200, version: 'v1', ttlMs: 72 * 3600 * 1000 });
    try { for (let i = 0; i < 200 && restarted.get(r.id, r.key)?.status === 'processing'; i++) await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(restarted.get(r.id, r.key).status, 'ready'); }
    finally { await restarted.close(); }
  } finally { await a.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP summary omits tracks; cached tickets restore only to the matching complete doctor profile', async () => {
  const { startServer } = await import('../../server/index.js'), { TestClient } = await import('../helpers/wsClient.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-archive-api-')); const archive = new ReplayArchive(dir, quiet, { now: () => 200, version: 'v1', ttlMs: 72 * 3600 * 1000 });
  const r = record(); r.participants = [{ playerId: 'p_old', name: '博士', doctorCode: '0001', seat: 0 }]; r.result = { victory: true, modeId: 'mode_multi_normal', difficulty: 'NORMAL', roundsPassed: 14, players: r.participants };
  r.fields = [{ frames: [{ gt: 0, snap: { units: [[1, 2, 3]] }, ev: [] }] }]; archive.write(r);
  const { ProfileStore } = await import('../../server/profiles/store.js'); const profileStore = new ProfileStore(path.join(dir, 'profiles')); profileStore.resolve('博士', '0001');
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, replayArchive: archive, profileStore }); const clients = [];
  try {
    const a = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`); clients.push(a); await a.hello('博士#0001');
    assert.equal((await a.request({ t: 'profile.records', entries: [{ id: r.id, key: r.key, playerId: 'p_old' }] })).t, 'ok');
    const history = await a.waitFor('profile.history'); assert.equal(history.history[0].id, r.id); assert.equal(history.history[0].playerId, 'p_old');
    const b = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`); clients.push(b); await b.hello('博士#0002');
    assert.equal((await b.request({ t: 'profile.records', entries: [{ id: r.id, key: r.key, playerId: 'p_old' }] })).code, 'BAD_TARGET');
    const summary = await (await fetch(`${server.url}/api/replays/${r.id}?summary=1`, { headers: { Authorization: `Bearer ${r.key}` } })).json();
    assert.equal(summary.serverNow, 200); assert.deepEqual(summary.fields, []); assert.deepEqual(summary.communications, []); assert.deepEqual(summary.result, r.result); assert.equal(summary.key, undefined);
    const full = await (await fetch(`${server.url}/api/replays/${r.id}`, { headers: { Authorization: `Bearer ${r.key}` } })).json(); assert.deepEqual(full.fields, r.fields);
    assert.equal((await fetch(`${server.url}/api/replays/${r.id}?summary=1`)).status, 404);
    assert.match(full.shareCode, /^[A-Za-z0-9_-]{16}$/);
    const guestResponse = await fetch(`${server.url}/api/shared-replays/${full.shareCode}`), guestText = await guestResponse.text();
    assert.equal(guestResponse.status, 200); assert.ok(!guestText.includes(r.key));
    assert.deepEqual(JSON.parse(guestText).fields, r.fields); assert.deepEqual(JSON.parse(guestText).result, r.result);
    assert.equal((await fetch(`${server.url}/api/shared-replays/${'x'.repeat(16)}`)).status, 404);
    assert.equal((await fetch(`${server.url}/api/shared-replays/invalid`)).status, 404);
    const head = await fetch(`${server.url}/api/shared-replays/${full.shareCode}?summary=1`, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  } finally { await Promise.all(clients.map((c) => c.close())); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('share codes survive restart and expiry; adding a code to an old encoded record preserves all units', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-share-')); let a = new ReplayArchive(dir, quiet, { now: () => 200, version: 'v1', ttlMs: 72 * 3600 * 1000 });
  try {
    const r = record(); r.fields = [{ frames: [{ gt: 0, snap: { units: [[1, 2, 3]] }, ev: [] }, { gt: 1, snap: { units: [[1, 3, 4]] }, ev: [] }] }];
    // Existing archives predate shareCode but already use the lossless codec.
    a.writeJson(a.file(r.id), packRecord(r)); await a.close(); a = new ReplayArchive(dir, quiet, { now: () => 200, version: 'v1', ttlMs: 72 * 3600 * 1000 });
    const migrated = a.get(r.id, r.key), code = migrated.shareCode; assert.match(code, /^[A-Za-z0-9_-]{16}$/); assert.deepEqual(migrated.fields, r.fields);
    assert.deepEqual(a.getShared(code).fields, r.fields); assert.equal(a.getShared(code).key, undefined);
    const other = record(); a.write(other); assert.notEqual(other.shareCode, code);
    await a.close(); a = new ReplayArchive(dir, quiet, { now: () => r.expiresAt, version: 'v1', ttlMs: 72 * 3600 * 1000 });
    const expired = a.getShared(code); assert.equal(expired.status, 'expired'); assert.equal(expired.expiryReason, 'time'); assert.deepEqual(expired.result, r.result); assert.deepEqual(expired.fields, []);
  } finally { await a.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unfinished legacy archives keep the migrated share code when the worker resumes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-share-pending-')); let a = new ReplayArchive(dir, quiet, { now: () => 200, version: 'v1', ttlMs: 72 * 3600 * 1000 });
  try {
    const r = record(); r.status = 'processing';
    a.writeJson(a.file(r.id), packRecord(r)); a.writeJson(path.join(dir, `${r.id}.inputs.gz`), { record: r, data: {} });
    await a.close(); a = new ReplayArchive(dir, quiet, { now: () => 200, version: 'v1', ttlMs: 72 * 3600 * 1000 });
    const code = a.get(r.id, r.key).shareCode;
    for (let i = 0; i < 200 && a.get(r.id, r.key).status === 'processing'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(a.get(r.id, r.key).status, 'ready'); assert.equal(a.getShared(code).shareCode, code); assert.equal(a.getShared(code).key, undefined);
  } finally { await a.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
