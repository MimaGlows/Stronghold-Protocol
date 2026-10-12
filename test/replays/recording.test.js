import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ReplayArchive } from '../../server/replays/archive.js';
import { MatchRecorder } from '../../server/replays/recorder.js';
import { makeMatch } from '../match/harness.js';
import { PHASE } from '../../shared/constants.js';
import { stateAt, hudAt, fieldFrame, floorIndex } from '../../public/js/replay/timeline.js';
const quiet = { error() {}, info() {}, warn() {} };
async function ready(archive, ticket) {
  for (let i = 0; i < 600; i++) { const record = archive.get(ticket.id, ticket.key); if (record?.status !== 'processing') return record; await delay(50); }
  throw new Error('archive worker timeout');
}
test('co-op decisions, restrictions and complete battle frames survive worker and restart', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-replay-'));
  let archive = new ReplayArchive(dir, quiet);
  const h = makeMatch({ humans: 2, bots: 1, clientCombat: true, seed: 223, captureFrames: false });
  h.m.recorder = archive.create(h.m);
  try {
    h.autoHumans(); h.start(); h.run(() => h.m.round >= 3 || h.ended);
    if (!h.ended) h.m.finish({ victory: false, reason: 'test-complete' });
    const ticket = h.lastTo('p_0', 'm.result').replay;
    const record = await ready(archive, ticket);
    assert.equal(record.status, 'ready', JSON.stringify(record.errors));
    assert.ok(record.nodes.some((n) => n.phase === PHASE.PREP));
    assert.ok(record.nodes.some((n) => n.phase === PHASE.COMBAT));
    assert.ok(record.fields.length >= 3);
    for (const field of record.fields) {
      assert.ok(field.frames.length > 1, `${field.id} frame track`);
      assert.ok(field.frames.at(-1).gt >= field.endGt - .11);
      assert.equal(field.source, 'simulation');
      assert.equal(field.spec.seed, JSON.parse(JSON.stringify(field.spec)).seed);
    }
    for (const p of h.m.order) {
      assert.ok(record.events.some((e) => e.playerId === p.playerId && e.type === 'band'), `nested pick ${p.playerId}`);
      assert.ok(record.events.some((e) => e.playerId === p.playerId && e.type === 'buy'), `purchase ${p.playerId}`);
      assert.ok(record.events.some((e) => e.playerId === p.playerId && e.type === 'move'), `deployment ${p.playerId}`);
    }
    assert.deepEqual(record.restrictions.bannedChess, h.m.bannedChess);
    assert.deepEqual(record.restrictions.mode, h.m.gd.mode);
    assert.equal(record.key, undefined);
    assert.ok(record.nodes.every((n) => !n.public.replay));
    assert.equal(archive.get(ticket.id, '0'.repeat(48)), null);
    assert.equal(archive.get('../escape', ticket.key), null);
    await archive.close(); archive = new ReplayArchive(dir, quiet);
    assert.deepEqual(archive.get(ticket.id, ticket.key), record);
    const buy = record.events.find((e) => e.type === 'buy');
    assert.ok(buy.detail.item.id); assert.ok(buy.detail.item.price >= 0);
    assert.ok(stateAt(record, record.durationMs, buy.playerId).node.phase === PHASE.RESULT);
  } finally { h.m.dispose(); await archive.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('processing archive resumes after shutdown; recording failures do not reject game actions', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-recovery-'));
  let archive = new ReplayArchive(dir, quiet);
  const h = makeMatch({ mode: 'solo', clientCombat: true, seed: 225 });
  h.m.recorder = archive.create(h.m);
  try {
    h.autoHumans(); h.start(); h.run(() => h.m.phase === PHASE.SETTLE || h.ended);
    if (!h.ended) h.m.finish({ victory: false });
    const ticket = h.lastTo('p_0', 'm.result').replay;
    await archive.close(); archive = new ReplayArchive(dir, quiet);
    const record = await ready(archive, ticket);
    assert.equal(record.status, 'ready', JSON.stringify(record.errors));
    assert.ok(record.fields[0].frames.length > 1);
  } finally { h.m.dispose(); await archive.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  const sample = makeMatch({ mode: 'solo' });
  const recorder = new MatchRecorder(sample.m, { save() {} });
  const ps = sample.m.order[0];
  recorder.playerState = () => { throw new Error('recorder unavailable'); };
  let performed = false;
  assert.deepEqual(recorder.action(ps, 'refresh', [], () => { performed = true; return { ok: true }; }), { ok: true });
  assert.ok(performed); assert.ok(recorder.record.errors.includes('recorder unavailable'));
  const count = recorder.record.events.length;
  recorder.action(ps, 'buy', [999], () => ({ error: 'BAD_TARGET' }));
  assert.equal(recorder.record.events.length, count);
  sample.m.dispose();
});
test('timeline random access respects paused battle clocks and checkpoint sequence', () => {
  const field = { id: 'field', players: ['p'], at: 1000, endedAt: 7000, speed: 2, endGt: 8, pauses: [{ from: 2000, to: 4000 }], frames: [0, 2, 4, 6, 8].map((gt) => ({ gt, snap: {} })) };
  const record = { nodes: [{ at: 0, seq: 1, players: { p: { value: 'initial' } } }, { at: 5000, seq: 3, players: { p: { value: 'checkpoint' } } }], fields: [field],
    events: [{ at: 5000, seq: 2, playerId: 'p', state: { value: 'old' } }, { at: 6000, seq: 4, playerId: 'p', state: { value: 'new' } }] };
  assert.equal(floorIndex([], 0), -1);
  assert.equal(fieldFrame(field, 3000).gt, 2);
  assert.equal(fieldFrame(field, 4000).gt, 2);
  assert.equal(fieldFrame(field, 5000).gt, 4);
  assert.equal(stateAt(record, 5000, 'p').state.value, 'checkpoint');
  assert.equal(stateAt(record, 6000, 'p').state.value, 'new');
  assert.equal(stateAt(record, 7001, 'p').field, null);
  assert.equal(stateAt(record, 3000, 'p').field.id, 'field');
});
test('complete nine-round solo recording includes final boss and authoritative outcome', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-full-replay-'));
  const archive = new ReplayArchive(dir, quiet), h = makeMatch({ mode: 'solo', difficulty: 'FUNNY', clientCombat: true, seed: 280, captureFrames: false });
  h.m.recorder = archive.create(h.m);
  try {
    h.autoHumans(); h.start(); h.runToEnd();
    const ticket = h.lastTo('p_0', 'm.result').replay, record = await ready(archive, ticket);
    assert.equal(record.status, 'ready', JSON.stringify(record.errors));
    assert.equal(record.result.victory, true); assert.equal(record.fields.length, 9);
    const boss = record.fields.at(-1); assert.equal(boss.kind, 'boss');
    assert.ok(boss.controls.length > 0); assert.ok(boss.frames.length > 1);
    assert.ok(boss.meta.units.length > 0);
    assert.ok(record.fields.every((f) => f.frames.length > 1 && f.meta && Number.isFinite(f.endGt)));
    assert.ok(record.events.some((e) => e.type === 'reward'));
  } finally { h.m.dispose(); await archive.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('server-run mode captures actual frame tracks and excludes preview/rehearsal battles', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-server-replay-'));
  const archive = new ReplayArchive(dir, quiet), h = makeMatch({ mode: 'solo', clientCombat: false, instant: false, seed: 300, captureFrames: false });
  h.m.recorder = archive.create(h.m);
  try {
    h.autoHumans(); h.start(); h.run(() => h.m.phase === PHASE.SETTLE || h.ended);
    if (!h.ended) h.m.finish({ victory: false });
    const record = await ready(archive, h.lastTo('p_0', 'm.result').replay);
    assert.equal(record.status, 'ready', JSON.stringify(record.errors));
    assert.equal(record.fields.length, 1); assert.equal(record.fields[0].source, 'captured');
    assert.ok(record.fields[0].frames.length > 10);
    assert.ok(record.fields[0].meta.units.length > 0);
  } finally { h.m.dispose(); await archive.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('graceful disposal retains an interrupted summary without generating replay frames or live settlement', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-interrupted-'));
  const archive = new ReplayArchive(dir, quiet), h = makeMatch({ mode: 'solo', clientCombat: true, seed: 228 });
  h.m.recorder = archive.create(h.m);
  try {
    h.start(); h.toPrep(1);
    const ticket = h.m.recorder.ticket(); h.m.dispose();
    const record = await ready(archive, ticket);
    assert.equal(record.status, 'expired'); assert.equal(record.expiryReason, 'interrupted'); assert.equal(record.result.reason, 'interrupted'); assert.deepEqual(record.fields, []);
    assert.equal(h.lastTo('p_0', 'm.result'), null);
    assert.ok(record.nodes.length > 0);
  } finally { h.m.dispose(); await archive.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('replay HUD restores every player by identity and freezes original paused countdowns', () => {
  const record = { participants: [{ playerId: 'p1', seat: 0, name: 'same' }, { playerId: 'p2', seat: 1, name: 'same' }], fields: [], pauses: [{ from: 3000, to: 5000 }],
    nodes: [{ at: 1000, seq: 1, public: { phase: 'PREP', deadline: 160000, serverNow: 100000, players: [{ playerId: 'p1', lp: 12 }, { playerId: 'p2', lp: 9 }] },
      players: { p1: { private: { lp: 12, ready: false } }, p2: { private: { lp: 9, ready: false } } } }],
    events: [{ at: 2000, seq: 2, playerId: 'p2', state: { private: { lp: 8, ready: true } } }] };
  assert.equal(hudAt(record, 3000).remaining, 58);
  assert.equal(hudAt(record, 4000).remaining, 58);
  assert.equal(hudAt(record, 6000).remaining, 57);
  assert.equal(hudAt(record, 61000).remaining, 2);
  assert.equal(hudAt(record, 63000).remaining, 0);
  assert.deepEqual(hudAt(record, 2500).pub.players.map((p) => [p.playerId, p.lp, p.status]), [['p1', 12, 'acting'], ['p2', 8, 'ready']]);
  assert.equal(hudAt(record, 1000).pub.players[1].status, 'acting');
  record.nodes[0].public.deadline = 0;
  assert.equal(hudAt(record, 4000).remaining, null);
});

test('complete fourteen-round four-player replay stays under 100 MB without dropping frames', { timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-14-replay-'));
  const archive = new ReplayArchive(dir, quiet), h = makeMatch({ humans: 4, difficulty: 'NORMAL', clientCombat: true, seed: 280, captureFrames: false });
  h.m.recorder = archive.create(h.m);
  try {
    // Keep all four perspectives alive to exercise the maximum ordinary field count, even if the AI layout leaks.
    for (const ps of h.m.order) ps.lp = 10000;
    h.onSend.push((pid, msg) => { if (msg.t === 'm.private') h.m.players.get(pid).lp = 10000; });
    h.autoHumans(); h.start(); h.runToEnd();
    const ticket = h.lastTo('p_0', 'm.result').replay, r = await ready(archive, ticket);
    assert.equal(r.status, 'ready', JSON.stringify(r.errors)); assert.equal(r.nodes.at(-1).round, 14);
    assert.ok(r.fields.length >= 50); assert.ok(r.fields.every((f) => f.frames.length > 1 && f.frames.at(-1).gt >= f.endGt - .11));
    const bytes = fs.statSync(archive.file(ticket.id)).size; assert.ok(bytes < 100_000_000); t.diagnostic(`14 rounds / 4 players: ${bytes} bytes, ${r.fields.length} fields, ${r.fields.reduce((n, f) => n + f.frames.length, 0)} frames`);
  } finally { h.m.dispose(); await archive.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
