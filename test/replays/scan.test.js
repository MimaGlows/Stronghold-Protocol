import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ReplayArchive } from '../../server/replays/archive.js';

const quiet = { error() {}, info() {} };
const record = () => ({ v: 1, id: randomUUID(), key: 'a'.repeat(48), version: 'old-ui', status: 'ready',
  startedAt: 1, expiresAt: 100, result: { victory: true }, nodes: [], fields: [], events: [], publicTrack: [], errors: [] });
async function archive(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-scan-'));
  const a = new ReplayArchive(dir, quiet, options);
  t.after(async () => { await a.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await a.ready; return a;
}

test('unchanged archives hit compact cache; modifications, deletion and corruption are detected', async (t) => {
  const a = await archive(t), r = record(); a.write(r);
  let report = await a.sweep(); assert.equal(report.scan.inspected, 1); assert.equal(report.counts.ready, 1);
  report = await a.sweep(); assert.equal(report.scan.inspected, 0); assert.equal(report.scan.cacheHits, 1);
  r.status = 'partial'; a.write(r);
  report = await a.sweep(); assert.equal(report.scan.inspected, 1); assert.equal(report.counts.partial, 1);
  fs.writeFileSync(a.file(r.id), 'corrupt');
  report = await a.sweep(); assert.equal(report.scan.errors, 1); assert.equal(report.entries.length, 0);
  fs.unlinkSync(a.file(r.id)); report = await a.sweep();
  assert.equal(report.entries.length, 0); assert.equal(a.getShared(r.shareCode), null);
});

test('cached finite TTL expires at its deadline and preserves results and share code', async (t) => {
  let now = 5; const a = await archive(t, { now: () => now, ttlMs: 100 }), r = record(); a.write(r);
  await a.sweep(); now = 100; const report = await a.sweep();
  assert.equal(report.counts.expired, 1);
  const expired = a.getShared(r.shareCode); assert.equal(expired.expiryReason, 'time');
  assert.deepEqual(expired.result, r.result); assert.deepEqual(expired.fields, []);
});

test('cold readiness rebuilds share index without changing compatible archive bytes', async (t) => {
  const a = await archive(t), r = record(); a.write(r); const before = fs.readFileSync(a.file(r.id));
  await a.close(); const b = new ReplayArchive(a.dir, quiet); t.after(() => b.close()); await b.ready;
  assert.deepEqual(b.getShared(r.shareCode).result, r.result);
  assert.deepEqual(fs.readFileSync(b.file(r.id)), before);
});

class ControlledWorker extends EventEmitter {
  postMessage(job) { this.job = job; }
  terminate() { this.terminated = true; return Promise.resolve(0); }
}
const result = (entries = []) => ({ entries, errors: [], inspected: entries.length, cacheHits: 0, durationMs: 1, logicVersion: 'test' });
test('single flight ignores stale results after write or deletion; close aborts pending work', async (t) => {
  const worker = new ControlledWorker(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-scan-race-'));
  const a = new ReplayArchive(dir, quiet, { scanWorkerFactory: () => worker });
  t.after(async () => { await a.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  worker.emit('message', result()); await a.ready;
  const r = record(); a.write(r); const s = fs.statSync(a.file(r.id));
  const entry = { file: `${r.id}.json.gz`, fingerprint: { size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs },
    id: r.id, shareCode: r.shareCode, status: 'ready', reason: null };
  const first = a.sweep(); assert.equal(a.sweep(), first);
  r.status = 'partial'; a.write(r); worker.emit('message', result([entry]));
  assert.equal((await first).entries.length, 0); assert.equal(a.get(r.id, r.key).status, 'partial');
  const second = a.sweep(); fs.unlinkSync(a.file(r.id)); worker.emit('message', result([entry]));
  assert.equal((await second).entries.length, 0);
  const pending = a.sweep(), rejected = assert.rejects(pending, /closed/); await a.close(); await rejected;
  assert.equal(worker.terminated, true);
});

test('worker failure retains report and retries through a new worker', async (t) => {
  const workers = [], dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-scan-failure-'));
  const a = new ReplayArchive(dir, quiet, { scanWorkerFactory: () => { const w = new ControlledWorker(); workers.push(w); return w; } });
  t.after(async () => { await a.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  workers[0].emit('message', result()); await a.ready; const previous = a.compatibilityReport;
  const failed = a.sweep(), rejected = assert.rejects(failed, /failure/); workers[0].emit('error', new Error('failure')); await rejected;
  assert.equal(a.compatibilityReport, previous); assert.equal(workers[0].terminated, true);
  const retry = a.sweep(); workers[1].emit('message', result()); await retry;
  assert.equal(workers.length, 2);
});
