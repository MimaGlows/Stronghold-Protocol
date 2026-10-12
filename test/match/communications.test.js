import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { makeMatch, give, giveItem, chessOfTier, legalTileFor } from './harness.js';
import { PHASE } from '../../shared/constants.js';
import { validateC2S } from '../../shared/protocol.js';
import { communicationText, communicationsAt, wheelDirection, crossedReplayRadio } from '../../shared/communication.js';
import { MatchRecorder } from '../../server/replays/recorder.js';

function fixture(t) {
  const h = makeMatch({ humans: 2, mode: 'coop', fake: true, spectators: ['observer'] }).start().toPrep(1);
  t.after(() => h.m.dispose());
  h.ps('p_0').name = '博士'; h.ps('p_1').name = '博士';
  h.ps('p_0').doctorCode = '0001'; h.ps('p_1').doctorCode = '0002';
  const send = (target, pid = 'p_0') => h.m.handle(pid, { t: 'g.ping', round: h.m.round, phase: h.m.phase, target });
  const next = () => { h.ps('p_0').communicationTimes = []; };
  return { h, m: h.m, me: h.ps('p_0'), other: h.ps('p_1'), send, next };
}
test('protocol accepts exact target shapes and rejects injected values / stale-shape requests', () => {
  const valid = { t: 'g.ping', round: 1, phase: PHASE.PREP, target: { kind: 'tile', playerId: 'p_0', row: 9, col: 2, intent: 'danger' } };
  assert.equal(validateC2S(valid), null);
  for (const target of [{ ...valid.target, text: 'spoof' }, { ...valid.target, row: NaN }, { ...valid.target, intent: 'cancel' }, { kind: 'piece', playerId: 'p_0', uid: -1 }, { kind: 'shop', playerId: 'p_0', slot: 0 }, { kind: 'life', playerId: '__bad#0001' }]) assert.ok(validateC2S({ ...valid, target }));
  assert.equal(validateC2S({ ...valid, phase: PHASE.BAND_DRAFT }), null);
  assert.ok(validateC2S({ t: 'g.radio', round: 1, phase: PHASE.PREP, id: 5 }));
});
test('authoritative public, bonds, shop and enemy data; same name remains separate by player ID', (t) => {
  const { m, me, other, h, send, next } = fixture(t);
  me.funds = 47; other.lp = 13;
  assert.deepEqual(send({ kind: 'life', playerId: other.playerId }), { ok: true });
  assert.equal(h.lastBc('m.communication').display.n, 13);
  assert.equal(h.lastBc('m.communication').text, '博士标记了博士的生命值剩余13'); next();
  assert.deepEqual(send({ kind: 'strategy', playerId: me.playerId }), { ok: true });
  assert.ok(h.lastBc('m.communication').text.includes('自己')); assert.ok(!h.lastBc('m.communication').text.includes('#')); next();
  for (const [kind, value] of [['funds', 47], ['level', me.shop.level]]) { assert.deepEqual(send({ kind, playerId: me.playerId }), { ok: true }); assert.equal(h.lastBc('m.communication').display.n, value); next(); }
  assert.equal(send({ kind: 'funds', playerId: other.playerId }).error, 'BAD_TARGET');
  const index = me.privateView().shop.slots.findIndex((s) => s && !s.sold), slot = me.privateView().shop.slots[index];
  assert.deepEqual(send({ kind: 'shop', playerId: me.playerId, slot: index, id: slot.id }), { ok: true });
  assert.equal(h.lastBc('m.communication').display.n, slot.price); next();
  assert.equal(send({ kind: 'shop', playerId: me.playerId, slot: index, id: 'stale' }).error, 'BAD_TARGET');
  const enemy = m.nextEnemiesFor(me)[0];
  assert.deepEqual(send({ kind: 'enemy', playerId: me.playerId, enemyKey: enemy.enemyKey }), { ok: true }); next();
  const id = chessOfTier(1).find((id) => m.pool.has(id)), op = give(m, me, id), [row, col] = legalTileFor(m, me, id);
  me.hand[me.hand.findIndex((p) => p?.uid === op.uid)] = null; me.board.set(`${row},${col}`, op); me.recompute();
  const bond = me.privateView().bonds[0];
  assert.deepEqual(send({ kind: 'bond', playerId: me.playerId, bondId: bond.bondId }), { ok: true });
  const e = h.lastBc('m.communication'); assert.equal(e.display.count, bond.count); assert.equal(e.display.layers, bond.layers); next();
  assert.equal(send({ kind: 'bond', playerId: other.playerId, bondId: bond.bondId }).error, 'BAD_TARGET');
  assert.deepEqual(m.handle('p_0', { t: 'g.watch', fieldId: 'n:p_1' }), { ok: true });
  assert.equal(send({ kind: 'piece', playerId: me.playerId, uid: op.uid }).error, 'BAD_TARGET', 'cannot expose a field that is not on screen');
});
test('bench, unequipped item, deployed operator and zero/one/two equipment use actual data', (t) => {
  const { h, m, me, send, next } = fixture(t);
  const id = chessOfTier(1).find((id) => m.pool.has(id)), op = give(m, me, id), item = giveItem(m, me, 'chess_item_1_01_e_a');
  assert.deepEqual(send({ kind: 'piece', playerId: me.playerId, uid: op.uid }), { ok: true }); assert.equal(h.lastBc('m.communication').kind, 'bench'); next();
  assert.deepEqual(send({ kind: 'piece', playerId: me.playerId, uid: item.uid }), { ok: true }); assert.equal(h.lastBc('m.communication').kind, 'item'); next();
  const [row, col] = legalTileFor(m, me, id); assert.deepEqual(m.handle('p_0', { t: 'g.move', uid: op.uid, to: { area: 'board', row, col } }), { ok: true });
  const q = { kind: 'piece', playerId: me.playerId, uid: op.uid };
  assert.deepEqual(send(q), { ok: true }); let e = h.lastBc('m.communication'); assert.ok(e.text.endsWith('未持有装备')); assert.deepEqual([e.location.row, e.location.col], [row, col]); next();
  assert.deepEqual(m.handle('p_0', { t: 'g.equip', itemUid: item.uid, targetUid: op.uid }), { ok: true });
  assert.deepEqual(send(q), { ok: true }); e = h.lastBc('m.communication'); assert.equal(e.display.items.length, 1); assert.ok(!e.text.endsWith('和')); next();
  const second = giveItem(m, me, 'chess_item_1_02_e_a'); assert.deepEqual(m.handle('p_0', { t: 'g.equip', itemUid: second.uid, targetUid: op.uid }), { ok: true });
  assert.deepEqual(send(q), { ok: true }); assert.equal(h.lastBc('m.communication').display.items.length, 2); assert.ok(h.lastBc('m.communication').text.includes('和')); next();
  assert.equal(send({ ...q, uid: item.uid }).error, 'BAD_TARGET', 'equipped items are not bench targets');
  me.board.delete(`${row},${col}`); assert.equal(send(q).error, 'BAD_TARGET');
});
test('independent radio rate limit, excluded phases, stale phase/round, spectators and eliminated participants', (t) => {
  const { h, m, me, send } = fixture(t);
  const radio = { t: 'g.radio', id: 0, phase: m.phase, round: m.round };
  assert.deepEqual(m.handle('p_0', radio), { ok: true }); assert.deepEqual(send({ kind: 'life', playerId: me.playerId }), { ok: true });
  for (let i = 1; i < 5; i++) { h.sched.advance(1000); assert.deepEqual(m.handle('p_0', radio), { ok: true }); }
  h.sched.advance(1000); assert.equal(m.handle('p_0', radio).error, 'RATE'); h.sched.advance(5000); assert.deepEqual(m.handle('p_0', radio), { ok: true });
  assert.equal(m.handle('observer', radio).error, 'SPECTATOR');
  assert.equal(m.handle('p_0', { ...radio, round: 2 }).error, 'WRONG_PHASE');
  for (const phase of [PHASE.INFO_CHECK, PHASE.RESULT]) { m.phase = phase; assert.equal(m.handle('p_0', { ...radio, phase }).error, 'WRONG_PHASE'); }
  m.phase = PHASE.PREP; me.alive = false; me.radioTimes = []; assert.deepEqual(m.handle('p_0', radio), { ok: true });
});
test('combat only permits empty deployable tiles; boss and unite coordinates stay authoritative', (t) => {
  const { m, me, other, h, send, next } = fixture(t);
  const tiles = [...me.deployMap().keys()].map((k) => k.split(',').map(Number)), [row, col] = tiles[0];
  me.board.set(`${row},${col}`, { uid: 999, kind: 'chess', id: 'none', items: [] });
  m.phase = PHASE.COMBAT; m.fields = [{ fieldId: 'n:p_0', players: ['p_0'], kind: 'normal' }];
  assert.equal(send({ kind: 'tile', playerId: me.playerId, row, col, intent: 'location' }).error, 'BAD_TARGET');
  assert.equal(send({ kind: 'piece', playerId: me.playerId, uid: 999 }).error, 'BAD_TARGET');
  assert.equal(send({ kind: 'enemy', playerId: me.playerId, enemyKey: 'enemy_any' }).error, 'BAD_TARGET');
  const [r, c] = tiles[1]; assert.deepEqual(send({ kind: 'tile', playerId: me.playerId, row: r, col: c, intent: 'danger' }), { ok: true }); next();
  assert.equal(send({ kind: 'tile', playerId: me.playerId, row: 0, col: 0, intent: 'good' }).error, 'BAD_TARGET');
  m.phase = PHASE.UNITE; m.fields = [{ fieldId: 'u', players: [me.playerId, other.playerId], kind: 'unite' }]; m.watchers.set(me.playerId, 'u');
  assert.deepEqual(send({ kind: 'tile', playerId: me.playerId, row: r, col: c, intent: 'missing' }), { ok: true }); assert.equal(h.lastBc('m.communication').location.col, c + 8);
});
test('communications are a lightweight independent replay track; old archives and seeking remain safe', (t) => {
  const { h, m } = fixture(t);
  const recorder = m.recorder = new MatchRecorder(m, { version: 'test', assignShare() {} });
  recorder.checkpoint(); const before = recorder.record.events.length;
  assert.deepEqual(m.handle('p_0', { t: 'g.radio', id: 2, round: m.round, phase: m.phase }), { ok: true });
  assert.equal(recorder.record.communications.length, 1); assert.equal(recorder.record.events.length, before);
  assert.equal(recorder.record.communications[0].state, undefined); assert.equal(recorder.record.communications[0].at, recorder.at());
  const event = { ...recorder.record.communications[0], at: 1000, location: { ownerId: 'p_0', row: 9, col: 2 } };
  assert.equal(communicationsAt([event], 999, 1).messages.length, 0);
  assert.equal(communicationsAt([event], 4999, 1).markers.length, 1);
  assert.equal(communicationsAt([event], 5000, 1).markers.length, 0);
  assert.equal(communicationsAt([event], 8999, 1).messages.length, 1);
  assert.equal(communicationsAt([event], 9000, 1).messages.length, 0);
  assert.equal(communicationsAt([event], 2000, 2).markers.length, 0);
  assert.deepEqual(communicationsAt(undefined, 500, 1), { messages: [], markers: [] });
  // 14 five-minute rounds, four players at the maximum sustained rate.
  const track = Array.from({ length: 8400 }, (_, i) => ({ ...event, id: `match:${i}`, at: i * 500, playerId: `p_${i % 4}` }));
  assert.ok(gzipSync(JSON.stringify(track)).length < 2_000_000, 'communications must not consume the 100 MB replay budget');
  m.recorder = null; void h;
});
test('fixed text and wheel directions', () => {
  const e = { playerId: 'a', senderName: '甲', targetPlayerId: 'a', targetName: '甲', display: { name: '单位' } };
  assert.equal(communicationText({ ...e, kind: 'danger' }), '甲警告自己可能有危险。');
  assert.equal(communicationText({ ...e, kind: 'missing', targetPlayerId: 'b', targetName: '乙' }), '甲提示乙敌人已不见踪影');
  assert.equal(communicationText({ ...e, kind: 'radio', radio: 4 }), '甲：先晋升干员');
  for (const [x, y, dir] of [[0, -70, 'danger'], [70, 0, 'missing'], [-70, 0, 'good'], [0, 70, 'cancel'], [5, 5, 'cancel']]) assert.equal(wheelDirection(x, y), dir);
});

test('replay radio sounds only during continuous playback, including small seek and player change guards', () => {
  const track = [{ at: 1000, kind: 'radio' }], previous = { playing: true, who: 'a', revision: 0, time: 990 };
  const current = { ...previous, time: 1010 };
  assert.equal(crossedReplayRadio(track, previous, current), true);
  for (const patch of [{ revision: 1 }, { who: 'b' }, { playing: false }, { time: 900 }, { time: 1600 }]) assert.equal(crossedReplayRadio(track, previous, { ...current, ...patch }), false);
  assert.equal(crossedReplayRadio(undefined, previous, current), false);
  assert.equal(crossedReplayRadio(track, { ...previous, playing: false }, current), false);
});
test('boss left/right markers invert the actual board transform and disabled bonds stay inactive', (t) => {
  const { m, me, other, h, send, next } = fixture(t);
  m.round = m.gd.bossRound; m.bossWaves = [{ players: [me.playerId, other.playerId] }];
  me._deployMap = null; other._deployMap = null;
  const [row, col] = [...other.deployMap().keys()][0].split(',').map(Number);
  assert.deepEqual(send({ kind: 'tile', playerId: other.playerId, row, col, intent: 'good' }), { ok: true });
  assert.deepEqual([h.lastBc('m.communication').location.row, h.lastBc('m.communication').location.col], [row - 7, 20 - col]);
  next(); const [r, c] = [...me.deployMap().keys()][0].split(',').map(Number);
  assert.deepEqual(send({ kind: 'tile', playerId: me.playerId, row: r, col: c, intent: 'location' }), { ok: true });
  assert.deepEqual([h.lastBc('m.communication').location.row, h.lastBc('m.communication').location.col], [r - 7, c]);
  assert.ok(communicationText({ kind: 'bond', playerId: 'a', targetPlayerId: 'a', senderName: '博士', display: { name: '灵巧', active: false, off: true, count: 2, threshold: 3, layers: 0 } }).endsWith('本局禁用'));
});

test('stand-in, DIY and summon communications use the displayed body instead of the stock identity', (t) => {
  const { h, m, me, send, next } = fixture(t);
  const silver = 'chess_char_4_22_a'; me.setNotOwned([silver]);
  const reserve = give(m, me, silver);
  assert.deepEqual(send({ kind: 'piece', playerId: me.playerId, uid: reserve.uid }), { ok: true });
  assert.equal(h.lastBc('m.communication').display.name, m.gd.standIn(silver).name); next();
  me.setDiy({ chess_char_5_diy1_a: { charId: 'char_112_siege', skillIndex: 2, uniEquipId: 'uniequip_002_siege' } });
  const diy = give(m, me, 'chess_char_5_diy1_a');
  assert.deepEqual(send({ kind: 'piece', playerId: me.playerId, uid: diy.uid }), { ok: true });
  assert.equal(h.lastBc('m.communication').display.name, me.gd.chess(diy.id).name); next();
  const tokenId = Object.keys(m.data.tokens)[0], token = me.newPiece('token', tokenId, { ownerUid: reserve.uid, count: 1 });
  me.temp[0] = token;
  assert.deepEqual(send({ kind: 'piece', playerId: me.playerId, uid: token.uid }), { ok: true });
  assert.equal(h.lastBc('m.communication').display.name, me.gd.token(tokenId).name);
  assert.equal(communicationText({ kind: 'strategy', senderName: '博士', playerId: 'p_0', targetPlayerId: 'p_0', display: { name: '' } }), '博士标记了自己的未选择策略');
});
