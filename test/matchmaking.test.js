import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { Match } from '../server/match/Match.js';
import { TestClient } from './helpers/wsClient.js';
import { loadData } from '../server/data.js';
import { MatchingStore } from '../server/matchmaking/store.js';
import { CallsignFilter, defaultCallsignFilter } from '../server/matchmaking/sensitive.js';
import { GameData } from '../server/match/gamedata.js';
import { drawDisabledBonds } from '../server/match/pool.js';
import { createRng, deriveSeed } from '../server/sim/rng.js';
import { CORE_PREFERENCES, MATCH_WINDOW_MS, MATCH_PENALTIES, validPreference } from '../shared/matchmaking.js';
import { validateC2S } from '../shared/protocol.js';
import { DEFAULT_AVATAR } from '../shared/avatar.js';
import { setTimeout as delay } from 'node:timers/promises';
import { Net } from '../public/js/net.js';
import { pathToFileURL } from 'node:url';

test('pending matchmaking requests cannot be replayed under a different pseudo-account', async () => {
  const client = new Net();
  client.name = '博士甲#0001'; client.status = 'connecting'; client.ws = { readyState: 0, close() {} };
  const pending = client.request('matching.create', { difficulty: 'NORMAL' });
  const rejected = assert.rejects(pending, (e) => e.code === 'OFFLINE');
  client.setName('博士乙#0002'); await rejected;
  assert.equal(client._pending.size, 0); client.close();
});

test('dictionary is pinned/checksummed and callsigns reject case, fullwidth, zero-width and separators', () => {
  const f = new CallsignFilter(['badword', '不良词']);
  for (const name of ['BADWORD', 'ｂａｄｗｏｒｄ', 'b\u200badword', 'bad word', 'bad-word', '不 良 词']) assert.equal(f.check(name), false, name);
  assert.equal(f.check('普通博士'), true);
  assert.equal(defaultCallsignFilter().check('ＡＤＭＩＮ'), true);
  assert.equal(defaultCallsignFilter().check('博士甲'), true);
});

test('blacklist membership is symmetric, capped, idempotent and requires completed co-participation', () => {
  const store = new MatchingStore();
  const a = '博士甲#0001', b = '博士乙#0002';
  assert.equal(store.block(a, b, 'missing'), 'MATCH_BAD_TEAMMATE');
  store.remember('game', [a, b]);
  assert.equal(store.block(a, b, 'game'), null);
  assert.equal(store.block(a, b, 'game'), null);
  assert.equal(store.get(a).blocks.length, 1);
  assert.ok(store.blocked(a, b)); assert.ok(store.blocked(b, a));
  const rest = Array.from({ length: 20 }, (_, i) => `博士${i}#1111`);
  store.remember('full', [a, ...rest]);
  for (const id of rest.slice(0, 19)) assert.equal(store.block(a, id, 'full'), null);
  assert.equal(store.block(a, rest[19], 'full'), 'MATCH_BLOCK_FULL');
  store.edit(a, (row) => { row.blocks = row.blocks.filter((id) => id !== b); });
  assert.equal(store.blocked(a, b), false);
});

test('sanctions roll over seven days, use all four tiers, deduplicate and survive a store restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-matching-store-'));
  try {
    const store = new MatchingStore(dir), id = '博士甲#0001';
    const now = 2 * MATCH_WINDOW_MS;
    for (let i = 0; i < 5; i++) {
      const row = store.abandon(id, `game-${i}`, now + i * 1000);
      assert.equal(row.bannedUntil, now + i * 1000 + MATCH_PENALTIES[Math.min(i, 3)]);
      assert.equal(store.abandon(id, `game-${i}`, now + i * 1000 + 1).abandons.length, i + 1);
    }
    assert.deepEqual(new MatchingStore(dir).get(id), store.get(id));
    const reset = store.abandon(id, 'after-week', now + MATCH_WINDOW_MS + 5000);
    assert.equal(reset.abandons.length, 1); assert.equal(reset.bannedUntil, now + MATCH_WINDOW_MS + 5000 + MATCH_PENALTIES[0]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const data = loadData();
test('difficulty and wire validation only allow a single supported core preference', () => {
  assert.ok(validPreference(data, 'FUNNY', 'yanShip'));
  assert.equal(validPreference(data, 'FUNNY', 'egirShip'), false);
  assert.equal(validPreference(data, 'NORMAL', 'swiftShip'), false);
  assert.ok(validateC2S({ t: 'matching.preference', bond: ['yanShip', 'sargonShip'] }));
  assert.equal(validateC2S({ t: 'matching.preference', bond: 'yanShip' }), null);
});

test('all four preferences are protected together; seeded probability is >=60%, ordinary setup is unchanged', () => {
  for (const difficulty of ['NORMAL', 'HARD', 'ABYSS']) {
    const gd = new GameData(data, `mode_multi_${difficulty.toLowerCase()}`), prefs = CORE_PREFERENCES.slice(0, 4);
    const counts = prefs.map(() => 0);
    for (let seed = 1; seed <= 10_000; seed++) {
      const protect = createRng(deriveSeed(seed, 'matching-preference'))() < 0.6 ? prefs : [];
      const bans = drawDisabledBonds(gd, createRng(deriveSeed(seed, 'setup')), protect);
      assert.equal(bans.drawn.filter((id) => gd.bond(id).isCore).length, 3);
      assert.equal(bans.drawn.filter((id) => !gd.bond(id).isCore).length, 4);
      prefs.forEach((id, i) => { if (!bans.drawn.includes(id)) counts[i]++; if (protect.length) assert.ok(!bans.drawn.includes(id)); });
    }
    for (const n of counts) assert.ok(n / 10_000 > 0.8 && n / 10_000 < 0.9, `expected approximately 85%, got ${n / 100}%`);
  }
  const opts = { mode: 'coop', difficulty: 'NORMAL', seats: [{ seat: 0, playerId: 'p1', name: '博士甲', connected: true, isBot: false }], seed: 12345, data, matchingPreferences: ['yanShip', 'egirShip'], send() {}, broadcast() {}, onEnd() {} };
  const first = new Match(opts), second = new Match(opts);
  assert.deepEqual(first.disabledBonds, second.disabledBonds);
  assert.equal(first.requestSetupReroll('p1', 0).error, 'MATCH_LOCKED');
  first.dispose(); second.dispose();
});

class CapturedMatch extends StubMatch {
  constructor(options) {
    super(options); this.options = options; this.startedAt = this.now();
    this.sched = { now: () => this.now() - this.startedAt };
    for (const p of this.players.values()) p.alive = true;
  }
}
async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-matching-integration-'));
  let seed = 100;
  const server = await startServer({ port: 0, quiet: true, profileDir: path.join(dir, 'profiles'), matchmakingDir: path.join(dir, 'matching'), MatchClass: CapturedMatch, seedFn: () => ++seed, ...options });
  if(options.now) server.lobby.now=options.now;
  const clients = [];
  t.after(async () => { await Promise.all(clients.map((c) => c.terminate())); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  async function player(name) {
    const c = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`);
    const welcome = await c.hello(name); c.id = welcome.playerId; clients.push(c); return c;
  }
  async function create(c, difficulty = 'NORMAL') {
    assert.equal((await c.request({ t: 'room.create', mode: 'coop', difficulty })).t, 'ok');
    assert.equal((await c.request({ t: 'matching.setEnabled', on: true, bond: null, revision: server.lobby.roomOf(server.registry.byId(c.id)).matchingRevision })).t, 'ok');
    return server.lobby.roomOf(server.registry.byId(c.id));
  }
  async function request(c, fields) { if (fields.t === 'matching.setEnabled') fields = { ...fields, bond: fields.bond ?? null, revision: server.lobby.roomOf(server.registry.byId(c.id)).matchingRevision }; if (fields.t.startsWith('matching.') && !('partyId' in fields) && !['matching.sync','matching.block','matching.unblock','matching.invite','matching.inviteRespond','matching.setEnabled','matching.create','matching.timeoutChoice','matching.return'].includes(fields.t)) { const p=server.lobby.matchmakingService.parties.of(server.registry.byId(c.id)); if (p || fields.t==='matching.start') fields={...fields,partyId:p?.id || null}; } const result = await c.request(fields); assert.equal(result.t, 'ok', JSON.stringify(result)); return result; }
  return { ...server, player, create, request, seed: () => seed };
}

const service = (f) => f.lobby.matchmakingService;
const session = (f,c) => f.registry.byId(c.id);
const partyOf = (f,c) => service(f).parties.of(session(f,c));
async function start(f,c,difficulty='NORMAL') { return f.request(c,{t:'matching.start',difficulty,revision:partyOf(f,c)?.revision || 0}); }
async function party(f, people, difficulty='NORMAL') {
  const [host,...guests]=people;
  for(const guest of guests) {
    const identity=service(f).identity(session(f,guest)); await f.request(host,{t:'social.add',identity});
    await f.request(host,{t:'matching.invite',identity,difficulty});
    const invite=[...service(f).parties.invites.values()].find((i)=>i.to===identity);
    assert.ok(invite); await f.request(guest,{t:'matching.inviteRespond',inviteId:invite.id,accept:true});
    await f.request(guest,{t:'matching.ready',revision:partyOf(f,guest).revision,ready:true});
  }
  return partyOf(f,host);
}
async function players(f,n) { const names=['甲','乙','丙','丁','戊','己','庚','辛']; const result=[]; for(let i=0;i<n;i++)result.push(await f.player(`博士${names[i]}#000${i+1}`)); return result; }

async function prepare(f,c,bond=null,difficulty='NORMAL') {
  const p=partyOf(f,c);
  return f.request(c,{t:'matching.prepare',partyId:p?.id || null,revision:p?.revision || 0,difficulty:p?.difficulty || difficulty,bond});
}
test('solo declaration is atomic: invalid preference creates no party, valid choice starts once and persists',async(t)=>{
  const f=await fixture(t),[a]=await players(f,1);
  assert.equal((await a.request({t:'matching.prepare',partyId:null,revision:0,difficulty:'FUNNY',bond:'egirShip'})).code,'MATCH_PREFERENCE');
  assert.equal(partyOf(f,a),null);
  await prepare(f,a,'yanShip');const p=partyOf(f,a),seed=p.attempt.seed;
  assert.equal(p.phase,'searching');assert.equal(p.members[0].ready,true);assert.equal(service(f).store.get('博士甲#0001').preference,'yanShip');
  assert.equal((await a.request({t:'matching.prepare',partyId:null,revision:0,difficulty:'NORMAL',bond:'yanShip'})).code,'MATCH_STALE');
  assert.equal(p.attempt.seed,seed);assert.equal(f.seed(),seed);
});
test('all members declare independently; last ready autoqueues, any member can unready to cancel the entire attempt',async(t)=>{
  const f=await fixture(t),[a,b]=await players(f,2);const p=await party(f,[a,b]);
  await f.request(b,{t:'matching.ready',ready:false,revision:p.revision});
  const before=f.seed();await prepare(f,a,'yanShip');assert.equal(p.phase,'idle');assert.equal(f.seed(),before);
  await prepare(f,b,'sargonShip');assert.equal(p.phase,'searching');assert.equal(f.seed(),before+1);
  const previous=p.attempt.id;
  assert.equal((await b.request({t:'matching.ready',partyId:p.id,revision:p.revision,ready:false,attemptId:randomUUID()})).code,'MATCH_STALE');
  await f.request(b,{t:'matching.ready',ready:false,revision:p.revision,attemptId:previous});
  assert.equal(p.phase,'idle');assert.equal(p.attempt,null);assert.equal(p.members.length,2);assert.ok(p.members.every(m=>!m.ready));
  await prepare(f,b,'sargonShip');await prepare(f,a,'yanShip');const current=p.attempt.id;
  assert.notEqual(current,previous);
  assert.equal((await b.request({t:'matching.ready',partyId:p.id,revision:p.revision,ready:false,attemptId:previous})).code,'MATCH_STALE');
  assert.equal(p.attempt.id,current);assert.equal(service(f).store.get('博士乙#0002').bannedUntil,0);
});
test('four-person declaration starts directly; rejected final ready does not strand the member as ready',async(t)=>{
  const f=await fixture(t),[a,b,c,d]=await players(f,4);const p=await party(f,[a,b,c,d]);
  for(const m of [b,c,d])await f.request(m,{t:'matching.ready',ready:false,revision:p.revision});
  for(const [i,m] of [a,b,c].entries())await prepare(f,m,CORE_PREFERENCES[i]);
  service(f).store.edit('博士丁#0004',record=>record.blocks.push('博士甲#0001'));
  assert.equal((await d.request({t:'matching.prepare',partyId:p.id,revision:p.revision,difficulty:p.difficulty,bond:'kjeragShip'})).code,'MATCH_BLOCKED');
  assert.equal(p.members.find(m=>m.playerId===d.id).ready,false);assert.equal(p.phase,'idle');
  await f.request(d,{t:'matching.unblock',identity:'博士甲#0001'});await prepare(f,d,'kjeragShip');
  const room=f.lobby.roomOf(session(f,a));assert.equal(room.activeHumans().length,4);assert.ok(room.match);assert.equal(room.match.options.matchingPreferences.length,4);
});

test('MimaGlows and normal English names pass; political and explicit abuse remain strict',()=>{
  const filter=defaultCallsignFilter();
  for(const name of ['MimaGlows','ＭｉｍａＧｌｏｗｓ','ADMIN','Scunthorpe','Classic','Alice','普通博士']) assert.equal(filter.check(name),true,name);
  for(const name of ['fuck','ＦＵＣＫ','f\u200buck','f u c k','hello-fuck','傻逼','傻 逼']) assert.equal(filter.check(name),false,name);
  const f=new CallsignFilter({political:['政治词','strictword'],abuse:['shit']});
  for(const name of ['政治词博士','政 治 词','ＳＴＲＩＣＴＷＯＲＤname','strict\u200bword']) assert.equal(f.check(name),false);
  assert.equal(f.check('Shitake'),true); assert.equal(f.check('s h i t'),false);
  assert.equal(f.check('hi s h i t bye'),false);
  const meta=JSON.parse(fs.readFileSync(new URL('../server/matchmaking/sensitive-source.json',import.meta.url)));
  assert.equal(meta.policyVersion,2); assert.ok(meta.abuseSha256); assert.ok(meta.count>1000);
});

test('both offline dictionary checksums fail closed without mutating the installed dictionary',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sp-policy-check-'));
  try {
    for(const file of ['sensitive.js','sensitive-words.txt','sensitive-abuse.txt','sensitive-source.json'])fs.copyFileSync(new URL('../server/matchmaking/'+file,import.meta.url),path.join(dir,file));
    const meta=JSON.parse(fs.readFileSync(path.join(dir,'sensitive-source.json'),'utf8'));
    fs.writeFileSync(path.join(dir,'sensitive-words.txt'),'tampered\n');
    let mod=await import(pathToFileURL(path.join(dir,'sensitive.js')).href+'?political');assert.throws(()=>mod.defaultCallsignFilter(),/checksum mismatch/);
    fs.copyFileSync(new URL('../server/matchmaking/sensitive-words.txt',import.meta.url),path.join(dir,'sensitive-words.txt'));
    fs.writeFileSync(path.join(dir,'sensitive-abuse.txt'),'tampered\n');
    mod=await import(pathToFileURL(path.join(dir,'sensitive.js')).href+'?abuse');assert.throws(()=>mod.defaultCallsignFilter(),/checksum mismatch/);assert.equal(meta.policyVersion,2);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('same identity in a second window cannot duplicate its party or change preferences and avatars during search',async(t)=>{
  const f=await fixture(t),a=await f.player('MimaGlows#0001');await start(f,a);
  const alias=await f.player('MimaGlows#0001');
  assert.equal((await alias.request({t:'matching.start',difficulty:'NORMAL',partyId:null,revision:0})).code,'MATCH_LOCKED');
  assert.equal((await alias.request({t:'matching.preference',bond:'yanShip',difficulty:'NORMAL'})).code,'MATCH_LOCKED');
  const custom={kind:'custom',dataUrl:'data:image/webp;base64,original-test-value'};
  assert.equal(f.lobby.setAvatar(session(f,alias),{avatar:custom}).error,'MATCH_LOCKED');
  assert.equal(service(f).parties.parties.size,1);
});

test('two invited parties stay in the lobby and merge atomically with the oldest seed; stale and repeated requests fail',async(t)=>{
  const f=await fixture(t),[a,b,c,d]=await players(f,4);
  const p=await party(f,[a,b]),q=await party(f,[c,d]);
  assert.equal(f.lobby.rooms.size,0);
  for(const [i,person] of [a,b,c,d].entries())await f.request(person,{t:'matching.preference',bond:CORE_PREFERENCES[i],revision:partyOf(f,person).revision});
  for(const person of [b,d])await f.request(person,{t:'matching.ready',ready:true,revision:partyOf(f,person).revision});
  await start(f,a); const seed=p.attempt.seed;
  assert.equal(f.lobby.rooms.size,0); assert.equal(p.phase,'searching');
  assert.equal((await a.request({t:'matching.start',difficulty:'NORMAL',partyId:p.id,revision:p.revision})).code,'MATCH_LOCKED');
  assert.equal((await a.request({t:'matching.preference',bond:'egirShip',partyId:p.id,revision:p.revision})).code,'MATCH_LOCKED');
  assert.equal((await b.request({t:'room.create',mode:'coop',difficulty:'NORMAL'})).code,'MATCH_LOCKED');
  await start(f,c); const room=f.lobby.roomOf(session(f,a));
  assert.ok(room.queueGenerated); assert.equal(room.activeHumans().length,4); assert.equal(room.hostId,a.id);
  assert.equal(room.match.options.seed,seed); assert.equal(room.match.options.matchingProtection,.6);
  assert.deepEqual(room.match.options.matchingPreferences,CORE_PREFERENCES.slice(0,4)); assert.equal(room.matchCount,1); assert.equal(q.phase,'playing');
  assert.equal(JSON.stringify(room.toState()).includes('"seed"'),false); assert.equal(JSON.stringify(service(f).parties.view(p)).includes('"seed"'),false);
});

test('cancel is free, preserves original party, resets ready, rerolls once, and locks invitations',async(t)=>{
  const f=await fixture(t),[a,b,c]=await players(f,3),p=await party(f,[a,b]);
  await start(f,a); const old={partyId:p.id,attemptId:p.attempt.id,revision:p.revision},seed=p.attempt.seed;
  assert.equal((await a.request({t:'matching.invite',identity:'博士丙#0003',difficulty:'NORMAL'})).code,'MATCH_LOCKED');
  assert.equal((await a.request({t:'matching.cancel',...old,revision:old.revision-1})).code,'MATCH_STALE');
  await f.request(a,{t:'matching.cancel',...old}); assert.equal(p.phase,'idle'); assert.equal(p.members.length,2); assert.equal(p.members[1].ready,false);
  assert.equal(service(f).store.get('博士甲#0001').bannedUntil,0);
  assert.equal((await a.request({t:'matching.cancel',...old})).code,'MATCH_STALE');
  await f.request(b,{t:'matching.ready',ready:true,revision:p.revision}); await start(f,a); assert.notEqual(p.attempt.seed,seed);
  await b.terminate(); await delay(30); assert.equal(p.phase,'idle'); assert.equal(p.attempt,null);
  assert.equal((await c.request({t:'matching.create',difficulty:'NORMAL'})).code,'MATCH_STALE');
});

test('four prequeued friends immediately start, outstanding invitations expire on start, and singles do not partially merge',async(t)=>{
  const f=await fixture(t),ps=await players(f,4); await party(f,ps); await start(f,ps[0]); assert.ok(f.lobby.roomOf(session(f,ps[0])).match);
  const f2=await fixture(t),[a,b]=await players(f2,2);
  await f2.request(a,{t:'social.add',identity:'博士乙#0002'}); await f2.request(a,{t:'matching.invite',identity:'博士乙#0002',difficulty:'NORMAL'});
  const invite=[...service(f2).parties.invites.values()][0]; assert.equal(service(f2).parties.view(partyOf(f2,a)).invites.length,1);
  await start(f2,a); assert.equal(service(f2).parties.invites.size,0);
  assert.equal((await b.request({t:'matching.inviteRespond',inviteId:invite.id,accept:true})).code,'MATCH_STALE');
  await start(f2,b); assert.equal(f2.lobby.rooms.size,0); assert.equal(partyOf(f2,a).members.length,1); assert.equal(partyOf(f2,b).members.length,1);
});

test('priority favours 2+2 and all singles ahead of 2+1+1 and 3+1',async(t)=>{
  const f=await fixture(t),ps=await players(f,8); await party(f,ps.slice(0,3)); await party(f,ps.slice(4,6)); await party(f,ps.slice(6,8));
  const q=service(f).parties; q.pumping=true;
  for(const p of [ps[0],ps[3],ps[4],ps[6]])await start(f,p);
  q.pumping=false; q.pump();
  const pairRoom=f.lobby.roomOf(session(f,ps[4])); assert.deepEqual(pairRoom.activeHumans().map((s)=>s.playerId),ps.slice(4,8).map((p)=>p.id));
  assert.equal([...f.lobby.rooms.values()][0],pairRoom);
  const trioRoom=f.lobby.roomOf(session(f,ps[0])); assert.equal(trioRoom.activeHumans().length,4);
  assert.ok(pairRoom.match); assert.ok(trioRoom.match); assert.ok(pairRoom.createdAt<=trioRoom.createdAt);
});

test('difficulty, symmetric blocks and duplicate identities exclude matches without splitting parties',async(t)=>{
  const f=await fixture(t),[a,b,c,d]=await players(f,4); await party(f,[a,b]); await party(f,[c,d],'HARD');
  await start(f,a); await start(f,c,'HARD'); assert.equal(f.lobby.rooms.size,0);
  const q=partyOf(f,c); await f.request(c,{t:'matching.cancel',attemptId:q.attempt.id,revision:q.revision});
  await f.request(c,{t:'matching.difficulty',difficulty:'NORMAL',revision:q.revision}); await f.request(d,{t:'matching.ready',ready:true,revision:q.revision});
  service(f).store.edit('博士丁#0004',(s)=>s.blocks.push('博士甲#0001')); await start(f,c); assert.equal(f.lobby.rooms.size,0);
  await f.request(d,{t:'matching.unblock',identity:'博士甲#0001'}); service(f).parties.pump(); assert.ok(f.lobby.roomOf(session(f,a)).match);
});

test('60s boundary enables whole-party backfill, preserves host, disables AI and never auto-starts ordinary rooms',async(t)=>{
  let now=100000; const f=await fixture(t,{now:()=>now}),[host,a,b]=await players(f,3);
  await f.request(host,{t:'matching.preference',bond:'egirShip',difficulty:'NORMAL'});
  const room=await f.create(host,'FUNNY');
  assert.equal(room.seatOf(host.id).preference,null);
  assert.equal(service(f).store.get('博士甲#0001').preference,'egirShip');
  assert.equal((await host.request({t:'matching.preference',bond:'yanShip',difficulty:'FUNNY'})).code,'MATCH_LOCKED');
  assert.equal((await host.request({t:'room.addBot'})).code,'MATCH_BOTS');
  await f.request(a,{t:'matching.preference',bond:'yanShip',difficulty:'FUNNY'});
  const p=await party(f,[a,b],'FUNNY'); await start(f,a,'FUNNY');
  now+=59999; service(f).parties.pump(); assert.equal(room.activeHumans().length,1);
  now++; service(f).parties.pump(); assert.equal(room.activeHumans().length,3); assert.equal(room.hostId,host.id); assert.equal(room.match,null);
  assert.equal(room.seatOf(a.id).ready,true); assert.equal(partyOf(f,a),null); assert.equal(p.phase,'idle');
  assert.equal(room.toState().matching.rules,true);
  await f.request(host,{t:'room.start'}); assert.equal(room.match.options.matchingProtection,.7);
  assert.deepEqual(room.match.options.matchingPreferences,['yanShip']);
  assert.equal(room.match.options.seats.length,3);
});

test('after 60s no destination means continued search; room opening triggers immediate transfer, capacity preserves whole teams',async(t)=>{
  let now=100000; const f=await fixture(t,{now:()=>now}),[h1,h2,a,b,c]=await players(f,5);
  const first=await f.create(h1); assert.equal(f.lobby.joinRoom(session(f,h2),first).ok,true);
  await party(f,[a,b,c]); await start(f,a); now+=60000; service(f).parties.pump();
  assert.equal(partyOf(f,a).phase,'extended'); assert.equal(first.activeHumans().length,2);
  await f.request(h2,{t:'room.leave'}); service(f).parties.pump(); assert.equal(first.activeHumans().length,4); assert.equal(first.match,null);
  await f.request(h1,{t:'matching.setEnabled',on:false}); await f.request(a,{t:'room.leave'}); await f.request(b,{t:'room.leave'}); await f.request(c,{t:'room.leave'});
  await f.request(h1,{t:'room.addBot'}); assert.equal(first.seats.filter((s)=>s?.isBot).length,1);
  assert.equal((await h1.request({t:'matching.setEnabled',on:true,bond:null,revision:first.matchingRevision})).code,'MATCH_BOTS');
});

test('preferences persist by account, difficulty clears illegal prefs, avatars mask without overwriting stored choice',async(t)=>{
  const f=await fixture(t),a=await f.player('MimaGlows#0001'),b=await f.player('博士乙#0002'),s=session(f,a);
  const custom={kind:'custom',dataUrl:'data:image/webp;base64,original-test-value'}; s.avatar=custom;
  await f.request(a,{t:'matching.preference',bond:'egirShip',difficulty:'NORMAL'});
  const p=await party(f,[a,b]); assert.equal(service(f).parties.view(p).members[0].avatar.kind,'operator'); assert.equal(s.avatar,custom);
  assert.equal(f.lobby.setAvatar(s,{avatar:custom}).error,'MATCH_LOCKED');
  await f.request(a,{t:'matching.difficulty',difficulty:'FUNNY',revision:p.revision}); assert.equal(service(f).store.get('MimaGlows#0001').preference,null);
  await f.request(a,{t:'matching.leave'}); assert.equal(service(f).restricted(s),false); assert.equal(s.avatar,custom);
  const stored=new MatchingStore(path.dirname(service(f).store.file)); assert.equal(stored.get('MimaGlows#0001').preference,null);
});

test('settlement allows verified blocks, return restores original friends and requires fresh ready',async(t)=>{
  const f=await fixture(t),ps=await players(f,4); const p=await party(f,ps.slice(0,2)),q=await party(f,ps.slice(2));
  await start(f,ps[0]); await start(f,ps[2]); const room=f.lobby.roomOf(session(f,ps[0])),id=room.matchCtx.matching.id;
  assert.equal((await ps[0].request({t:'matching.block',matchId:id,identity:'博士丙#0003'})).code,'MATCH_BAD_TEAMMATE');
  for(const c of ps)await f.request(c,{t:'g.infoReady'});
  const res=await ps[0].waitFor('m.result'); assert.equal(res.matching.generated,true); assert.equal(p.phase,'settled');
  await f.request(ps[0],{t:'matching.block',matchId:id,identity:'博士丙#0003'}); assert.equal(service(f).store.get('博士甲#0001').blocks.length,1);
  for(const c of ps)await f.request(c,{t:'matching.return',matchId:id});
  assert.equal(f.lobby.rooms.size,0); assert.equal(p.members.length,2); assert.equal(q.members.length,2); assert.equal(p.phase,'idle'); assert.equal(p.members[1].ready,false);
  assert.equal((await ps[0].request({t:'matching.return',matchId:id})).code,'MATCH_STALE');
  assert.equal((await ps[0].request({t:'matching.start',difficulty:'NORMAL',partyId:p.id,revision:p.revision})).code,'NOT_READY');
});

test('active quit, rolling sanctions, normal/eliminated/shutdown exemptions and reconnect grace survive new queue architecture',async(t)=>{
  const f=await fixture(t,{matchmakingReconnectMs:80}),[a,b,c,d]=await players(f,4);
  const room=await f.create(a); await f.request(a,{t:'room.start'}); await f.request(a,{t:'g.leave'});
  assert.equal(service(f).store.get('博士甲#0001').abandons.length,1);
  assert.equal((await a.request({t:'matching.start',difficulty:'NORMAL',partyId:null,revision:0})).code,'MATCH_BANNED');
  await f.request(a,{t:'room.create',mode:'coop',difficulty:'NORMAL'}); await f.request(a,{t:'room.start'}); await f.request(a,{t:'g.leave'}); assert.equal(service(f).store.get('博士甲#0001').abandons.length,1);
  const eliminated=await f.create(b); await f.request(b,{t:'room.start'}); eliminated.match.players.get(b.id).alive=false; await f.request(b,{t:'g.leave'}); assert.equal(service(f).store.get('博士乙#0002').bannedUntil,0);
  const grace=await f.create(c); await f.request(c,{t:'room.start'}); const s=session(f,c); s.connected=false; f.lobby.onDisconnect(s); s.connected=true; service(f).reconnected(s); await delay(100); assert.equal(service(f).store.get('博士丙#0003').bannedUntil,0);
  s.connected=false; f.lobby.onDisconnect(s); await delay(100); assert.equal(service(f).store.get('博士丙#0003').abandons.length,1);
  const shutdown=await f.create(d); await f.request(d,{t:'room.start'}); f.lobby.disposeRoom(shutdown,'shutdown'); assert.equal(service(f).store.get('博士丁#0004').bannedUntil,0);
});

test('70% backfill protection is reproducible, improves availability and still permits bans outside protection',()=>{
  const gd=new GameData(data,'mode_multi_normal'),prefs=CORE_PREFERENCES.slice(0,4); let hits=0,ordinaryBans=0;
  for(let seed=1;seed<=10000;seed++) { const protect=createRng(deriveSeed(seed,'matching-preference'))()<.7;
    const bans=drawDisabledBonds(gd,createRng(deriveSeed(seed,'setup')),protect?prefs:[]);
    if(!bans.drawn.includes(prefs[0]))hits++; if(!protect&&bans.drawn.some((id)=>prefs.includes(id)))ordinaryBans++;
    if(protect)assert.ok(prefs.every((id)=>!bans.drawn.includes(id)));
  }
  assert.ok(hits/10000>.87&&hits/10000<.90); assert.ok(ordinaryBans>0);
});

test('delayed leave and ready messages from a previous party cannot change a new party',async(t)=>{
  const f=await fixture(t),a=await f.player('MimaGlows#0001'); await start(f,a); const previous=partyOf(f,a);
  await f.request(a,{t:'matching.cancel',attemptId:previous.attempt.id,revision:previous.revision}); await f.request(a,{t:'matching.leave'});
  await start(f,a); const current=partyOf(f,a); assert.notEqual(previous.id,current.id);
  assert.equal((await a.request({t:'matching.leave',partyId:previous.id})).code,'MATCH_STALE');
  assert.equal((await a.request({t:'matching.ready',partyId:previous.id,revision:current.revision,ready:true})).code,'MATCH_STALE');
  assert.equal(partyOf(f,a),current); assert.equal(current.phase,'searching');
});
