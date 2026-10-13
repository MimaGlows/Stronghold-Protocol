// Capability-protected, atomic compressed archives survive process restarts.
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { packRecord, unpackRecord } from './codec.js';
import { replayVersion } from './version.js';
import { MatchRecorder } from './recorder.js';
import { simulationVersion, playbackCompatibility } from './compatibility.js';
import { readTrackIndex, buildTrackIndex, readTrackChunk, trackDirectory } from './tracks.js';
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export class ReplayArchive {
  constructor(dir, log = console, { now = Date.now, version = replayVersion(), maxBytes = 100_000_000, ttlMs = Infinity,
    scanWorkerFactory = () => new Worker(new URL('./scan-worker.mjs', import.meta.url), { execArgv: [] }) } = {}) {
    this.simulationVersion = simulationVersion();
    this.now = now; this.version = version; this.maxBytes = maxBytes; this.ttlMs = ttlMs; this.dir = dir; this.log = log; this.shares = new Map(); this.revoked = new Set(); this.pending = new Map(); this.queue = []; this.worker = null; this.stopped = false;
    this.scanWorkerFactory = scanWorkerFactory; this.scanWorker = null; this.scanPromise = null;
    this.scanRevisions = new Map(); this.scanFailure = null;
    // Pending inputs are persisted as well: a process restart can resume a worker that did not finish.
    if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.inputs.gz'))) {
      try {
        const task = JSON.parse(gunzipSync(fs.readFileSync(path.join(dir, name))));
        let record;
        try { record = JSON.parse(gunzipSync(fs.readFileSync(this.file(task.record.id)))); }
        catch { record = task.record; this.write(record); }
        if (this.expired(record)) { this.expire(record); fs.rmSync(path.join(dir, name), { force: true }); }
        else if (record.status === 'processing' && this.generationCompatible(record)) {
          if (!record.shareCode) this.write(record); else this.assignShare(record);
          task.record.shareCode = record.shareCode; this.pending.set(record.id, task.record); this.queue.push(task);
        }
        else if (record.status === 'processing') { record.status='incompatible'; record.incompatibilityReason='generation-code'; this.write(record); }
        else if (record.status !== 'incompatible') fs.unlinkSync(path.join(dir, name));
      } catch (e) { this.log.error('[replay] recovery failed', e); }
    }
    this.ready = this.sweep(); this.ready.catch(() => {});
    this.sweepTimer = setInterval(() => { void this.sweep().catch(() => {}); }, 60_000); this.sweepTimer.unref();
    this.runNext();
  }
  create(match) { return new MatchRecorder(match, this); }
  metadata(id) { return ID.test(id || '') ? readTrackIndex(this,id) : null; }
  file(id) { return path.join(this.dir, `${id}.json.gz`); }
  writeBuffer(target, buffer) {
    if (buffer.length > this.maxBytes) throw new Error('replay-size-limit');
    fs.mkdirSync(this.dir, { recursive: true });
    const temp = target + '.tmp';
    try { fs.writeFileSync(temp, buffer); fs.renameSync(temp, target); this.scanRevisions.set(path.basename(target), (this.scanRevisions.get(path.basename(target)) || 0) + 1); }
    catch (e) { try { fs.rmSync(temp, { force: true }); } catch { /* preserve the original storage error */ } throw e; }
  }
  writeJson(target, obj) { this.writeBuffer(target, gzipSync(JSON.stringify(obj), { level: 9 })); }
  assignShare(record) {
    if (!/^[A-Za-z0-9_-]{16}$/.test(record.shareCode || '') || this.shares.has(record.shareCode) && this.shares.get(record.shareCode) !== record.id) {
      do { record.shareCode = randomBytes(12).toString('base64url'); } while (this.shares.has(record.shareCode));
    }
    this.shares.set(record.shareCode, record.id); return record.shareCode;
  }
  write(record) { this.assignShare(record); this.writeJson(this.file(record.id), record.encoding ? record : packRecord(record)); }
  save(record, data) {
    this.assignShare(record);
    const task = { record, data: Object.fromEntries(Object.entries(data).filter(([k]) => !['assets', 'local-assets'].includes(k))) };
    try {
      // Inputs own the full frames while processing; avoid storing the same tracks twice.
      const preview = { ...record, fields: record.fields.map(({ frames, ...field }) => { void frames; return field; }) };
      const inputBytes = gzipSync(JSON.stringify(task), { level: 9 }), previewBytes = gzipSync(JSON.stringify(packRecord(preview)), { level: 9 });
      if (inputBytes.length + previewBytes.length > this.maxBytes) throw new Error('replay-size-limit');
      this.writeBuffer(path.join(this.dir, `${record.id}.inputs.gz`), inputBytes);
      this.writeBuffer(this.file(record.id), previewBytes);
    }
    catch (e) { record.errors.push('archive-save-failed'); this.log.error('[replay] save failed', e); this.expire(record, 'size-limit'); return; }
    this.pending.set(record.id, record); this.queue.push(task); this.runNext();
  }
  runNext() {
    if (this.stopped || this.worker || !this.queue.length) return;
    const task = this.queue.shift();
    if (this.expired(task.record)) { this.expire(task.record); queueMicrotask(() => this.runNext()); return; }
    if (!this.generationCompatible(task.record)) { task.record.status='incompatible'; task.record.incompatibilityReason='generation-code'; this.write(task.record); this.pending.delete(task.record.id); queueMicrotask(() => this.runNext()); return; }
    let worker;
    try { worker = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: task, execArgv: [] }); }
    catch (e) { task.record.status = 'partial'; task.record.errors.push(String(e.message)); this.pending.set(task.record.id, task.record); try { this.write(task.record); } catch { /* retain in memory */ } queueMicrotask(() => this.runNext()); return; }
    this.worker = worker; this.workerRecordId = task.record.id;
    let done = false;
    const complete = (record) => {
      if (done || this.stopped) return; done = true;
      try {
        if (this.revoked.has(record.id)) return;
        if (this.expired(record)) { this.expire(record); return; }
        // Replace the processing inputs with the final compressed track, within the same disk budget.
        const packed = gzipSync(JSON.stringify(packRecord(record)), { level: 9 });
        if (packed.length > this.maxBytes) { this.expire(record, 'size-limit'); return; }
        const input = path.join(this.dir, `${record.id}.inputs.gz`);
        if (packed.length + (fs.existsSync(input) ? fs.statSync(input).size : 0) > this.maxBytes) { this.expire(record, 'size-limit'); return; }
        this.writeBuffer(this.file(record.id), packed); this.pending.delete(record.id); fs.rmSync(input, { force: true });
      }
      catch (e) { record.status = 'partial'; record.errors.push('archive-write-failed'); this.pending.set(record.id, record); this.log.error('[replay] write failed', e); }
    };
    const timeout = setTimeout(() => { task.record.status = 'partial'; task.record.errors.push('worker-timeout'); complete(task.record); void worker.terminate(); }, 10 * 60 * 1000); timeout.unref();
    worker.once('message', complete);
    worker.once('error', (e) => { task.record.status = 'partial'; task.record.errors.push(String(e.message)); complete(task.record); });
    worker.once('exit', () => { clearTimeout(timeout); if (!done) { task.record.status = 'partial'; task.record.errors.push('worker-interrupted'); complete(task.record); } this.worker = null; this.workerRecordId = null; this.runNext(); });
  }
  get(id, key, { summaryOnly = false, tracks = false, field = null, chunk = null } = {}) {
    if (!ID.test(id) || !/^[a-f0-9]{48}$/.test(key || '')) return null;
    let record = this.pending.get(id) || (tracks || summaryOnly ? this.metadata(id) : null);
    if (!record) try { record = JSON.parse(gunzipSync(fs.readFileSync(this.file(id)))); } catch { return null; }
    if (!record.key || record.key.length !== key.length || !timingSafeEqual(Buffer.from(record.key), Buffer.from(key))) return null;
    if (!record.shareCode) this.write(record);
    if (this.expired(record)) record = this.expire(record);
    const incompatible = record.status !== 'expired' && playbackCompatibility(record);
    if (incompatible) record={...record,status:'incompatible',incompatibilityReason:incompatible};
    if (tracks && !summaryOnly && ['ready','partial'].includes(record.status)) {
      if (!record.trackMode) record=buildTrackIndex(this,record);
      if (field !== null || chunk !== null) return readTrackChunk(this,record,field,chunk);
    }
    const { key: secret, ...safe } = summaryOnly ? { ...record, fields: [], events: [], communications: [], publicTrack: [], pauses: [], nodes: record.nodes?.length ? [{ ...record.nodes.at(-1), players: {} }] : [] } : record.trackMode ? record : unpackRecord(record); void secret; return safe;
  }
  getShared(code, options) {
    if (!/^[A-Za-z0-9_-]{16}$/.test(code || '')) return null;
    const id = this.shares.get(code); if (!id) return null;
    let record = this.pending.get(id) || (options?.tracks || options?.summaryOnly ? this.metadata(id) : null);
    if (!record) try { record = JSON.parse(gunzipSync(fs.readFileSync(this.file(id)))); } catch { return null; }
    if (record.shareCode !== code) return null;
    return this.get(id, record.key, options);
  }
  generationCompatible(record) {
    // A legacy content fingerprint is known only for the deployed v0.2.3 simulation.
    // Ready frames use playbackCompatibility; this guards regeneration of archived inputs.
    return record.simulationVersion ? record.simulationVersion === this.simulationVersion
      : record.version === this.version || (record.version === '4dc8f887537e1e9effeb' && this.simulationVersion === 'acdd070fcac25c9c824d');
  }
  expired(record) { return record.status !== 'expired' && Number.isFinite(this.ttlMs) && this.now() >= (record.expiresAt || record.startedAt + this.ttlMs); }
  expire(record, reason = 'time') {
    if (!ID.test(record.id)) throw new Error('invalid replay id');
    this.revoked.add(record.id);
    if (this.workerRecordId === record.id) void this.worker?.terminate();
    const summary = { ...record, status: 'expired', expiryReason: reason, communications: [], fields: [], events: [], publicTrack: [], pauses: [], nodes: record.nodes?.length ? [{ ...record.nodes.at(-1), players: {} }] : [] };
    fs.rmSync(path.join(this.dir, `${record.id}.inputs.gz`), { force: true });
    this.pending.delete(record.id); this.queue = this.queue.filter((t) => t.record.id !== record.id);
    fs.rmSync(trackDirectory(this,record.id),{recursive:true,force:true});
    try { this.write(summary); } catch (e) { this.log.error('[replay] expiry failed', e); }
    return summary;
  }
  sweep() {
    if (this.stopped) return Promise.resolve();
    if (this.scanPromise) return this.scanPromise;
    const revisions = new Map(this.scanRevisions), checkedAt = this.now();
    const promise = new Promise((resolve, reject) => {
      let worker, timer;
      const clean = () => { clearTimeout(timer); worker?.removeListener('message', receive); worker?.removeListener('error', fail); worker?.removeListener('exit', exited); this.scanFailure = null; };
      const fail = (error) => {
        clean(); if (this.scanWorker === worker) this.scanWorker = null;
        void worker?.terminate();
        if (!this.stopped) this.log.error('[replay] scan failed', error);
        reject(error);
      };
      const exited = () => fail(new Error('replay-scan-worker-exited'));
      const receive = (result) => {
        if (result.error) { fail(new Error(result.error)); return; }
        try {
          if (this.stopped) { clean(); resolve(undefined); return; }
          const report = { checkedAt, build: this.version, simulationVersion: this.simulationVersion, counts: {}, entries: [],
            scan: { durationMs: result.durationMs, inspected: result.inspected, cacheHits: result.cacheHits, errors: result.errors.length, logicVersion: result.logicVersion } };
          const accepted = new Set();
          for (const entry of result.entries) {
            if ((revisions.get(entry.file) || 0) !== (this.scanRevisions.get(entry.file) || 0)) continue;
            let stat; try { stat = fs.statSync(path.join(this.dir, entry.file)); } catch { continue; }
            if (stat.size !== entry.fingerprint.size || stat.mtimeMs !== entry.fingerprint.mtimeMs || stat.ctimeMs !== entry.fingerprint.ctimeMs) continue;
            if (this.shares.has(entry.shareCode) && this.shares.get(entry.shareCode) !== entry.id) continue;
            if (entry.expiryRecord) this.expire(entry.expiryRecord);
            else if (entry.replacement) this.writeBuffer(path.join(this.dir, entry.file), entry.replacement);
            for (const [code, id] of this.shares) if (id === entry.id && code !== entry.shareCode) this.shares.delete(code);
            this.shares.set(entry.shareCode, entry.id); accepted.add(entry.id);
            const status = entry.reason && ['ready', 'partial', 'processing'].includes(entry.status) ? 'incompatible' : entry.status;
            report.counts[status] = (report.counts[status] || 0) + 1; report.entries.push({ id: entry.id, status, reason: entry.reason });
          }
          for (const [code, id] of this.shares) if (!accepted.has(id) && !this.pending.has(id) && !fs.existsSync(this.file(id))) this.shares.delete(code);
          for (const error of result.errors) this.log.error('[replay] scan file failed', error.file, error.message);
          this.writeJson(path.join(this.dir, 'compatibility-report.gz'), report);
          this.compatibilityReport = report;
          this.log.info?.('[replay] scan', JSON.stringify(report.scan));
          clean(); resolve(report);
        } catch (error) { fail(error); }
      };
      try {
        if (!this.scanWorker) {
          this.scanWorker = this.scanWorkerFactory();
          const created = this.scanWorker;
          created.on('error', () => {}); // The active request logs failures; idle exits are retried.
          created.once('exit', () => { if (this.scanWorker === created) this.scanWorker = null; });
        }
        worker = this.scanWorker;
        worker.once('message', receive); worker.once('error', fail); worker.once('exit', exited);
        this.scanFailure = fail;
        timer = setTimeout(() => fail(new Error('replay-scan-timeout')), 120_000); timer.unref();
        worker.postMessage({ dir: this.dir, now: checkedAt, version: this.version, simulationVersion: this.simulationVersion, ttlMs: this.ttlMs });
      } catch (error) { fail(error); }
    });
    this.scanPromise = promise;
    void promise.finally(() => { if (this.scanPromise === promise) this.scanPromise = null; }).catch(() => {});
    return promise;
  }
  async close() {
    clearInterval(this.sweepTimer); this.stopped = true;
    const scanWorker = this.scanWorker;
    this.scanFailure?.(new Error('replay-scan-closed'));
    await Promise.all([this.worker?.terminate(), scanWorker?.terminate()]); this.scanWorker = null;
  }
}
