import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_AVATAR, AVATAR_MAX_BYTES, avatarBytes, webpDimensions, isAvatarChoice, checkAvatarChoice } from '../shared/avatar.js';
import { validateC2S } from '../shared/protocol.js';
import { cropRect } from '../public/js/ui/avatarImage.js';
import { loadAvatar, loadProfileAvatar, persistAvatar, persistProfileAvatar, AVATAR_PREF, installAvatarSync } from '../public/js/ui/avatarProfile.js';
import { createStore } from '../public/js/store.js';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';

const first = { kind: 'operator', charId: 'char_010_chen', e2: false };
const second = { kind: 'operator', charId: 'char_003_kalts', e2: false };
const manifest = { chars: { [first.charId]: { avatar: '/a.png' }, [second.charId]: { avatar: '/b.png' } } };
function cookieJar() {
  const values = new Map(), writes = [];
  return {
    values, writes,
    get cookie() { return [...values].map(([k, v]) => `${k}=${v}`).join('; '); },
    set cookie(raw) {
      writes.push(raw);
      const [pair] = raw.split(';'), index = pair.indexOf('='), key = pair.slice(0, index);
      if (raw.includes('Max-Age=0;')) values.delete(key); else values.set(key, pair.slice(index + 1));
    },
  };
}
function maximumAvatar() {
  // Structurally valid static WebP with a maximum-sized optional chunk exercises the wire/storage cap.
  const b = Buffer.alloc(AVATAR_MAX_BYTES);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WEBP', 8);
  b.write('VP8L', 12); b.writeUInt32LE(5, 16);
  b.set([0x2f, 0xff, 0xc0, 0x3f, 0], 20);
  b.write('JUNK', 26); b.writeUInt32LE(b.length - 34, 30);
  return { kind: 'custom', dataUrl: 'data:image/webp;base64,' + b.toString('base64') };
}

test('avatar protocol: legacy hello, bounded choices and operator semantic checks', () => {
  assert.equal(validateC2S({ t: 'hello', name: '博士' }), null);
  assert.equal(validateC2S({ t: 'hello', name: '博士', avatar: first }), null);
  assert.equal(validateC2S({ t: 'profile.avatar', avatar: DEFAULT_AVATAR }), null);
  assert.ok(validateC2S({ t: 'profile.avatar', avatar: { kind: 'custom', dataUrl: 'data:image/svg+xml,<svg/>' } }));
  for (const value of [null, {}, { kind: 'operator', charId: '__proto__', e2: false }, { ...first, playerId: 'victim' }]) assert.equal(isAvatarChoice(value), false);
  assert.equal(checkAvatarChoice(first, manifest).ok, true);
  assert.equal(checkAvatarChoice({ ...first, e2: true }, manifest).error, 'BAD_TARGET');
  assert.equal(checkAvatarChoice({ ...first, charId: 'char_999_nope' }, manifest).error, 'BAD_TARGET');
  assert.equal(avatarBytes('data:image/webp;base64,' + 'A'.repeat(AVATAR_MAX_BYTES * 2)), null);
  assert.equal(avatarBytes('data:image/webp;base64,@@@@'), null);
  assert.equal(webpDimensions(new Uint8Array(40)), null);
});

test('cookie persistence: reload, blocked/partial writes, corruption and old-part cleanup', () => {
  const jar = cookieJar();
  assert.deepEqual(loadAvatar(jar), DEFAULT_AVATAR);
  persistAvatar(first, { cookieDocument: jar });
  assert.deepEqual(loadAvatar(jar), first);
  assert.ok(jar.writes.every((s) => s.includes('Path=/; Max-Age=31536000; SameSite=Lax')));
  const before = jar.cookie;
  const blocked = { get cookie() { return jar.cookie; }, set cookie(_) { /* silently blocked by browser */ } };
  assert.throws(() => persistAvatar(second, { cookieDocument: blocked }), /Cookie/);
  assert.equal(jar.cookie, before);
  const custom = maximumAvatar(); assert.equal(isAvatarChoice(custom), true);
  let n = 0;
  const partial = { get cookie() { return jar.cookie; }, set cookie(value) { if (++n === 2) throw new Error('partial'); jar.cookie = value; } };
  assert.throws(() => persistAvatar(custom, { cookieDocument: partial }), /partial/);
  assert.deepEqual(loadAvatar(jar), first);
  assert.equal(jar.values.size, 2, 'failed generation is cleaned up');
  persistAvatar(custom, { cookieDocument: jar });
  assert.deepEqual(loadAvatar(jar), custom);
  assert.equal(jar.values.size, 12, 'maximum avatar uses 11 parts plus the pointer');
  assert.ok(jar.writes.every((s) => s.length < 4096));
  persistAvatar(second, { cookieDocument: jar });
  assert.deepEqual(loadAvatar(jar), second);
  assert.equal(jar.values.size, 2, 'replacing an image removes its old parts');
  const meta = jar.values.get(AVATAR_PREF), [id] = meta.split('.');
  jar.values.delete(`${AVATAR_PREF}.${id}.0`); assert.deepEqual(loadAvatar(jar), DEFAULT_AVATAR);
  jar.values.set(AVATAR_PREF, 'bad.99999'); assert.deepEqual(loadAvatar(jar), DEFAULT_AVATAR);
  assert.deepEqual(loadAvatar({ get cookie() { throw new Error('private'); } }), DEFAULT_AVATAR);
});

test('maximum avatar cookies fit HTTP and WebSocket upgrades without changing the message cap', async () => {
  const jar = cookieJar(); persistAvatar(maximumAvatar(), { cookieDocument: jar });
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  try {
    const response = await fetch(`http://127.0.0.1:${srv.port}/healthz`, { headers: { Cookie: jar.cookie + '; ' + jar.cookie } });
    assert.equal(response.status, 200);
    const { default: WebSocket } = await import('ws');
    const socket = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { Cookie: jar.cookie } });
    try { await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }); }
    finally { socket.terminate(); }
  } finally { await srv.close(); }
});

test('partially blocked owner writes never label a new image as the previous account', () => {
  const jar = cookieJar(); persistProfileAvatar(first, '博士#0001', jar);
  const noOwnerDelete = { get cookie() { return jar.cookie; }, set cookie(raw) { if (!raw.startsWith('sp.avatar.owner=')) jar.cookie = raw; } };
  assert.throws(() => persistProfileAvatar(second, '博士#0002', noOwnerDelete));
  assert.deepEqual(loadProfileAvatar('博士#0001', jar), first);
  const noOwnerPublish = { get cookie() { return jar.cookie; }, set cookie(raw) { if (!raw.startsWith('sp.avatar.owner=') || raw.includes('Max-Age=0;')) jar.cookie = raw; } };
  assert.throws(() => persistProfileAvatar(second, '博士#0002', noOwnerPublish));
  assert.deepEqual(loadProfileAvatar('博士#0001', jar), DEFAULT_AVATAR);
  assert.deepEqual(loadProfileAvatar('博士#0002', jar), DEFAULT_AVATAR);
  persistProfileAvatar(second, '博士#0002', jar);
  assert.deepEqual(loadProfileAvatar('博士#0002', jar), second);
});

test('crop offsets clamp to the image and preserve a square at every zoom', () => {
  for (const [width, height] of [[480, 320], [320, 480], [256, 256]]) {
    for (const zoom of [1, 2, 4]) {
      const r = cropRect(width, height, zoom, 10000, -10000);
      assert.ok(r.sx >= -1e-9 && r.sy >= -1e-9);
      assert.ok(r.sx + r.size <= width + 1e-9 && r.sy + r.size <= height + 1e-9);
    }
  }
});

test('sync keeps the latest edit when hello/replies race and retries at the next welcome', async () => {
  const events = new Map(), calls = [], notices = [];
  const target = createStore({ avatar: first, sync: 'idle' });
  const net = { status: 'online', getAvatar: null,
    on(type, fn) { events.set(type, fn); return () => events.delete(type); },
    request(type, fields) { return new Promise((resolve, reject) => calls.push({ type, fields, resolve, reject })); } };
  const dispose = installAvatarSync({ net, target, notify: (s) => notices.push(s) });
  try {
    events.get('welcome')({ avatar: first }); assert.equal(target.get().sync, 'synced');
    target.set({ avatar: second });
    target.set({ avatar: DEFAULT_AVATAR });
    calls[0].resolve(); await delay(0);
    assert.equal(target.get().sync, 'sending');
    calls[1].reject({ code: 'DISCONNECTED' }); await delay(0);
    assert.equal(target.get().sync, 'error'); assert.equal(notices.length, 1);
    assert.deepEqual(net.getAvatar(), DEFAULT_AVATAR);
    events.get('welcome')({ avatar: second });
    calls[2].resolve(); await delay(0); assert.equal(target.get().sync, 'synced');
  } finally { dispose(); }
});

test('real sockets: same-name players, live changes, bot, reconnect, legacy hello and match isolation', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch });
  const clients = [];
  const connect = async () => { const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`); clients.push(c); return c; };
  try {
    const a = await connect(), b = await connect();
    const wa = await a.hello('同名博士', undefined, { avatar: first });
    const wb = await b.hello('同名博士', undefined, { avatar: second });
    assert.deepEqual(wa.avatar, first); assert.deepEqual(wb.avatar, second); assert.notEqual(wa.playerId, wb.playerId);
    assert.equal((await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
    const room = await a.waitFor('room.state');
    assert.equal((await b.request({ t: 'room.join', code: room.code })).t, 'ok');
    await a.waitFor('room.state', (s) => s.seats[1]);
    const initial = await b.waitFor('room.state');
    assert.deepEqual(initial.seats.map((s) => s?.avatar || null), [first, second, null, null]);
    assert.equal((await a.request({ t: 'profile.avatar', avatar: DEFAULT_AVATAR, playerId: wb.playerId })).t, 'ok');
    const updated = await b.waitFor('room.state', (s) => s.seats[0]?.avatar.kind === 'default');
    assert.deepEqual(updated.seats[1].avatar, second, 'target fields cannot modify another player');
    assert.equal((await a.request({ t: 'profile.avatar', avatar: { ...first, charId: 'char_999_unknown' } })).code, 'BAD_TARGET');
    assert.equal((await a.request({ t: 'room.addBot' })).t, 'ok');
    const bot = await b.waitFor('room.state', (s) => s.seats[2]?.isBot);
    assert.deepEqual(bot.seats[2].avatar, DEFAULT_AVATAR);
    await b.close();
    const resumed = await connect();
    const wr = await resumed.hello('新代号', wb.token);
    assert.equal(wr.playerId, wb.playerId); assert.deepEqual(wr.avatar, second, 'legacy hello preserves session avatar');
    const restored = await resumed.waitFor('room.state');
    assert.equal(restored.seats[1].name, '新代号'); assert.deepEqual(restored.seats[1].avatar, second);
    await resumed.request({ t: 'room.ready', ready: true });
    assert.equal((await a.request({ t: 'room.start' })).t, 'ok');
    const publicState = await a.waitFor('m.public');
    assert.equal(JSON.stringify(publicState).includes('"avatar"'), false, 'images never enter match state');
  } finally { await Promise.all(clients.map((c) => c.close())); await srv.close(); }
});

test('specified server profile replaces stale avatar cookies without sending a local overwrite', () => {
  const handlers = new Map(), requests = [], target = createStore({ avatar: first, sync: 'idle' });
  const net = { status: 'online', on(type, fn) { handlers.set(type, fn); return () => handlers.delete(type); }, request(...args) { requests.push(args); return Promise.resolve(); } };
  const dispose = installAvatarSync({ net, target, notify() {} });
  try { handlers.get('welcome')({ name: '博士', doctorCode: '0001', profileRestored: true, avatar: second }); assert.deepEqual(target.get().avatar, second); assert.deepEqual(requests, []); assert.deepEqual(net.getAvatar(), second); }
  finally { dispose(); }
});

test('avatar caches require a complete matching account and a switched profile cancels old edit retries', async () => {
  const jar = cookieJar(); persistAvatar(first, { cookieDocument: jar });
  jar.cookie = `sp.avatar.owner=${encodeURIComponent('博士#0001')}; Path=/; Max-Age=31536000; SameSite=Lax`;
  assert.deepEqual(loadProfileAvatar('博士#0001', jar), first);
  for (const name of ['博士#0002', '其他博士#0001', '博士', null]) assert.deepEqual(loadProfileAvatar(name, jar), DEFAULT_AVATAR);
  const events = new Map(), requests = [], target = createStore({ avatar: first, profileKey: '博士#0001', sync: 'idle' });
  const net = { status: 'online', on(type, fn) { events.set(type, fn); return () => events.delete(type); }, request(...args) { return new Promise((resolve, reject) => requests.push({ args, resolve, reject })); } };
  const dispose = installAvatarSync({ net, target, notify() {} });
  try {
    events.get('welcome')({ name: '博士', doctorCode: '0001', avatar: first }); target.set({ avatar: second });
    assert.equal(requests.length, 1); events.get('profileChanging')({ name: '博士#0002' });
    assert.deepEqual(target.get().avatar, DEFAULT_AVATAR); assert.equal(target.get().profileKey, '博士#0002');
    requests[0].reject({ code: 'RATE' }); await delay(0); assert.equal(target.get().sync, 'idle');
    events.get('welcome')({ name: '博士', doctorCode: '0002', avatar: DEFAULT_AVATAR }); assert.equal(requests.length, 1);
    events.get('profileChanging')({ name: '博士#0001' }); events.get('welcome')({ name: '博士', doctorCode: '0001', avatar: first }); assert.deepEqual(target.get().avatar, first);
  } finally { dispose(); }
});
