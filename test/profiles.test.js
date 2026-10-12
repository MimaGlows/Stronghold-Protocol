import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProfileStore } from '../server/profiles/store.js';
import { doctorIdentity } from '../shared/doctor.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { validateC2S } from '../shared/protocol.js';
const avatar = { kind: 'operator', charId: 'char_010_chen', e2: false };
test('callsign/code parser keeps leading zeroes and rejects ambiguous or malformed codes', () => {
  assert.deepEqual(doctorIdentity(' 博士#0001 '), { name: '博士', code: '0001' }); assert.deepEqual(doctorIdentity('博士'), { name: '博士', code: null });
  for (const s of ['#0001', '博士#001', '博士#00001', '博士#test', '博士#0001#0002', 'a'.repeat(25)]) assert.equal(doctorIdentity(s), null);
});

test('duplicate identity lookup warns without exposing profile data or reserving codes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-profile-lookup-'));
  let server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, profileDir: dir });
  try {
    server.lobby.profiles.resolve('博士', '0001', avatar);
    const lookup = async (name, code) => (await fetch(`${server.url}/api/profiles/availability?${new URLSearchParams({ name, code })}`)).json();
    assert.deepEqual(await lookup('博士', '0001'), { nameExists: true, codeExists: true });
    assert.deepEqual(await lookup('博士', '0002'), { nameExists: true, codeExists: false });
    assert.deepEqual(await lookup('新博士', ''), { nameExists: false, codeExists: false });
    assert.equal(server.lobby.profiles.read('博士', '0002'), null);
    assert.equal((await fetch(`${server.url}/api/profiles/availability?name=博士&code=123`)).status, 400);
    await server.close(); server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, profileDir: dir });
    assert.deepEqual(await lookup('博士', '0001'), { nameExists: true, codeExists: true });
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('server profiles atomically persist avatar/history and isolate same-name different-code players', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-profile-'));
  try {
    let s = new ProfileStore(dir); let p = s.resolve('博士', '0001', avatar).profile;
    p = s.remember(p, { id: 'id', key: 'secret', startedAt: 42 }, 'p_old', { players: [{ name: '博士', playerId: 'p_old' }], victory: true, roundsPassed: 14 });
    s.avatar(p, { kind: 'default' }); s = new ProfileStore(dir);
    const restored = s.resolve('博士', '0001', avatar); assert.equal(restored.restored, true); assert.deepEqual(restored.profile.avatar, { kind: 'default' }); assert.equal(restored.profile.history[0].playerId, 'p_old');
    assert.equal(s.resolve('博士', '0002').profile.history.length, 0);
    const a = s.resolve('博士'), b = s.resolve('博士'); assert.match(a.profile.code, /^\d{4}$/); assert.notEqual(a.profile.code, b.profile.code);
    assert.ok(s.file('../博士', '0001').startsWith(dir + path.sep));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('independent sockets and server restart restore specified profile; bare callsigns create new codes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-profile-net-')); let server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, profileDir: dir }); const clients = [];
  const connect = async () => { const c = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`); clients.push(c); return c; };
  try {
    const a = await connect(), first = await a.hello('博士#0001', undefined, { avatar }); assert.equal(first.doctorCode, '0001');
    assert.deepEqual(first.avatar, { kind: 'default' }, 'a new account never imports hello cache');
    await a.request({ t: 'profile.avatar', avatar });
    const b = await connect(), second = await b.hello('博士#0001', undefined, { avatar: { kind: 'default' } }); assert.deepEqual(second.avatar, avatar); assert.notEqual(first.playerId, second.playerId);
    const c = await connect(), distinct = await c.hello('博士#0002'); assert.deepEqual(distinct.avatar, { kind: 'default' });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await a.request({ t: 'profile.avatar', avatar: { kind: 'default' } });
    await Promise.all(clients.map((c) => c.close())); await server.close(); server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, profileDir: dir });
    const d = await connect(), fresh = await d.hello('博士#0001'); assert.equal(fresh.doctorCode, '0001'); assert.deepEqual(fresh.avatar, { kind: 'default' });
    const e = await connect(), random = await e.hello('博士'); assert.match(random.doctorCode, /^\d{4}$/); assert.ok(!['0001', '0002'].includes(random.doctorCode));
  } finally { await Promise.all(clients.map((c) => c.close())); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed profile persistence cannot overwrite the current avatar or create an unwelcomed session', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-profile-fail-')), profiles = new ProfileStore(dir);
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, profileStore: profiles }); const clients = [];
  try {
    profiles.resolve('博士', '0001', avatar);
    const a = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`); clients.push(a);
    const welcome = await a.hello('博士#0001', undefined, { avatar });
    const save = profiles.save; profiles.save = () => { throw new Error('disk unavailable'); };
    assert.equal((await a.request({ t: 'profile.avatar', avatar: { kind: 'default' } })).code, 'INTERNAL');
    assert.deepEqual(server.registry.byId(welcome.playerId).avatar, avatar); assert.deepEqual(profiles.read('博士', '0001').avatar, avatar);
    const b = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`); clients.push(b);
    assert.equal((await b.request({ t: 'hello', name: '博士#0002' })).code, 'INTERNAL'); assert.equal(server.registry.size, 1);
    profiles.save = save;
  } finally { await Promise.all(clients.map((c) => c.close())); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('changing only the code or only the callsign isolates avatars and histories on the same socket', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-profile-switch-'));
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, profileDir: dir });
  const client = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`);
  try {
    const a = server.lobby.profiles.resolve('博士', '0001', avatar).profile;
    server.lobby.profiles.remember(a, { id: 'match-a', key: 'key-a', startedAt: 42 }, 'p_a', { victory: true, players: [{ playerId: 'p_a', name: '博士' }] });
    let welcome = await client.hello('博士#0001'); assert.deepEqual(welcome.avatar, avatar); assert.deepEqual(welcome.history, []); assert.equal(server.lobby.profiles.read('博士', '0001').history[0].id, 'match-a');
    welcome = await client.hello('博士#0002', welcome.token, { avatar }); assert.deepEqual(welcome.avatar, { kind: 'default' }); assert.deepEqual(welcome.history, []);
    const different = { kind: 'operator', charId: 'char_003_kalts', e2: false }; await client.request({ t: 'profile.avatar', avatar: different });
    welcome = await client.hello('其他博士#0002', welcome.token, { avatar: different }); assert.deepEqual(welcome.avatar, { kind: 'default' }); assert.deepEqual(welcome.history, []);
    welcome = await client.hello('博士#0002', welcome.token); assert.deepEqual(welcome.avatar, different); assert.deepEqual(welcome.history, []);
    welcome = await client.hello('博士#0001', welcome.token); assert.deepEqual(welcome.avatar, avatar); assert.deepEqual(welcome.history, []); assert.equal(server.lobby.profiles.read('博士', '0001').history[0].id, 'match-a');
  } finally { await client.close(); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unfinished match tickets persist once and are upgraded by the final result', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-profile-pending-'));
  try {
    const s = new ProfileStore(dir); let p = s.resolve('博士', '0001', avatar).profile;
    const ticket = { id: 'game', key: 'key', startedAt: 42 }, pub = { t: 'm.public', players: [{ playerId: 'p', name: '博士' }] };
    p = s.remember(p, ticket, 'p', pub); assert.equal(p.history[0].ended, false);
    p = s.remember(p, ticket, 'p', { ...pub, round: 2 }); assert.equal(p.history.length, 1);
    p = s.remember(p, { ...ticket, expiresAt: 999 }, 'p', { ...pub, t: 'm.result', victory: true, roundsPassed: 14 }); assert.equal(p.history[0].ended, true); assert.equal(p.history[0].expiresAt, 999);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cross-device running-game recovery requires online owner consent, rejects spoofing, and restores offline seats', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-profile-transfer-'));
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, profileDir: dir, MatchClass: StubMatch, profileTransferCooldownMs: 0 });
  const clients = [];
  const connect = async () => { const c = await TestClient.connect(`${server.url.replace('http:', 'ws:')}/ws`); clients.push(c); return c; };
  try {
    const old = await connect(), original = await old.hello('博士#0001');
    await old.request({ t: 'profile.avatar', avatar });
    await old.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
    const room = await old.waitFor('room.state'); await old.request({ t: 'room.start' }); await old.waitFor('m.private');
    const next = await connect(), rid = next.send({ t: 'hello', name: '博士#0001', version: 1 });
    const pending = await next.waitFor('profile.transferPending'), prompt = await old.waitFor('profile.transferRequest');
    assert.equal(pending.requestId, prompt.requestId); assert.equal(old.isOpen, true);
    assert.equal(server.registry.size, 1, 'waiting requester gets no game identity');
    assert.equal((await next.request({ t: 'g.refresh' })).code, 'BAD_MSG');
    assert.equal((await next.request({ t: 'profile.transferResponse', requestId: prompt.requestId, accept: true })).code, 'BAD_TARGET');
    await next.expectNone('m.private');
    assert.equal((await old.request({ t: 'profile.transferResponse', requestId: prompt.requestId, accept: false })).t, 'ok');
    assert.equal((await next.waitFor('error', (m) => m.rid === rid)).code, 'PROFILE_DENIED');
    assert.equal(old.isOpen, true); assert.equal(server.network.profileTransfers.size, 0);
    // The existing reconnect token must not bypass an online-window consent check either.
    const tokenRid = next.send({ t: 'hello', name: '博士#0001', token: original.token });
    const again = await old.waitFor('profile.transferRequest'); await next.waitFor('profile.transferPending');
    assert.equal((await old.request({ t: 'profile.transferResponse', requestId: again.requestId, accept: true })).t, 'ok');
    const welcome = await next.waitFor('welcome', (m) => m.rid === tokenRid);
    assert.equal(welcome.playerId, original.playerId); assert.equal(welcome.resumed, true); assert.deepEqual(welcome.avatar, avatar);
    assert.equal((await old.closed).code, 4001);
    const restored = await next.waitFor('room.state'); assert.equal(restored.code, room.code); assert.equal(restored.inMatch, true);
    assert.equal((await next.waitFor('m.private')).playerId, original.playerId); assert.equal(server.registry.size, 1);
    // Wrong code or name is an independent profile, even during the original account's game.
    const different = await connect(), differentWelcome = await different.hello('博士#0002'); assert.notEqual(differentWelcome.playerId, original.playerId);
    const renamed = await connect(), renamedWelcome = await renamed.hello('其他博士#0001'); assert.notEqual(renamedWelcome.playerId, original.playerId);
    await next.terminate();
    const offline = await connect(), offlineWelcome = await offline.hello('博士#0001');
    assert.equal(offlineWelcome.playerId, original.playerId); assert.equal(offlineWelcome.resumed, true);
    assert.equal((await offline.waitFor('m.private')).playerId, original.playerId);
    await offline.request({ t: 'g.leave' });
    const afterLeave = await connect(), newWelcome = await afterLeave.hello('博士#0001'); assert.notEqual(newWelcome.playerId, original.playerId);
    assert.ok(validateC2S({ t: 'profile.transferResponse', requestId: 'fake', accept: true }));
    assert.ok(validateC2S({ t: 'profile.transferResponse', requestId: 'a'.repeat(32), accept: 'yes' }));
  } finally { await Promise.all(clients.map((c) => c.close())); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pending account transfers expire, cancel on disconnect and throttle repeated prompts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-profile-transfer-timeout-'));
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, profileDir: dir, MatchClass: StubMatch, profileTransferWaitMs: 120 });
  const clients = [];
  const connect = async () => { const c = await TestClient.connect(`${server.url.replace('http:', 'ws:')}/ws`); clients.push(c); return c; };
  try {
    const old = await connect(); await old.hello('博士#0001'); await old.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' }); await old.request({ t: 'room.start' });
    const next = await connect(), rid = next.send({ t: 'hello', name: '博士#0001' });
    await next.waitFor('profile.transferPending'); const prompt = await old.waitFor('profile.transferRequest');
    const competitor = await connect(); assert.equal((await competitor.request({ t: 'hello', name: '博士#0001' })).code, 'PROFILE_BUSY');
    assert.equal((await next.waitFor('error', (m) => m.rid === rid)).code, 'PROFILE_TIMEOUT');
    assert.equal((await old.request({ t: 'profile.transferResponse', requestId: prompt.requestId, accept: true })).code, 'BAD_TARGET');
    assert.equal(old.isOpen, true); assert.equal(server.network.profileTransfers.size, 0);
    assert.equal((await next.request({ t: 'hello', name: '博士#0001' })).code, 'PROFILE_BUSY');
    server.network.opts.profileTransferCooldownMs = 0; server.network.opts.profileTransferWaitMs = 2000;
    const cancelRid = next.send({ t: 'hello', name: '博士#0001' }); const canceled = await next.waitFor('profile.transferPending');
    await next.request({ t: 'profile.transferCancel', requestId: canceled.requestId });
    assert.equal((await next.waitFor('error', (m) => m.rid === cancelRid)).code, 'PROFILE_CANCELED');
    next.send({ t: 'hello', name: '博士#0001' }); const dropped = await next.waitFor('profile.transferPending'); await next.terminate();
    await old.waitFor('profile.transferEnded', (m) => m.requestId === dropped.requestId);
    assert.equal(server.network.profileTransfers.size, 0); assert.equal(old.isOpen, true);
  } finally { await Promise.all(clients.map((c) => c.close())); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
