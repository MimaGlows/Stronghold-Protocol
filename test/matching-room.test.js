import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { DEFAULT_AVATAR, MATCHING_AVATAR } from '../shared/avatar.js';
import { loadData } from '../server/data.js';
import { GameData } from '../server/match/gamedata.js';
import { drawDisabledBonds } from '../server/match/pool.js';
import { createRng } from '../server/sim/rng.js';
import { compactRecord, normalizeRecord } from '../shared/stats.js';

class CapturedMatch extends StubMatch {
  constructor(options) { super(options); this.options = options; }
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-room-upgrade-'));
  const server = await startServer({ port: 0, quiet: true, profileDir: path.join(dir, 'profiles'), matchmakingDir: path.join(dir, 'matching'), MatchClass: CapturedMatch });
  const clients = [];
  t.after(async () => { await Promise.all(clients.map((c) => c.terminate())); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const player = async (name) => { const c = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`); const welcome = await c.hello(name); c.id = welcome.playerId; clients.push(c); return c; };
  const session = (c) => server.registry.byId(c.id);
  const roomOf = (c) => server.lobby.roomOf(session(c));
  const request = async (c, fields) => { const result = await c.request(fields); assert.equal(result.t, 'ok', JSON.stringify(result)); return result; };
  const enable = (c, bond = null) => request(c, { t: 'matching.setEnabled', on: true, bond, revision: roomOf(c).matchingRevision });
  const disable = (c) => request(c, { t: 'matching.setEnabled', on: false, revision: roomOf(c).matchingRevision });
  const prepare = (c, bond = null) => request(c, { t: 'matching.roomPrepare', bond, revision: roomOf(c).matchingRevision });
  return { ...server, player, session, roomOf, request, enable, disable, prepare };
}

test('backfill atomically revokes public access, kicks rejected names, resets ready and restores a fresh ordinary room', async (t) => {
  const f = await fixture(t), h = await f.player('房主#0001'), guest = await f.player('队员#0002'), rejected = await f.player('习近平#0003'), outsider = await f.player('其他博士#0004');
  await f.request(h, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  const room = f.roomOf(h), original = room.shareCode;
  await f.request(guest, { t: 'room.join', code: original }); await f.request(rejected, { t: 'room.join', code: original });
  await f.request(guest, { t: 'room.ready', ready: true });
  const custom = { kind: 'custom', dataUrl: 'test-original' };
  room.seatOf(guest.id).avatar = custom; f.session(guest).avatar = custom;
  await f.enable(h, 'yanShip');
  assert.equal(room.shareCode, null); assert.equal(room.code, original);
  assert.equal(room.seatOf(guest.id).ready, false); assert.equal(room.seatOf(h.id).preferenceSelected, true);
  assert.equal(f.roomOf(rejected), null); assert.equal((await rejected.waitFor('room.closed')).reason, 'matching-name');
  assert.equal((await outsider.request({ t: 'room.join', code: original })).code, 'ROOM_NOT_FOUND');
  assert.equal((await outsider.request({ t: 'room.spectate', code: original })).code, 'ROOM_NOT_FOUND');
  const state = room.toState(); assert.equal(state.seats[0].doctorCode, undefined); assert.deepEqual(state.seats[1].avatar, MATCHING_AVATAR);
  assert.equal((await guest.request({ t: 'room.ready', ready: true })).code, 'MATCH_PREFERENCE');
  assert.equal((await h.request({ t: 'room.start' })).code, 'NOT_READY');
  await f.prepare(guest, null); assert.equal(room.seatOf(guest.id).preferenceSelected, true);
  room.seatOf(guest.id).matchingSource = true;
  await f.disable(h);
  assert.equal(room.matchmaking, false); assert.equal(room.toState().matching.rules, false); assert.equal(room.activeHumans().length, 2);
  assert.notEqual(room.shareCode, original); assert.equal(room.seatOf(guest.id).matchingSource, false);
  assert.equal(room.seatOf(guest.id).preferenceSelected, false); assert.equal(room.seatOf(h.id).ready, false);
  assert.equal(room.toState().seats[1].doctorCode, '0002'); assert.equal(room.toState().seats[1].avatar, custom);
  assert.equal((await outsider.request({ t: 'room.join', code: original })).code, 'ROOM_NOT_FOUND');
  await f.request(outsider, { t: 'room.join', code: room.shareCode });
  await f.request(h, { t: 'room.addBot' });
});

test('rejected host and stale operations leave room sharing, members and ready states unchanged', async (t) => {
  const f = await fixture(t), rejected = await f.player('习近平#0001');
  await f.request(rejected, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  const room = f.roomOf(rejected), code = room.shareCode, revision = room.matchingRevision;
  assert.equal((await rejected.request({ t: 'matching.setEnabled', on: true, bond: null, revision })).code, 'MATCH_NAME');
  assert.equal(room.shareCode, code); assert.equal(room.matchmaking, false); assert.equal(room.matchingRevision, revision);
  const host = await f.player('合格房主#0002');
  await f.request(host, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' }); const valid = f.roomOf(host);
  assert.equal((await host.request({ t: 'matching.setEnabled', on: true, bond: 'yanShip', revision: valid.matchingRevision - 1 })).code, 'MATCH_STALE');
  assert.equal(valid.matchmaking, false); await f.enable(host);
  const old = valid.matchingRevision; await f.disable(host); await f.enable(host, 'yanShip');
  assert.equal((await host.request({ t: 'matching.roomPrepare', bond: 'sargonShip', revision: old })).code, 'MATCH_STALE');
  assert.equal(valid.seatOf(host.id).preference, 'yanShip');
});

test('friends join without public codes, select before readying, and start a weighted matching match with the actual host', async (t) => {
  const f = await fixture(t), h = await f.player('原房主#0001'), guest = await f.player('新房主#0002'), friend = await f.player('好友#0003');
  await f.request(h, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' }); const room = f.roomOf(h);
  await f.request(guest, { t: 'room.join', code: room.shareCode });
  await f.request(friend, { t: 'social.add', identity: '原房主#0001' });
  await f.enable(h, 'yanShip'); await f.request(friend, { t: 'social.join', identity: '原房主#0001' });
  assert.equal(room.seatOf(friend.id).ready, false); await f.prepare(friend, 'yanShip'); await f.prepare(guest, 'sargonShip');
  await f.request(h, { t: 'room.leave' }); assert.equal(room.hostId, guest.id);
  await f.request(guest, { t: 'room.start' });
  assert.deepEqual(room.match.options.matchingBondWeights, { yanShip: 2, sargonShip: 1 });
  assert.equal(room.match.options.isMatchingMatch, true); assert.equal(room.matchCtx.matching.generated, false);
  const before = structuredClone(f.session(guest).profile.socialRecentMatches);
  f.lobby.social.remember(room.matchCtx, { reason: 'victory' });
  assert.deepEqual(f.session(guest).profile.socialRecentMatches, before);
  assert.equal((await guest.request({ t: 'matching.setEnabled', on: false, revision: room.matchingRevision })).code, 'MATCH_LOCKED');
});

test('friend invitation acceptance rechecks name restrictions and succeeds with a revoked public share', async (t) => {
  const f = await fixture(t), h = await f.player('邀请房主#0001'), friend = await f.player('受邀好友#0002');
  await f.request(h, { t: 'social.add', identity: '受邀好友#0002' });
  await f.request(h, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' }); await f.enable(h);
  await f.request(h, { t: 'social.invite', identity: '受邀好友#0002' });
  const invite = await friend.waitFor('social.invite'); await f.request(friend, { t: 'social.inviteRespond', inviteId: invite.inviteId, accept: true });
  assert.equal(f.roomOf(friend), f.roomOf(h)); assert.equal(f.roomOf(friend).shareCode, null);
});

test('weighted bans reproduce seeds, retain counts and favour host then other preferences without guaranteeing either', () => {
  const gd = new GameData(loadData(), 'mode_multi_normal'), weights = { yanShip: 1, sargonShip: 2 };
  const bans = [0, 0, 0];
  for (let seed = 1; seed <= 10000; seed++) {
    const a = drawDisabledBonds(gd, createRng(seed), [], weights), b = drawDisabledBonds(gd, createRng(seed), [], weights);
    assert.deepEqual(a, b); assert.equal(a.drawn.filter((id) => gd.bond(id).isCore).length, 3);
    for (const [i, id] of ['yanShip', 'sargonShip', 'victoriaShip'].entries()) if (a.drawn.includes(id)) bans[i]++;
  }
  assert.ok(bans[0] > 0 && bans[0] < bans[1] && bans[1] < bans[2], JSON.stringify(bans));
});

test('matching history flags survive normalization and list compaction', () => {
  const r = normalizeRecord({ isMatchingMatch: true, players: [{ playerId: 'a', name: 'A', stats: {} }], selfId: 'a' });
  assert.equal(r.isMatchingMatch, true); assert.equal(compactRecord(r).isMatchingMatch, true);
  assert.equal(DEFAULT_AVATAR.kind, 'default');
});
