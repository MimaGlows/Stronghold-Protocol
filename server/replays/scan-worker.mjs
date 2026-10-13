// Read-only archive inspection. Only compact metadata is retained between scans.
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';
import { parentPort } from 'node:worker_threads';
import { playbackCompatibility } from './compatibility.js';
import { packRecord } from './codec.js';

const logicVersion = createHash('sha256')
  .update(fs.readFileSync(new URL('./scan-worker.mjs', import.meta.url)))
  .update(fs.readFileSync(new URL('./compatibility.js', import.meta.url))).digest('hex');
const cache = new Map();
const stamp = (s) => ({ size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs });
const same = (a, b) => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const compatibleGeneration = (r, job) => r.simulationVersion ? r.simulationVersion === job.simulationVersion
  : r.version === job.version || (r.version === '4dc8f887537e1e9effeb' && job.simulationVersion === 'acdd070fcac25c9c824d');

parentPort.on('message', (job) => {
  try {
    const started = Date.now(), entries = [], errors = [], seen = new Set(), shares = new Map();
    let inspected = 0, cacheHits = 0;
    const files = fs.existsSync(job.dir) ? fs.readdirSync(job.dir).filter((f) => f.endsWith('.json.gz')).sort() : [];
    for (const file of files) {
      seen.add(file);
      try {
        const target = path.join(job.dir, file), fingerprint = stamp(fs.statSync(target));
        let cached = cache.get(file), record = null, replacement = null, expiryRecord = null;
        const expired = (r) => r.status !== 'expired' && Number.isFinite(job.ttlMs) && job.now >= (r.expiresAt || r.startedAt + job.ttlMs);
        if (cached && same(cached.fingerprint, fingerprint) && !expired(cached.meta)
          && /^[A-Za-z0-9_-]{16}$/.test(cached.meta.shareCode || '') && !shares.has(cached.meta.shareCode)) cacheHits++;
        else {
          inspected++;
          record = JSON.parse(gunzipSync(fs.readFileSync(target)));
          if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(record.id || '') || `${record.id}.json.gz` !== file) throw new Error('archive-id');
          if (!same(fingerprint, stamp(fs.statSync(target)))) { cache.delete(file); continue; }
          if (expired(record)) {
            expiryRecord = { ...record, status: 'expired', expiryReason: 'time', communications: [], fields: [], events: [], publicTrack: [], pauses: [],
              nodes: record.nodes?.length ? [{ ...record.nodes.at(-1), players: {} }] : [] };
            record = expiryRecord;
          }
          if (!/^[A-Za-z0-9_-]{16}$/.test(record.shareCode || '') || shares.has(record.shareCode)) {
            do { record.shareCode = randomBytes(12).toString('base64url'); } while (shares.has(record.shareCode));
            // Prepare bytes here; the owner alone decides whether this version may be committed.
            const bytes = gzipSync(JSON.stringify(record.encoding ? record : packRecord(record)), { level: 9 });
            replacement = Uint8Array.from(bytes);
          }
          const reason = ['ready', 'partial'].includes(record.status) ? playbackCompatibility(record)
            : record.status === 'processing' && !compatibleGeneration(record, job) ? 'generation-code' : record.expiryReason || record.incompatibilityReason || null;
          const meta = { id: record.id, shareCode: record.shareCode, status: record.status, reason,
            startedAt: record.startedAt, expiresAt: record.expiresAt };
          cached = { fingerprint, meta }; cache.set(file, cached);
        }
        shares.set(cached.meta.shareCode, cached.meta.id);
        entries.push({ file, fingerprint, ...cached.meta, replacement, expiryRecord });
      } catch (e) { cache.delete(file); errors.push({ file, message: String(e.message) }); }
    }
    for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file);
    const transfers = entries.filter((e) => e.replacement).map((e) => e.replacement.buffer);
    parentPort.postMessage({ entries, errors, inspected, cacheHits, logicVersion, durationMs: Date.now() - started }, transfers);
  } catch (e) { parentPort.postMessage({ error: String(e.message) }); }
});
