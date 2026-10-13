import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-invitation-transfer-'));
  let now = Date.now();
  const f = await startServer({ port: 0, host: '127.0.0.1', quiet: true,
    profileDir: path.join(dir, 'profiles'), matchmakingDir: path.join(dir, 'matching'), MatchClass: StubMatch });
  f.lobby.now = () => now;
  const clients = [], parties = f.lobby.matchmakingService.parties;
  t.after(async () => { await Promise.all(clients.map(c => c.terminate())); await f.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const open = async (name) => { const c = await TestClient.connect(`ws://127.0.0.1:${f.port}/ws`); clients.push(c); c.id = (await c.hello(name)).playerId; return c; };
  const session = c => f.registry.byId(c.id), identity = c => f.lobby.matchmakingService.identity(session(c));
  const room = c => f.lobby.roomOf(session(c)), party = c => parties.of(session(c));
  const request = async (c, fields) => { const r = await c.request(fields); assert.equal(r.t, 'ok', JSON.stringify(r)); return r; };
  const create = async (c, backfill = false) => {
    await request(c, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    if (backfill) await request(c, { t: 'matching.setEnabled', on: true, bond: null, revision: room(c).matchingRevision });
    return room(c);
  };
  const search = async c => request(c, { t: 'matching.start', difficulty: 'NORMAL', partyId: party(c)?.id || null, revision: party(c)?.revision || 0 });
  const invite = async (host, guest, kind = 'matching', difficulty = 'NORMAL') => {
    await request(host, { t: 'social.add', identity: identity(guest) });
    await request(host, { t: `${kind}.invite`, identity: identity(guest), ...(kind === 'matching' ? { difficulty } : {}) });
    const entries = kind === 'matching' ? parties.invites : f.lobby.social.invites;
    return [...entries.values()].find(i => i.to === identity(guest)).id;
  };
  return { ...f, open, session, identity, room, party, request, create, search, invite, parties, advance: ms => { now += ms; } };
}

for (const source of ['idle party', 'searching party', 'normal room', 'backfill room']) {
  for (const destination of ['idle party', 'searching party', 'normal room', 'backfill room']) {
    test(`accept invitation transfers ${source} to ${destination} only after confirmation`, async t => {
      const f = await fixture(t), a = await f.open('邀请者#0001'), b = await f.open('接受者#0002');
      let oldRoom = null, oldParty = null;
      if (source.endsWith('room')) oldRoom = await f.create(b, source.startsWith('backfill'));
      else { await f.search(b); oldParty = f.party(b); if (source.startsWith('idle')) f.parties.cancel(oldParty); }
      const kind = destination.endsWith('room') ? 'social' : 'matching';
      if (kind === 'social') await f.create(a, destination.startsWith('backfill'));
      else if (destination.startsWith('searching')) await f.search(a);
      const attempt = oldParty?.attempt, ready = oldRoom?.seatOf(b.id)?.ready;
      const id = await f.invite(a, b, kind);
      // Delivering (and scheduler sweeping) must not move the recipient or cancel either search.
      f.parties.pump();
      assert.equal(f.room(b), oldRoom); assert.equal(f.party(b), oldParty);
      if (oldParty) assert.equal(oldParty.attempt, attempt);
      if (oldRoom) assert.equal(oldRoom.seatOf(b.id).ready, ready);
      await f.request(b, { t: `${kind}.inviteRespond`, inviteId: id, accept: true });
      if (kind === 'matching') {
        assert.equal(f.room(b), null); assert.equal(f.party(b), f.party(a));
        assert.equal(f.party(a).phase, 'idle'); assert.equal(f.party(a).attempt, null);
        assert.ok(f.party(a).members.every(m => !m.ready));
        if (oldRoom) assert.ok(b.inbox.some(m => m.t === 'room.closed' && m.reason === 'invited'));
      } else {
        assert.equal(f.room(b), f.room(a)); assert.equal(f.party(b), null);
        assert.equal(f.room(b).seatOf(b.id).ready, false);
        assert.equal(f.room(b).seatOf(b.id).preferenceSelected, false);
      }
      if (oldRoom) assert.equal(oldRoom.seatOf(b.id), null);
      if (oldParty) assert.equal(f.parties.parties.has(oldParty.id), false);
      assert.equal(f.lobby.matchmakingService.store.get(f.identity(b)).bannedUntil, 0);
      assert.equal((await b.request({ t: `${kind}.inviteRespond`, inviteId: id, accept: true })).t, 'error');
    });
  }
}

for (const kind of ['matching', 'social']) {
  for (const failure of ['decline', 'expired', 'full', 'blocked', 'banned', 'started']) {
    test(`${kind} invitation ${failure} preserves the previous queue and readiness`, async t => {
      const f = await fixture(t), a = await f.open('邀请者#0001'), b = await f.open('接受者#0002');
      await f.search(b); const previous = f.party(b), attempt = previous.attempt;
      if (kind === 'social') await f.create(a, true);
      const id = await f.invite(a, b, kind), store = f.lobby.matchmakingService.store;
      if (failure === 'expired') f.advance(120001);
      if (failure === 'full') {
        if (kind === 'matching') for (let i = 0; i < 3; i++) f.party(a).members.push({ playerId: `full-${i}`, identity: `占位${i}#0003` });
        else for (let i = 1; i < 4; i++) f.room(a).seats[i] = { seat: i, isBot: true, playerId: `bot-${i}` };
      }
      if (failure === 'blocked') store.edit(f.identity(a), row => { row.blocks.push(f.identity(b)); });
      if (failure === 'banned') store.edit(f.identity(b), row => { row.bannedUntil = f.lobby.now() + 60000; });
      if (failure === 'started') {
        if (kind === 'social') f.room(a).match = { dispose() {} };
        else { f.party(a).phase = 'playing'; f.parties.pump(); }
      }
      const result = await b.request({ t: `${kind}.inviteRespond`, inviteId: id, accept: failure !== 'decline' });
      assert.equal(result.t, failure === 'decline' ? 'ok' : 'error');
      assert.equal(f.party(b), previous); assert.equal(previous.attempt, attempt); assert.equal(previous.phase, 'searching');
      assert.equal(previous.members[0].ready, true); assert.equal(f.room(b), null);
    });
  }
}

test('leaving an old searching party transfers leadership and resets the remaining members without penalty', async t => {
  const f = await fixture(t), a = await f.open('邀请者#0001'), b = await f.open('旧队长#0002'), c = await f.open('旧队员#0003');
  const initial = await f.invite(b, c); await f.request(c, { t: 'matching.inviteRespond', inviteId: initial, accept: true });
  const previous = f.party(b);
  await f.request(c, { t: 'matching.ready', partyId: previous.id, revision: previous.revision, ready: true });
  await f.search(b); const id = await f.invite(a, b);
  await f.request(b, { t: 'matching.inviteRespond', inviteId: id, accept: true });
  assert.equal(f.party(c), previous); assert.equal(previous.leaderId, c.id); assert.equal(previous.phase, 'idle');
  assert.equal(previous.attempt, null); assert.deepEqual(previous.members.map(m => m.ready), [false]);
});

test('acceptance in another account window removes the previous party membership', async t => {
  const f = await fixture(t), a = await f.open('邀请者#0001'), b = await f.open('接受者#0002'), other = await f.open('接受者#0002');
  await f.search(b); const previous = f.party(b), id = await f.invite(a, other);
  await f.request(other, { t: 'matching.inviteRespond', inviteId: id, accept: true });
  assert.equal(f.party(b), null); assert.equal(f.party(other), f.party(a)); assert.equal(f.parties.parties.has(previous.id), false);
});

test('running games can receive an invitation but acceptance preserves the game until manually exited', async t => {
  const f = await fixture(t), a = await f.open('邀请者#0001'), b = await f.open('接受者#0002');
  const old = await f.create(b); await f.request(b, { t: 'room.start' });
  const id = await f.invite(a, b);
  assert.equal((await b.request({ t: 'matching.inviteRespond', inviteId: id, accept: true })).code, 'ROOM_STARTED');
  assert.equal(f.room(b), old); assert.ok(old.match); assert.equal(f.party(b), null);
});

test('cross-difficulty invitation preserves the old preference until acceptance and clears it before new preparation', async t => {
  const f = await fixture(t), a = await f.open('邀请者#0001'), b = await f.open('接受者#0002');
  const store = f.lobby.matchmakingService.store;
  await f.request(b, { t: 'matching.prepare', difficulty: 'HARD', bond: 'egirShip', partyId: null, revision: 0 });
  const previous = f.party(b), attempt = previous.attempt;
  // FUNNY is the standard mode; the inviter's saved higher-difficulty preference cannot prevent a new party.
  store.edit(f.identity(a), row => { row.preference = 'egirShip'; });
  const id = await f.invite(a, b, 'matching', 'FUNNY');
  assert.equal(store.get(f.identity(a)).preference, null);
  assert.equal(store.get(f.identity(b)).preference, 'egirShip'); assert.equal(previous.attempt, attempt);
  await f.request(b, { t: 'matching.inviteRespond', inviteId: id, accept: true });
  assert.equal(store.get(f.identity(b)).preference, null); assert.equal(f.party(b).difficulty, 'FUNNY');
  assert.equal(f.party(b).members.find(m => m.playerId === b.id).ready, false);
});
