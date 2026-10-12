import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { ProfileStore } from '../server/profiles/store.js';
import { recentCoPlayers, isSocialIdentity } from '../shared/social.js';
import { validateC2S } from '../shared/protocol.js';
import { StubMatch } from '../server/match/StubMatch.js';
async function fixture(run, { real = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-social-'));
  const opts = { port: 0, host: '127.0.0.1', quiet: true, profileDir: dir, heavyPerSec: 1000, heavyBurst: 1000, rateBurst: 1000, ...(real ? { replayDir: path.join(dir, 'replays') } : { MatchClass: StubMatch }) };
  let server = await startServer(opts); const clients = [];
  const open = async (name) => { const c = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`); clients.push(c); c.welcome = await c.hello(name); return c; };
  const session = (c) => server.registry.byId(c.welcome.playerId);
  const sync = async (c) => { c.inbox = c.inbox.filter((m) => m.t !== 'social.state'); assert.equal((await c.request({ t: 'social.sync' })).t, 'ok'); return c.waitFor('social.state'); };
  const restart = async () => { await Promise.all(clients.map((c) => c.close())); await server.close(); server = await startServer(opts); };
  try { await run({ get server() { return server; }, open, session, sync, restart, dir }); }
  finally { await Promise.all(clients.map((c) => c.close())); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}
const intent = (c, t, identity) => c.request({ t, identity });
test('account privacy gates friend shortcuts and record reads, preserving link/invitation exceptions and durable preferences', async () => fixture(async (f) => {
  const a = await f.open('查看者#0001'), b = await f.open('隐私博士#0001'), b2 = await f.open('隐私博士#0001');
  await intent(a, 'social.add', '隐私博士#0001');
  const privacy = { allowFriendJoin: false, allowFriendSpectate: false, profileVisibility: 'friends' };
  assert.equal((await b.request({ t: 'profile.privacy', preferences: privacy })).t, 'ok');
  assert.deepEqual((await b2.waitFor('profile.preferences')).preferences.socialPrivacy, privacy);
  assert.equal(validateC2S({ t: 'profile.privacy', preferences: { ...privacy, allowFriendJoin: 'false' } }), 'bad field preferences');
  assert.equal(validateC2S({ t: 'profile.privacy', preferences: { ...privacy, profileVisibility: 'public' } }), 'bad field preferences');
  const read = (client, id = '') => fetch(`${f.server.url}/api/social-history?identity=${encodeURIComponent('隐私博士#0001')}${id ? '&id=' + id : ''}`, { headers: { Authorization: `Bearer ${client.welcome.token}` } });
  assert.equal((await read(a)).status, 403, 'viewer adding a target cannot grant access');
  assert.equal((await read(b)).status, 200, 'self is always allowed');
  assert.equal((await fetch(`${f.server.url}/api/social-history?identity=${encodeURIComponent('隐私博士#0001')}`)).status, 401);
  await intent(b, 'social.add', '查看者#0001'); assert.equal((await read(a)).status, 200);
  const archive = f.server.replays, id = '4455ef42-6565-4343-abab-989898989898', key = 'a'.repeat(48);
  const players = [{ playerId: b.welcome.playerId, name: '隐私博士', doctorCode: '0001' }, { playerId: a.welcome.playerId, name: '查看者', doctorCode: '0001' }];
  const result = { victory: true, roundsPassed: 1, players, difficulty: 'NORMAL' };
  const record = { v: 1, id, key, version: archive.version, status: 'ready', startedAt: Date.now(), expiresAt: Date.now() + 7200000, durationMs: 0, nodes: [], fields: [], events: [], participants: players, restrictions: {}, result };
  archive.write(record); f.server.lobby.profiles.remember(f.session(b).profile, { id, key, startedAt: record.startedAt }, b.welcome.playerId, result);
  const saved = f.server.lobby.profiles.read('隐私博士', '0001');
  const ticket = f.server.lobby.accountStats.ticket(saved, record);
  saved.statistics = { v: 1, revision: 1, records: [{ id, t: record.startedAt, end: 'settled', mode: 'coop', modeId: 'coop', difficulty: 'NORMAL', victory: true, roundsPassed: 1, selfId: b.welcome.playerId, players, replay: ticket }] };
  f.server.lobby.profiles.save(saved);
  const list = await (await read(a)).json(); assert.equal(list.records[0].id, id); assert.ok(!JSON.stringify(list).includes(key));
  const body = await (await read(a, id)).json(); assert.equal(body.v, 1); assert.equal(body.key, undefined); assert.equal(body.shareCode, undefined);
  await b.request({ t: 'profile.privacy', preferences: { ...privacy, profileVisibility: 'none' } }); assert.equal((await read(a, id)).status, 403);
  assert.equal((await fetch(`${f.server.url}/api/shared-replays/${record.shareCode}`)).status, 200, 'existing shared capability still works');
  await b.request({ t: 'profile.privacy', preferences: privacy }); await intent(b, 'social.remove', '查看者#0001');
  assert.equal((await read(a)).status, 403);
  await b.request({ t: 'profile.privacy', preferences: { ...privacy, profileVisibility: 'friends_recent' } }); assert.equal((await read(a)).status, 200, 'last-five teammate can read');
  await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' }); const original = f.session(a).roomCode;
  await b.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' }); const code = f.session(b).roomCode;
  assert.match((await intent(a, 'social.join', '隐私博士#0001')).detail, /不允许/); assert.equal(f.session(a).roomCode, original);
  assert.equal((await f.sync(a)).friends[0].canJoin, false);
  assert.equal((await a.request({ t: 'room.join', code })).t, 'ok', 'room link/code bypasses friend shortcut');
  await a.request({ t: 'room.leave' }); await b.request({ t: 'room.start' });
  assert.match((await intent(a, 'social.spectate', '隐私博士#0001')).detail, /不允许/);
  assert.equal((await f.sync(a)).friends[0].canSpectate, false);
  assert.equal((await a.request({ t: 'room.spectate', code })).t, 'ok', 'spectator link/code bypasses shortcut');
  await a.request({ t: 'room.leave' }); await b.request({ t: 'room.leave' });
  await intent(b, 'social.add', '查看者#0001'); await b.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  await intent(b, 'social.invite', '查看者#0001'); const invite = await a.waitFor('social.invite');
  assert.equal((await a.request({ t: 'social.inviteRespond', inviteId: invite.inviteId, accept: true })).t, 'ok');
  const before = f.server.lobby.profiles.read('隐私博士', '0001'); const save = f.server.lobby.profiles.save;
  f.server.lobby.profiles.save = () => { throw new Error('disk full'); };
  assert.equal((await b.request({ t: 'profile.privacy', preferences: { ...privacy, allowFriendJoin: true } })).code, 'INTERNAL'); f.server.lobby.profiles.save = save;
  assert.deepEqual(f.server.lobby.profiles.read('隐私博士', '0001'), before);
  await f.restart(); const restored = await f.open('隐私博士#0001'); assert.deepEqual(restored.welcome.profilePreferences.socialPrivacy, before.preferences.socialPrivacy);
}, { real: true }));
test('social search supports partial callsigns and exact codes, caps results, and restores its index after restart', async () => fixture(async (f) => {
  const a = await f.open('搜索者#0001');
  for (const [name, code] of [['星光', '0001'], ['星光', '0002'], ['星光博士', '0003'], ['Starlight', '0004']]) f.server.lobby.profiles.resolve(name, code);
  const search = async (value) => { assert.equal((await intent(a, 'social.search', value)).t, 'ok'); return a.waitFor('social.search'); };
  assert.deepEqual((await search('星光')).entries.map((row) => row.identity), ['星光#0001', '星光#0002', '星光博士#0003']);
  assert.equal((await search('STAR')).entries[0].identity, 'Starlight#0004');
  assert.deepEqual((await search('星光#0002')).entries.map((row) => row.identity), ['星光#0002']);
  assert.deepEqual((await search('光#0002')).entries, [], 'code makes the callsign exact');
  assert.equal(validateC2S({ t: 'social.search', identity: '#0001' }), 'bad field identity');
  assert.equal(validateC2S({ t: 'social.search', identity: '星光#001' }), 'bad field identity');
  assert.equal(validateC2S({ t: 'social.add', identity: '星光' }), 'bad field identity');
  for (let i = 0; i < 25; i++) f.server.lobby.profiles.resolve(`容量${i}`, '0001');
  const limited = await search('容量'); assert.equal(limited.entries.length, 20); assert.equal(limited.truncated, true);
  assert.ok(!JSON.stringify(limited).includes('history')); assert.ok(!JSON.stringify(limited).includes('token'));
  await f.restart(); const b = await f.open('搜索者#0001'); await intent(b, 'social.search', '星光');
  assert.equal((await b.waitFor('social.search')).entries.length, 3);
}));
test('recent list uses five settled matches, complete identity, excludes AI/self/friends and deduplicates', () => {
  const person = (name, code, isBot = false) => ({ name, doctorCode: code, isBot });
  const history = Array.from({ length: 7 }, (_, i) => ({ ended: true, endedAt: 100-i, participants: [person('本人','0001'), person('同名','0001'), person('同名',String(i+2).padStart(4,'0')), person('机器人','0099',true), { name: '旧缺代码' }] }));
  history.unshift({ ended: false, participants: [person('进行中','0001')] });
  history.unshift({ ended: true, playerId: 'spectator', result: { players: [{ playerId: 'other' }] }, participants: [person('只观战','0001')] });
  const rows = recentCoPlayers({ name:'本人', code:'0001', friends:['同名#0001'], history });
  assert.deepEqual(rows.map((r)=>r.identity), ['同名#0002','同名#0003','同名#0004','同名#0005','同名#0006']);
  assert.equal(isSocialIdentity('博士#0001'),true); assert.equal(isSocialIdentity('博士#001'),false);
  assert.equal(validateC2S({t:'social.add',identity:'博士#001'}),'bad field identity');
});
test('single-direction friends sync across windows and restart; failures preserve avatar/preferences/history', async () => fixture(async (f) => {
  const a=await f.open('甲#0001'), a2=await f.open('甲#0001'), b=await f.open('乙#0001');
  await f.sync(a); await f.sync(a2); await f.sync(b);
  assert.equal((await intent(a,'social.search','不存在#0001')).t,'ok'); assert.equal((await a.waitFor('social.search')).entry,null);
  assert.equal((await intent(a,'social.add','不存在#0001')).code,'BAD_TARGET');
  assert.equal((await intent(a,'social.add','甲#0001')).code,'BAD_TARGET');
  assert.equal((await intent(a,'social.add','乙#0001')).t,'ok');
  assert.equal((await a2.waitFor('social.state',(m)=>m.friends.length===1)).friends[0].identity,'乙#0001');
  assert.deepEqual((await f.sync(b)).friends,[]);
  assert.equal((await intent(a,'social.add','乙#0001')).code,'ALREADY');
  const state=await f.sync(a); assert.ok(!JSON.stringify(state).includes('token')); assert.ok(!JSON.stringify(state).includes('dataUrl'));
  assert.equal((await intent(a,'social.avatar','乙#0001')).t,'ok'); assert.deepEqual((await a.waitFor('social.avatar')).avatar,{kind:'default'});
  const b1=await f.open('乙#0002'); assert.equal((await f.sync(b1)).friends.length,0);
  const before=f.server.lobby.profiles.read('甲','0001');
  const save=f.server.lobby.profiles.save; f.server.lobby.profiles.save=()=>{throw new Error('disk full');};
  assert.equal((await intent(a,'social.remove','乙#0001')).code,'INTERNAL'); f.server.lobby.profiles.save=save;
  assert.deepEqual(f.server.lobby.profiles.read('甲','0001'),before);
  await b.close(); const offline=await a.waitFor('social.presence',(m)=>m.entries.some((r)=>r.identity==='乙#0001'&&r.status==='offline')); assert.equal(offline.profileKey,'甲#0001');
  await f.restart(); const restored=await f.open('甲#0001'); assert.equal((await f.sync(restored)).friends[0].identity,'乙#0001');
  assert.equal((await intent(restored,'social.remove','乙#0001')).t,'ok'); assert.equal((await f.sync(restored)).friends.length,0);
}));
test('recent identities survive expiry/backfill and move between lists without overwriting other profile fields', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sp-social-history-')), profiles=new ProfileStore(dir);
  try {
    let p=profiles.resolve('本人','0001').profile;
    p.preferences={voiceLanguage:'cn',voiceOverrides:{}}; profiles.save(p);
    for(let i=0;i<6;i++) p=profiles.remember(p,{id:`match${i}`,key:'key',startedAt:i},'self',{victory:true,players:[{playerId:'self',name:'本人',doctorCode:'0001'},{name:`队友${i}`,doctorCode:'0001'},{name:'AI',isBot:true}],difficulty:'NORMAL'});
    assert.equal(recentCoPlayers(p).length,5); assert.ok(!recentCoPlayers(p).some((r)=>r.identity==='队友0#0001'));
    p=profiles.friends(p,['队友5#0001']); assert.equal(recentCoPlayers(p).length,4);
    p=profiles.friends(p,[]); assert.equal(recentCoPlayers(p).length,5); assert.equal(p.preferences.voiceLanguage,'cn');
    delete p.history[0].participants; profiles.save(p);
    let calls=0; const archive={ get(){calls++;return{status:'expired',participants:[{name:'迁入队友',doctorCode:'0007'}]};} };
    p=profiles.backfillParticipants(p,archive); assert.equal(calls,1); assert.ok(recentCoPlayers(p).some((r)=>r.identity==='迁入队友#0007'));
    profiles.backfillParticipants(p,archive); assert.equal(calls,1);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('invitation requires consent, capacity is rechecked, forged replies rejected and all windows close together', async () => fixture(async (f) => {
  const a=await f.open('房主#0001'), b=await f.open('被邀#0001'), b2=await f.open('被邀#0001'), c=await f.open('另一个#0001');
  await intent(a,'social.add','被邀#0001'); await intent(a,'social.add','另一个#0001');
  await a.request({t:'room.create',mode:'coop',difficulty:'HARD'}); const room=f.server.lobby.roomOf(f.session(a));
  await a.request({t:'room.addBot'});await a.request({t:'room.addBot'});
  assert.equal((await intent(a,'social.invite','被邀#0001')).t,'ok'); const invite=await b.waitFor('social.invite'); await b2.waitFor('social.invite');
  assert.equal(f.session(b).roomCode,null);
  assert.equal((await c.request({t:'social.inviteRespond',inviteId:invite.inviteId,accept:true})).code,'BAD_TARGET');
  assert.equal((await intent(a,'social.invite','被邀#0001')).code,'RATE');
  await intent(a,'social.invite','另一个#0001'); const second=await c.waitFor('social.invite');
  assert.equal((await b.request({t:'social.inviteRespond',inviteId:invite.inviteId,accept:true})).t,'ok');
  assert.equal((await b2.waitFor('social.inviteEnded')).reason,'accepted');assert.equal(f.session(b).roomCode,room.code);
  await c.request({t:'room.create',mode:'coop',difficulty:'NORMAL'}); const old=f.session(c).roomCode;
  const failed=await c.request({t:'social.inviteRespond',inviteId:second.inviteId,accept:true}); assert.equal(failed.code,'ROOM_FULL');assert.match(failed.detail,/人数已满/); assert.equal(f.session(c).roomCode,old);
  await b.request({t:'room.ready',ready:true}); await a.request({t:'room.start'});
  assert.equal((await c.waitFor('social.inviteEnded')).reason,'expired');
  assert.equal((await c.request({t:'social.inviteRespond',inviteId:second.inviteId,accept:true})).code,'BAD_TARGET');
}));
test('expired/declined invites do not transfer players; ongoing recipient cannot be moved', async () => fixture(async (f) => {
  const a=await f.open('邀请者#0001'), b=await f.open('接受者#0001'); await intent(a,'social.add','接受者#0001');
  await a.request({t:'room.create',mode:'coop',difficulty:'NORMAL'});
  let now=Date.now(); f.server.lobby.now=()=>now;
  await intent(a,'social.invite','接受者#0001');let invite=await b.waitFor('social.invite');
  assert.equal((await b.request({t:'social.inviteRespond',inviteId:invite.inviteId,accept:false})).t,'ok');assert.equal(f.session(b).roomCode,null);
  now+=30001;await intent(a,'social.invite','接受者#0001');invite=await b.waitFor('social.invite');
  now+=120001;f.server.lobby.social.sweep();assert.equal((await b.waitFor('social.inviteEnded',(m)=>m.inviteId===invite.inviteId)).reason,'expired');
  const b2=await f.open('接受者#0001');
  await b.request({t:'room.create',mode:'solo',difficulty:'FUNNY'});await b.request({t:'room.start'});const own=f.session(b).roomCode;
  await intent(a,'social.invite','接受者#0001');invite=await b.waitFor('social.invite');
  assert.equal((await b.request({t:'social.inviteRespond',inviteId:invite.inviteId,accept:true})).code,'ROOM_STARTED');assert.equal(f.session(b).roomCode,own);
  assert.equal((await b2.request({t:'social.inviteRespond',inviteId:invite.inviteId,accept:true})).code,'ROOM_STARTED');assert.equal(f.session(b2).roomCode,null);
  await a.request({t:'room.leave'});assert.equal((await b.waitFor('social.inviteEnded',(m)=>m.inviteId===invite.inviteId)).reason,'expired');
}));
test('friend presence reports game HUD data; solo has two read-only spectators, full join preserves original room', async () => fixture(async (f) => {
  const a=await f.open('独立博士#0001'), b=await f.open('观战甲#0001'), c=await f.open('观战乙#0001'), d=await f.open('观战丙#0001');
  for(const client of [b,c,d])await intent(client,'social.add','独立博士#0001');
  await f.sync(b);await a.request({t:'room.create',mode:'solo',difficulty:'FUNNY'});await a.request({t:'room.start'});
  const room=f.server.lobby.roomOf(f.session(a));
  assert.equal((await intent(b,'social.spectate','独立博士#0001')).t,'ok');assert.equal((await intent(c,'social.spectate','独立博士#0001')).t,'ok');
  await d.request({t:'room.create',mode:'coop',difficulty:'NORMAL'});const old=f.session(d).roomCode;
  const full=await intent(d,'social.spectate','独立博士#0001');assert.equal(full.code,'ROOM_FULL');assert.equal(f.session(d).roomCode,old);assert.match(full.detail,/观战席位已满/);
  assert.equal((await b.request({t:'g.infoReady'})).code,'SPECTATOR');
  const state=await f.sync(b), row=state.friends[0];assert.equal(row.status,'playing');assert.equal(row.difficulty,'FUNNY');assert.equal(row.lp,room.socialPublic.players[0].lp);
  // Do not let a live match flush replace this injected HUD before the 1-second
  // presence throttle opens. Frequency limiting has its own deterministic test.
  for(const sub of f.server.lobby.social.subscribers.values())sub.gameAt.set('独立博士#0001',f.server.lobby.now()-1001);
  room.socialPublic={phase:'COMBAT',round:3,players:[{playerId:a.welcome.playerId,lp:18,pendingLp:3,bandId:'strategy'}]};f.server.lobby.social.changed();
  const updated=await b.waitFor('social.presence',(m)=>m.entries.some((r)=>r.round===3));assert.equal(updated.entries[0].lp,15);assert.equal(updated.entries[0].bandId,'strategy');
  const health=await(await fetch(f.server.url+'/healthz')).json();assert.equal(health.ok,true);assert.equal(health.spectators,2);
},{real:true}));

test('friend capacity is 200 and two simultaneous accepts cannot claim the same last seat', async () => fixture(async (f) => {
  const a = await f.open('容量博士#0001'), b = await f.open('争抢甲#0001'), c = await f.open('争抢乙#0001');
  const profiles = f.server.lobby.profiles, ids = ['争抢甲#0001', '争抢乙#0001'];
  for (let i = 0; i < 198; i++) { const p = profiles.resolve(`好友${i}`, '0001').profile; ids.push(`${p.name}#${p.code}`); }
  profiles.friends(f.session(a).profile, ids); profiles.resolve('第201位', '0001');
  assert.equal((await intent(a, 'social.add', '第201位#0001')).detail, '好友数量已达上限');
  assert.equal((await f.sync(a)).friends.length, 200);
  await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  await a.request({ t: 'room.addBot' }); await a.request({ t: 'room.addBot' });
  await intent(a, 'social.invite', '争抢甲#0001'); await intent(a, 'social.invite', '争抢乙#0001');
  const invites = await Promise.all([b.waitFor('social.invite'), c.waitFor('social.invite')]);
  const replies = await Promise.all([b, c].map((client, i) => client.request({ t: 'social.inviteRespond', inviteId: invites[i].inviteId, accept: true })));
  assert.equal(replies.filter((r) => r.t === 'ok').length, 1); assert.equal(replies.filter((r) => r.code === 'ROOM_FULL').length, 1);
  assert.equal(f.server.lobby.roomOf(f.session(a)).seats.filter(Boolean).length, 4);
}));

test('real settlement retains a departed teammate, excludes spectator history and survives replay expiry', async () => fixture(async (f) => {
  const a = await f.open('结算房主#0001'), b = await f.open('退出队友#0001'), watcher = await f.open('纯观战#0001');
  await a.request({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY' });
  const room = f.server.lobby.roomOf(f.session(a)); await b.request({ t: 'room.join', code: room.code });
  await watcher.request({ t: 'room.spectate', code: room.code }); await b.request({ t: 'room.ready', ready: true }); await a.request({ t: 'room.start' });
  await b.request({ t: 'room.leave' });
  room.match.finish({ victory: false });
  const list = await f.sync(a); assert.deepEqual(list.recent.map((r) => r.identity), ['退出队友#0001']);
  assert.equal(f.server.lobby.profiles.read('纯观战', '0001').history.length, 0);
  assert.deepEqual((await f.sync(watcher)).recent, []);
  const entry = f.server.lobby.profiles.read('结算房主', '0001').history[0];
  fs.rmSync(f.server.replays.file(entry.id), { force: true });
  assert.deepEqual((await f.sync(a)).recent.map((r) => r.identity), ['退出队友#0001']);
  assert.ok(f.server.lobby.profiles.read('退出队友', '0001').history[0].ended);
}, { real: true }));
