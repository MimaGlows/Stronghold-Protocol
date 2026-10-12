import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './harness.js';
import { PHASE } from '../../shared/constants.js';
import { validateC2S } from '../../shared/protocol.js';
import { communicationText } from '../../shared/communication.js';

function setup(t) {
  const h = makeMatch({ humans: 2, mode: 'coop', fake: true }).start().toPrep(1);
  t.after(() => h.m.dispose());
  const me = h.ps('p_0'), other = h.ps('p_1');
  const send = target => h.m.handle(me.playerId, { t: 'g.ping', round: h.m.round, phase: h.m.phase, target });
  return { h, m: h.m, me, other, send };
}
test('ping accepts at 125 ms and 40/10s, failed targets consume no budget, radio is independent', t => {
  const { h, m, me, send } = setup(t), target = { kind: 'life', playerId: me.playerId };
  assert.deepEqual(send(target), { ok: true });
  h.sched.advance(124); assert.equal(send(target).error, 'RATE');
  h.sched.advance(1); assert.deepEqual(send(target), { ok: true });
  for (let i = 2; i < 40; i++) { h.sched.advance(125); assert.deepEqual(send(target), { ok: true }); }
  h.sched.advance(125); assert.equal(send(target).error, 'RATE');
  assert.deepEqual(m.handle(me.playerId, { t: 'g.radio', round: m.round, phase: m.phase, id: 0 }), { ok: true });
  h.sched.advance(5000); assert.deepEqual(send(target), { ok: true });
  const before = me.communicationTimes.length;
  assert.equal(send({ kind: 'tile', playerId: me.playerId, row: 0, col: 0, intent: 'location' }).error, 'BAD_TARGET');
  assert.equal(me.communicationTimes.length, before);
});
test('public bounty intention is legal outside own turn and cannot select/claim a card', t => {
  const { h, m, me, other, send } = setup(t);
  m.phase = PHASE.SP_DRAFT;
  m.sp = { family: 'bounty', cards: [{ idx: 0, id: 'bounty_1', kind: 'bounty', name: '特别悬赏' }], order: [other.playerId, me.playerId], idx: 0, picks: {}, taken: {} };
  const before = JSON.stringify(m.sp), target = { kind: 'bounty', playerId: me.playerId, idx: 0 };
  assert.equal(validateC2S({ t: 'g.ping', round: m.round, phase: m.phase, target }), null);
  assert.deepEqual(send(target), { ok: true }); assert.equal(JSON.stringify(m.sp), before);
  const event = h.lastBc('m.communication'); assert.equal(event.kind, 'bounty'); assert.equal(communicationText(event), me.name + '想要选择特别悬赏');
  m.sp.taken[0] = other.playerId; assert.equal(send(target).error, 'WRONG_PHASE');
  m.sp.taken = {}; m.sp.family = 'supply'; assert.equal(send(target).error, 'WRONG_PHASE');
  assert.ok(validateC2S({ t: 'g.ping', round: m.round, phase: m.phase, target: { ...target, name: '伪造' } }));
});
test('personal bounty checks current choice identity and never grants another account a private choice', t => {
  const { m, me, other, send } = setup(t);
  me.personalChoice = { id: 'choice_1', round: m.round, cards: [{ idx: 0, id: 'personal', name: '个人特训' }] };
  const target = { kind: 'bounty', playerId: me.playerId, idx: 0, choiceId: 'choice_1' }, before = JSON.stringify(me.personalChoice);
  assert.deepEqual(send(target), { ok: true }); assert.equal(JSON.stringify(me.personalChoice), before);
  assert.equal(send({ ...target, choiceId: 'choice_0' }).error, 'WRONG_PHASE');
  assert.equal(send({ ...target, idx: 5 }).error, 'BAD_TARGET');
  assert.equal(send({ ...target, playerId: other.playerId }).error, 'BAD_TARGET');
  me.personalChoice = null; assert.equal(send(target).error, 'WRONG_PHASE');
});
test('watching another prep board permits its tiles and forbids unrelated boards', t => {
  const { m, me, other, send } = setup(t), [row, col] = [...other.deployMap().keys()][0].split(',').map(Number);
  assert.equal(send({ kind: 'tile', playerId: other.playerId, row, col, intent: 'location' }).error, 'BAD_TARGET');
  assert.deepEqual(m.handle(me.playerId, { t: 'g.watch', fieldId: 'n:' + other.playerId }), { ok: true });
  assert.deepEqual(send({ kind: 'tile', playerId: other.playerId, row, col, intent: 'location' }), { ok: true });
});
test('boss combat permits either half, respects spec side and rejects occupied teammate tiles', t => {
  const { h, m, me, other, send } = setup(t); m.phase = PHASE.FINAL_ASSAULT;
  m.fields = [{ fieldId: 'boss-pair', kind: 'boss', players: [me.playerId, other.playerId], spec: { players: [{ playerId: me.playerId, side: 'L' }, { playerId: other.playerId, side: 'R' }] } }];
  m.watchers.set(me.playerId, 'boss-pair');
  for (const [player, side] of [[me, 'L'], [other, 'R']]) {
    const [row, col] = [...player.deployMap().keys()][0].split(',').map(Number); me.communicationTimes = [];
    assert.deepEqual(send({ kind: 'tile', playerId: player.playerId, row, col, intent: 'danger' }), { ok: true });
    assert.equal(h.lastBc('m.communication').location.col, side === 'R' ? 20 - col : col);
    player.board.set(row + ',' + col, { uid: 123, kind: 'chess', id: 'occupied' });
    assert.equal(send({ kind: 'tile', playerId: player.playerId, row, col, intent: 'location' }).error, 'BAD_TARGET');
  }
});
