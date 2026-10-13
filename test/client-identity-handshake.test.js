// Real browser Net + identity helper against the custom server's account-consent handshake.
// This fork restores running games by callsign#code, not the upstream browser-local match catalogue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createIdentity, Net } from '../public/js/net.js';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { validateC2S } from '../shared/protocol.js';
import { TestClient } from './helpers/wsClient.js';

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}

async function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-client-handshake-')), clients = [];
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch,
    profileDir: path.join(dir, 'profiles'), replayDir: path.join(dir, 'replays'),
    matchmakingDir: path.join(dir, 'matching'), profileTransferCooldownMs: 0 });
  t.after(async () => {
    for (const client of clients) client.net.close();
    await Promise.all(clients.map(client => client.wire.closed));
    await server.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('sp-client-handshake-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function client(token) {
    const session = storage(), identity = createIdentity({ local: storage(), session, channel: null });
    await identity.init();
    if (token) identity.saveToken(token);
    const net = new Net({ url: `ws://127.0.0.1:${server.port}/ws`, WebSocket, getToken: () => identity.getToken() });
    net.on('welcome', message => identity.saveToken(message.token));
    net.setName('博士#0001');
    const result = { net, identity, session, wire: new TestClient(net.ws) };
    clients.push(result);
    return result;
  }
  const owner = await client(), welcome = await owner.wire.waitFor('welcome');
  await owner.net.request('room.create', { mode: 'solo', difficulty: 'NORMAL' });
  await owner.net.request('room.start');
  await owner.wire.waitFor('m.private');
  const room = server.lobby.roomOf(server.registry.byId(welcome.playerId));
  return { server, client, owner, welcome, room, ownerSocket: server.registry.byId(welcome.playerId).ws };
}

for (const withToken of [false, true]) {
  test(`running account recovery ${withToken ? 'with the reconnect token' : 'without a token'} waits for owner consent before welcome and queued actions`, async t => {
    const h = await harness(t), next = await h.client(withToken ? h.welcome.token : undefined);
    const pending = await next.wire.waitFor('profile.transferPending');
    const prompt = await h.owner.wire.waitFor('profile.transferRequest');
    assert.equal(pending.requestId, prompt.requestId);
    assert.equal(next.net.status, 'handshaking');
    assert.equal(next.net.playerId, null);
    assert.equal(next.identity.getToken(), withToken ? h.welcome.token : null);
    assert.equal(h.owner.net.status, 'online');
    assert.equal(h.server.registry.size, 1);
    assert.ok(!next.wire.log.some(message => ['welcome', 'room.state', 'm.private'].includes(message.t)));

    const queued = next.net.request('g.refresh');
    queued.catch(() => {}); // Still await the outcome below; keep cleanup safe if an earlier assertion fails.
    assert.equal(next.net.pendingCount, 1);
    await h.owner.net.request('profile.transferResponse', { requestId: prompt.requestId, accept: true });
    const welcome = await next.wire.waitFor('welcome');
    assert.equal(welcome.playerId, h.welcome.playerId);
    assert.equal(welcome.resumed, true);
    assert.equal(next.net.status, 'online');
    assert.equal(next.identity.getToken(), h.welcome.token);
    assert.equal(next.session.getItem('sp.token'), h.welcome.token);
    assert.equal((await queued).t, 'ok');
    assert.equal((await next.wire.waitFor('m.private')).playerId, h.welcome.playerId);
    assert.equal((await h.owner.wire.closed).code, 4001);
    assert.equal(h.owner.net.status, 'closed');
    assert.equal(h.owner.net.lastError.code, 'REPLACED');
    assert.equal(h.server.lobby.roomOf(h.server.registry.byId(welcome.playerId)), h.room);
    assert.equal(h.server.network.profileTransfers.size, 0);
  });
}

test('owner refusal preserves the running game and rejects the requester queue without saving a token', async t => {
  const h = await harness(t), next = await h.client();
  await next.wire.waitFor('profile.transferPending');
  const prompt = await h.owner.wire.waitFor('profile.transferRequest');
  const rejected = assert.rejects(next.net.request('g.refresh'), error => error.code === 'OFFLINE');
  await h.owner.net.request('profile.transferResponse', { requestId: prompt.requestId, accept: false });
  assert.equal((await next.wire.waitFor('error')).code, 'PROFILE_DENIED');
  await rejected;
  assert.equal(next.net.status, 'connected');
  assert.equal(next.net.lastError.code, 'PROFILE_DENIED');
  assert.equal(next.net.playerId, null);
  assert.equal(next.session.getItem('sp.token'), null);
  assert.ok(!next.wire.log.some(message => ['welcome', 'm.private'].includes(message.t)));
  assert.equal(h.owner.net.status, 'online');
  assert.equal(h.server.registry.byId(h.welcome.playerId).ws, h.ownerSocket);
  assert.equal((await h.owner.net.request('ping', { c: 42 })).t, 'pong');
  assert.equal(h.server.network.profileTransfers.size, 0);
});

test('a complete account identity restores an offline game and saves the server reconnect token', async t => {
  const h = await harness(t);
  h.owner.net.close();
  await h.owner.wire.closed;
  const next = await h.client(), welcome = await next.wire.waitFor('welcome');
  assert.equal(welcome.playerId, h.welcome.playerId);
  assert.equal(welcome.resumed, true);
  assert.equal(next.net.status, 'online');
  assert.equal(next.net.helloName, '博士#0001');
  assert.equal(next.identity.getToken(), h.welcome.token);
  assert.equal(next.session.getItem('sp.token'), h.welcome.token);
  assert.equal((await next.wire.waitFor('room.state')).code, h.room.code);
  assert.equal((await next.wire.waitFor('m.private')).playerId, h.welcome.playerId);
  assert.ok(!next.wire.log.some(message => message.t === 'profile.transferPending'));
});

test('closing a pending requester cancels consent and ignores late welcome before listeners or queued actions', async t => {
  const h = await harness(t), next = await h.client();
  await next.wire.waitFor('profile.transferPending');
  const prompt = await h.owner.wire.waitFor('profile.transferRequest');
  const staleMessageHandler = next.net.ws.onmessage, received = [];
  next.net.on('*', message => received.push(message));
  const rejected = assert.rejects(next.net.request('g.refresh'), error => error.code === 'CLOSED');
  next.net.close();
  await next.wire.closed;
  await rejected;
  await h.owner.wire.waitFor('profile.transferEnded', message => message.requestId === prompt.requestId);
  staleMessageHandler({ data: JSON.stringify(h.welcome) });
  assert.equal(next.net.status, 'closed');
  assert.equal(next.net.playerId, null);
  assert.equal(next.identity.getToken(), null);
  assert.equal(next.net.pendingCount, 0);
  assert.deepEqual(received, []);
  assert.equal(h.owner.net.status, 'online');
  assert.equal(h.server.network.profileTransfers.size, 0);
  await assert.rejects(h.owner.net.request('profile.transferResponse', { requestId: prompt.requestId, accept: true }), error => error.code === 'BAD_TARGET');
});

test('account hello and explicit transfer fields validate their actual protocol types', () => {
  const hello = { t: 'hello', name: '博士#0001' };
  for (const fields of [{}, { token: 'seat', version: 1 }, { avatar: { kind: 'default' } }, { avatar: { kind: 'operator', charId: 'char_010_chen', e2: true } }]) {
    assert.equal(validateC2S({ ...hello, ...fields }), null);
  }
  for (const fields of [{ name: ' ' }, { token: {} }, { token: 'x'.repeat(65) }, { version: -1 }, { version: Infinity }, { avatar: { kind: 'invalid' } }]) {
    assert.equal(typeof validateC2S({ ...hello, ...fields }), 'string');
  }
  const transfer = { t: 'profile.transferResponse', requestId: 'a'.repeat(32), accept: true };
  assert.equal(validateC2S(transfer), null);
  assert.equal(validateC2S({ ...transfer, accept: false }), null);
  for (const fields of [{ requestId: 'fake' }, { accept: 'yes' }, { accept: undefined }]) {
    assert.equal(typeof validateC2S({ ...transfer, ...fields }), 'string');
  }
});
