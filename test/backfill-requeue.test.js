import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { MATCHING_AVATAR } from '../shared/avatar.js';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-backfill-requeue-'));
  let now = Date.now(), seed = 100;
  const f = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch,
    profileDir: path.join(dir, 'profiles'), matchmakingDir: path.join(dir, 'matching'), seedFn: () => ++seed });
  f.lobby.now = () => now;
  const clients = [];
  t.after(async () => { await Promise.all(clients.map(c => c.terminate())); await f.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const player = async (name, token) => { const c = await TestClient.connect(`ws://127.0.0.1:${f.port}/ws`); clients.push(c); c.welcome = await c.hello(name, token); c.id = c.welcome.playerId; return c; };
  const session = c => f.registry.byId(c.id), roomOf = c => f.lobby.roomOf(session(c)), service = f.lobby.matchmakingService;
  const party = c => service.parties.of(session(c)), identity = c => service.identity(session(c));
  const request = async (c, fields) => { const result = await c.request(fields); assert.equal(result.t, 'ok', JSON.stringify(result)); return result; };
  const create = async (c, difficulty = 'NORMAL') => { await request(c, { t: 'room.create', mode: 'coop', difficulty }); return roomOf(c); };
  const enable = (c, bond = 'yanShip') => request(c, { t: 'matching.setEnabled', on: true, bond, revision: roomOf(c).matchingRevision });
  const disable = c => request(c, { t: 'matching.setEnabled', on: false, revision: roomOf(c).matchingRevision });
  const prepare = (c, difficulty = 'NORMAL', bond = 'sargonShip') => request(c, { t: 'matching.prepare', difficulty, bond, partyId: party(c)?.id || null, revision: party(c)?.revision || 0 });
  const group = async (people, difficulty = 'NORMAL') => {
    const [leader, ...members] = people;
    for (const member of members) {
      await request(leader, { t: 'social.add', identity: identity(member) });
      await request(leader, { t: 'matching.invite', identity: identity(member), difficulty });
      const invite = [...service.parties.invites.values()].find(i => i.to === identity(member));
      await request(member, { t: 'matching.inviteRespond', inviteId: invite.id, accept: true });
    }
    for (const member of people) await prepare(member, difficulty);
    return party(leader);
  };
  const fill = ms => { now += ms ?? 60001; service.parties.pump(); };
  return { ...f, service, player, session, roomOf, party, identity, request, create, enable, disable, prepare, group, fill,
    advance: ms => { now += ms; }, now: () => now, seed: () => seed };
}

for (const difficulty of ['FUNNY', 'NORMAL', 'HARD', 'ABYSS']) for (const count of [1, 2, 3]) {
  test(`${difficulty}: disabling backfill removes ${count} genuine queue members and automatically resumes their searches`, async t => {
    const f = await fixture(t), host = await f.player('房主#0001'), guests = [];
    for (let i = 0; i < count; i++) guests.push(await f.player(`博士${['甲', '乙', '丙'][i]}#000${i + 2}`));
    const room = await f.create(host, difficulty), firstCode = room.shareCode; await f.enable(host);
    const old = [];
    for (const c of guests) { await f.prepare(c, difficulty); old.push({ id: f.party(c).id, seed: f.party(c).attempt.seed }); }
    f.fill();
    for (const c of guests) { assert.equal(f.roomOf(c), room); assert.equal(room.seatOf(c.id).matchingSource, true); assert.equal(f.party(c), null); }
    const clockBeforeRoomWait = f.now(); f.advance(180000); host.clearInbox(); guests.forEach(c => c.clearInbox());
    await f.disable(host);
    assert.deepEqual(room.activeHumans().map(s => s.playerId), [host.id]); assert.equal(room.matchmaking, false);
    assert.ok(room.shareCode); assert.notEqual(room.shareCode, firstCode); assert.ok(!f.lobby.publicRoom(firstCode));
    for (const [i, c] of guests.entries()) {
      assert.equal(f.roomOf(c), null); const p = f.party(c);
      assert.ok(p); assert.notEqual(p.id, old[i].id); assert.notEqual(p.attempt.seed, old[i].seed);
      assert.equal(p.difficulty, difficulty); assert.equal(p.phase, 'extended'); assert.equal(p.members[0].ready, true);
      assert.equal(f.now() - p.attempt.startedAt, 60001); assert.equal(f.now() - clockBeforeRoomWait, 180000);
      assert.ok(p.attempt.excludedRooms.includes(room.code)); assert.equal(f.service.store.get(f.identity(c)).preference, 'sargonShip');
      assert.deepEqual(f.service.store.get(f.identity(c)).abandons, []);
      const returned = await c.waitFor('matching.returned'); assert.equal(returned.reason, 'backfill-disabled'); assert.equal(returned.searching, true);
      assert.ok(c.inbox.filter(m => m.t === 'room.state').every(m => m.matching.rules || !m.seats.some(s => guests.some(g => s?.playerId === g.id))));
    }
    const ordinary = await host.waitFor('room.state', m => !m.matching.rules && m.code === room.shareCode);
    assert.equal(ordinary.seats.filter(Boolean).length, 1); assert.equal(ordinary.seats[0].doctorCode, '0001');
    assert.ok(!JSON.stringify(ordinary).includes('matchingOrigin'));
    const p = f.party(guests[0]), seed = f.seed();
    await f.disable(host); assert.equal(f.party(guests[0]), p); assert.equal(f.seed(), seed);
    await f.enable(host); f.service.parties.pump();
    assert.equal(room.activeHumans().length, 1); assert.ok(guests.every(c => f.roomOf(c) === null));
  });
}

test('original friends remain while matchmade friends return as their original party with privacy and saved preferences intact', async t => {
  const f = await fixture(t), host = await f.player('房主#0001'), friend = await f.player('好友#0002'), a = await f.player('博士甲#0003'), b = await f.player('博士乙#0004');
  const room = await f.create(host); await f.request(friend, { t: 'room.join', code: room.shareCode }); await f.enable(host);
  const old = await f.group([a, b]), oldId = old.id; f.fill();
  const custom = { kind: 'custom', dataUrl: 'original-avatar' };
  for (const c of [friend, a]) { f.session(c).avatar = custom; room.seatOf(c.id).avatar = custom; }
  await f.request(a, { t: 'matching.roomPrepare', bond: 'victoriaShip', revision: room.matchingRevision });
  const privacy = [], changed = f.lobby.social.changed.bind(f.lobby.social);
  f.lobby.social.changed = () => { privacy.push([a, b].map(c => f.service.restricted(f.session(c)))); changed(); };
  await f.disable(host);
  assert.deepEqual(room.activeHumans().map(s => s.playerId), [host.id, friend.id]);
  assert.equal(f.party(a), f.party(b)); assert.notEqual(f.party(a).id, oldId); assert.equal(f.party(a).leaderId, a.id);
  assert.ok(f.party(a).members.every(m => m.ready)); assert.equal(f.party(a).phase, 'extended');
  assert.ok(privacy.length); assert.ok(privacy.every(values => values.every(Boolean)));
  assert.equal(f.service.store.get(f.identity(a)).preference, 'sargonShip'); assert.equal(f.session(a).avatar, custom);
  assert.deepEqual(f.service.parties.view(f.party(a)).members.find(m => m.playerId === a.id).avatar, MATCHING_AVATAR);
  assert.equal(room.toState().seats.find(s => s?.playerId === friend.id).avatar, custom);
  assert.equal(room.seatOf(friend.id).ready, false); assert.equal(room.seatOf(friend.id).preferenceSelected, false);
  assert.equal((await a.request({ t: 'matching.ready', ready: false, partyId: oldId, revision: old.revision })).code, 'MATCH_STALE');
});

test('return uses original queue difficulty after a room difficulty change and elects the earliest remaining friend', async t => {
  const f = await fixture(t), host = await f.player('房主#0001'), a = await f.player('博士甲#0002'), b = await f.player('博士乙#0003'), c = await f.player('博士丙#0004');
  const room = await f.create(host, 'HARD'); await f.enable(host); await f.group([a, b, c], 'HARD');
  f.service.store.edit(f.identity(b), row => { row.preference = 'egirShip'; }); f.fill();
  await f.request(host, { t: 'room.setDifficulty', difficulty: 'FUNNY' });
  assert.equal(room.seatOf(b.id).preferenceSelected, false);
  await f.request(a, { t: 'room.leave' }); await f.disable(host);
  assert.equal(f.party(a), null); assert.equal(f.party(b), f.party(c)); assert.equal(f.party(b).leaderId, b.id);
  assert.equal(f.party(b).difficulty, 'HARD'); assert.equal(f.party(b).phase, 'extended');
  assert.equal(f.service.store.get(f.identity(b)).preference, 'egirShip');
});

test('non-host, stale and in-game switch requests preserve members and create no return queue', async t => {
  const f = await fixture(t), host = await f.player('房主#0001'), a = await f.player('博士甲#0002');
  const room = await f.create(host); await f.enable(host); await f.prepare(a); f.fill(); const revision = room.matchingRevision, seed = f.seed();
  assert.equal((await a.request({ t: 'matching.setEnabled', on: false, revision })).code, 'NOT_HOST');
  assert.equal((await host.request({ t: 'matching.setEnabled', on: false, revision: revision - 1 })).code, 'MATCH_STALE');
  assert.equal(room.activeHumans().length, 2); assert.equal(f.seed(), seed); assert.equal(f.party(a), null);
  await f.request(host, { t: 'room.start' });
  assert.equal((await host.request({ t: 'matching.setEnabled', on: false, revision: room.matchingRevision })).code, 'MATCH_LOCKED');
  assert.equal(f.roomOf(a), room); assert.equal(room.matchmaking, true); assert.equal(f.party(a), null);
});

test('offline friend is removed without punishment, rejoins the restored party and requires fresh preparation', async t => {
  const f = await fixture(t), host = await f.player('房主#0001'), a = await f.player('博士甲#0002'), b = await f.player('博士乙#0003');
  await f.create(host); await f.enable(host); await f.group([a, b]); f.fill();
  await b.close(); await delay(30); await f.disable(host);
  assert.equal(f.roomOf(b), null); assert.equal(f.party(a), f.party(b)); assert.equal(f.party(a).phase, 'idle');
  assert.ok(f.party(a).members.every(m => !m.ready)); assert.equal((await a.waitFor('matching.returned')).error, 'NOT_READY');
  const resumed = await f.player('博士乙#0003', b.welcome.token); assert.equal(resumed.id, b.id);
  assert.equal((await resumed.waitFor('room.closed')).reason, 'backfill-disabled'); assert.equal(f.party(resumed), f.party(a));
  assert.deepEqual(f.service.store.get(f.identity(resumed)).abandons, []);
  await f.prepare(a); await f.prepare(resumed); assert.equal(f.party(a).phase, 'searching');
});

for (const failure of ['banned', 'blocked']) test(`new ${failure} restriction removes members but prevents automatic queue admission`, async t => {
  const f = await fixture(t), host = await f.player('房主#0001'), a = await f.player('博士甲#0002'), b = await f.player('博士乙#0003');
  await f.create(host); await f.enable(host); await f.group([a, b]); f.fill();
  f.service.store.edit(f.identity(a), row => { if (failure === 'banned') row.bannedUntil = f.now() + 60000; else row.blocks.push(f.identity(b)); });
  await f.disable(host); assert.equal(f.roomOf(a), null); assert.equal(f.roomOf(b), null);
  assert.equal(f.party(a), f.party(b)); assert.equal(f.party(a).phase, 'idle'); assert.ok(f.party(a).members.every(m => !m.ready));
  assert.equal((await a.waitFor('matching.returned')).error, failure === 'banned' ? 'MATCH_BANNED' : 'MATCH_BLOCKED');
  assert.deepEqual(f.service.store.get(f.identity(a)).abandons, []);
});

test('when only matchmade players remain, their host can disable and the empty room dissolves after restoring the party', async t => {
  const f = await fixture(t), host = await f.player('房主#0001'), a = await f.player('博士甲#0002'), b = await f.player('博士乙#0003');
  const room = await f.create(host); await f.enable(host); await f.group([a, b]); f.fill();
  await f.request(host, { t: 'room.leave' }); assert.equal(room.hostId, a.id);
  await f.disable(a); assert.equal(room.disposed, true); assert.equal(f.lobby.rooms.has(room.code), false);
  assert.equal(f.roomOf(a), null); assert.equal(f.party(a), f.party(b)); assert.equal(f.party(a).phase, 'extended');
  assert.deepEqual(f.service.store.get(f.identity(a)).abandons, []);
});
