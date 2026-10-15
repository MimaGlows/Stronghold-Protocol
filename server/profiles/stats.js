// Server-owned statistics. Account identity is established by the existing session, never by a client write.
import { privacyRecord } from '../../shared/matchPrivacy.js';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHmac, randomUUID } from 'node:crypto';
import { buildRecord, buildQuitRecord, aggregateStats, compactRecord, MAX_RECORDS, FULL_KEEP } from '../../shared/stats.js';

export class AccountStats {
  constructor(profiles, archive, log = console) {
    this.profiles = profiles; this.archive = archive; this.log = log;
    this.migrate();
    if (archive) { archive.getAccount = (id, key, owner, options) => this.getReplay(id, key, owner, options); this.retain(); }
  }
  owner(profile) { return path.basename(this.profiles.file(profile.name, profile.code), '.json'); }
  allProfiles() {
    if (!fs.existsSync(this.profiles.dir)) return [];
    return fs.readdirSync(this.profiles.dir).filter((f) => /^[a-f0-9]{64}\.json$/.test(f)).map((f) => {
      const p = JSON.parse(fs.readFileSync(path.join(this.profiles.dir, f), 'utf8'));
      return this.profiles.read(p.name, p.code);
    });
  }
  rawArchive(id) {
    if (!this.archive || !/^[a-f0-9-]{36}$/.test(id || '')) return null;
    try { return JSON.parse(gunzipSync(fs.readFileSync(this.archive.file(id)))); } catch { return null; }
  }
  migrate() {
    const profiles = this.allProfiles().filter((p) => p.statistics?.v !== 1);
    if (!profiles.length) return;
    const migrated = new Map(profiles.map((p) => [p, []]));
    const files = this.archive && fs.existsSync(this.archive.dir) ? fs.readdirSync(this.archive.dir).filter((f) => f.endsWith('.json.gz')) : [];
    // Read one replay at a time. Full combat tracks must never accumulate across the archive.
    for (const file of files) {
      const a = this.rawArchive(file.slice(0, -8));
      if (!a) continue;
      for (const p of profiles) {
        const records = migrated.get(p);
        const who = a.participants?.find((x) => !x.isBot && x.name === p.name && x.doctorCode === p.code);
        if (!who || !a.result?.players?.length) continue;
        const rec = buildRecord(a.result, { myId: who.playerId, now: a.endedAt || a.startedAt });
        if (!rec) continue;
        rec.id = a.id;
        const self = a.result.players.find((x) => x.playerId === who.playerId);
        if (self?.left || ['abandoned', 'interrupted'].includes(a.result.reason)) {
          rec.end = 'quit'; rec.reason = a.result.reason || 'quit'; rec.victory = false;
          rec.players = rec.players.filter((x) => x.playerId === rec.selfId).map((x) => ({ ...x, victory: false, title: null, stats: {}, lineup: [], bonds: [] }));
        }
        if (rec.end !== 'quit') rec.replay = this.ticket(p, a);
        records.push(rec);
      }
    }
    for (const p of profiles) {
      const records = migrated.get(p);
      // Missing legacy bodies still leave an account-owned list entry; never fabricate combat totals.
      for (const entry of p.history || []) {
        if (records.some((r) => r.id === entry.id)) continue;
        const result = entry.result || {};
        const rec = buildRecord({ ...result, modeId: entry.modeId, difficulty: entry.difficulty, players: result.players?.length ? result.players : [{ playerId: entry.playerId, name: p.name }] }, { myId: entry.playerId, now: entry.startedAt });
        if (rec) { rec.id = entry.id; if (!entry.ended) { rec.end = 'quit'; rec.reason = 'interrupted'; rec.roundsPassed = null; rec.players[0].roundsPassed = null; } records.push(rec); }
      }
      p.statistics = { v: 1, revision: 1, records: this.bound(records) };
      this.profiles.save(p);
    }
  }
  ticket(p, a) {
    const owner = this.owner(p);
    return { id: a.id, owner, key: createHmac('sha256', a.key).update(owner).digest('hex').slice(0, 48), playerId: a.participants?.find((x) => x.name === p.name && x.doctorCode === p.code)?.playerId, shareCode: a.shareCode };
  }
  bound(records) {
    return records.sort((a, b) => b.t - a.t || a.id.localeCompare(b.id)).slice(0, MAX_RECORDS).map((r, i) => i < FULL_KEEP ? r : { ...compactRecord(r), ...(r.replay ? { replay: { ...r.replay, expired: true } } : {}) });
  }
  read(profile) { return this.profiles.read(profile.name, profile.code) || profile; }
  put(profile, rec) {
    const p = this.read(profile), stats = p.statistics || { v: 1, revision: 0, records: [] };
    if (stats.records.some((r) => r.id === rec.id)) return p; // quit and settled are terminal, even when onEnd is replayed
    p.statistics = { v: 1, revision: stats.revision + 1, records: this.bound([rec, ...stats.records]) };
    this.profiles.save(p); this.retain(); return p;
  }
  start(ctx, match, now) { ctx.statsId = match.recorder?.record.id || randomUUID(); ctx.statsStartedAt = now; }
  quit(ctx, playerId, reason = 'quit') {
    const owner = ctx.profiles.find((x) => x.playerId === playerId), m = ctx.match;
    if (!owner || !m || m.ended || !m.publicView || !m.players || !m.sched) return;
    const ps = m.players.get(playerId);
    const rec = buildQuitRecord({ me: { playerId }, room: { mode: m.mode }, match: { public: m.publicView(), result: null } },
      { live: { active: true, startedAt: ctx.statsStartedAt, sawStart: true, aliveRound: ps?.eliminatedRound || m.round }, now: ctx.statsStartedAt + m.sched.now() - m.startedAt });
    if (rec) {
      rec.id = ctx.statsId; rec.reason = reason;
      // Public hidden-war projections deliberately omit required bonds; archive the authoritative configuration.
      if(m.customConfig)Object.assign(rec,{customConfig:m.customConfig,customEvaluation:m.customEvaluation,customRulesVersion:m.customRulesVersion,initialPlayerCount:m.initialPlayerCount,baselineKind:m.baselineKind,roomName:m.opts.roomName});
      if (ctx.matching) rec.isMatchingMatch = true;
      owner.profile = this.put(owner.profile, rec);
    }
  }
  settle(ctx, summary) {
    for (const owner of ctx.profiles) {
      const rec = buildRecord({ ...summary, isMatchingMatch: !!ctx.matching }, { myId: owner.playerId, roomMode: ctx.match.mode, now: ctx.statsStartedAt + ctx.match.sched.now() - ctx.match.startedAt });
      if (!rec) continue;
      rec.id = ctx.statsId;
      if (rec.players.find((p) => p.playerId === owner.playerId)?.left) continue;
      rec.isMatchingMatch = !!ctx.matching;
      const a = summary.replay && (this.archive.pending.get(summary.replay.id) || this.rawArchive(summary.replay.id));
      if (a) rec.replay = this.ticket(owner.profile, a);
      owner.profile = this.put(owner.profile, rec);
    }
  }
  snapshot(profile, offset = 0) {
    const p = this.read(profile), s = p.statistics || { v: 1, revision: 0, records: [] };
    // Compact list rows are bounded; full settlement/player arrays travel through the existing replay HTTP endpoint.
    const records = []; let bytes = 0;
    for (const r of s.records.slice(offset, offset + 50)) {
      const row = { ...privacyRecord(compactRecord(r)), compact: r.compact === true, ...(r.replay ? { replay: r.replay } : {}) };
      const size = Buffer.byteLength(JSON.stringify(row)); if (records.length && bytes + size > 40_000) break;
      records.push(row); bytes += size;
    }
    return { profileKey: `${p.name}#${p.code}`, revision: s.revision, total: s.records.length, aggregate: aggregateStats(s.records), records, offset, next: offset + records.length < s.records.length ? offset + records.length : null };
  }
  retain() {
    if (!this.archive) return;
    const eligible = new Set(this.allProfiles().flatMap((p) => (p.statistics?.records || []).slice(0, FULL_KEEP).filter((r) => r.end !== 'quit' && r.replay && !r.replay.expired).map((r) => r.id)));
    if (!fs.existsSync(this.archive.dir)) return;
    for (const f of fs.readdirSync(this.archive.dir).filter((x) => x.endsWith('.json.gz'))) {
      const a = this.rawArchive(f.slice(0, -8));
      if (a && a.status !== 'expired' && !eligible.has(a.id)) this.archive.expire(a, 'retention');
    }
  }
  getReplay(id, key, owner, options) {
    if (!/^[a-f0-9]{64}$/.test(owner || '')) return null;
    let p; try { p = JSON.parse(fs.readFileSync(path.join(this.profiles.dir, `${owner}.json`), 'utf8')); } catch { return null; }
    const row = p.statistics?.records.find((r) => r.id === id && r.replay?.key === key);
    if (!row || row.end === 'quit') return null;
    const a = this.archive.pending.get(id) || ((options?.tracks || options?.summaryOnly) && this.archive.metadata(id)) || this.rawArchive(id); if (!a) return null;
    const record = this.archive.get(id, a.key, row.replay.expired ? { summaryOnly: true } : options);
    return record && row.replay.expired ? { ...record, status: 'expired', expiryReason: 'retention' } : record;
  }
}
