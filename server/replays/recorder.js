// Immutable match checkpoints, accepted decisions (including AI) and every battle input.
import { randomUUID, randomBytes } from 'node:crypto';
import { buildResult } from '../match/results.js';
import { buildBattleSpec, battleProgress } from '../sim/spec.js';

const clone = (x) => x == null ? x : JSON.parse(JSON.stringify(x));
const ACTIONS = { buy: 'buy', move: 'move', sell: 'sell', equip: 'equip', useArt: 'art', destroy: 'destroy', pickReward: 'reward', refresh: 'refresh', freeze: 'freeze', levelUp: 'level', setReady: 'ready' };
export class MatchRecorder {
  constructor(match, archive) {
    this.m = match; this.archive = archive; this.seq = 0; this.pauseStart = null; this.lastPaused = false; this.lastPhase = ''; this.closed = false;
    this.record = { v: 1, isMatchingMatch: !!match.isMatchingMatch, id: randomUUID(), key: randomBytes(24).toString('hex'), startedAt: Date.now(), durationMs: 0, version: archive.version, simulationVersion: archive.simulationVersion,
      matchPrivacy:!!match.matchPrivacy,
      ...(match.customConfig?{customConfig:clone(match.customConfig),customEvaluation:clone(match.customEvaluation),customRulesVersion:match.customRulesVersion,initialPlayerCount:match.initialPlayerCount,baselineKind:match.baselineKind,roomName:match.opts.roomName}:{}),
      participants: match.order.map(({ playerId, seat, name, isBot, doctorCode }) => ({ playerId, seat, name, isBot, doctorCode })),
      restrictions: { modeId: match.modeId, difficulty: match.difficulty, stageId: match.stageId, factions: clone(match.factions),
        disabledBonds: [...new Set([...match.disabledBonds, ...match.staticInactiveBonds])], drawnDisabledBonds: [...match.disabledBonds],
        bannedChess: [...match.bannedChess], staticInactiveBonds: [...match.staticInactiveBonds], mode: clone(match.gd.mode) },
      events: [], communications: [], nodes: [], fields: [], publicTrack: [], pauses: [], status: 'recording', result: null, errors: [] };
    archive.assignShare?.(this.record);
    for (const ps of match.order) for (const [method, type] of Object.entries(ACTIONS)) {
      const original = ps[method]; if (typeof original !== 'function') continue;
      ps[method] = (...args) => this.action(ps, type, args, () => original.apply(ps, args));
    }
    for (const [method, type] of [['_applyBand', 'band'], ['_applyCard', 'choice'], ['setLoadout', 'loadout']]) {
      const original = match[method];
      match[method] = (...args) => {
        const ps = typeof args[0] === 'string' ? match.players.get(args[0]) : args[0];
        return this.action(ps, type, args.slice(1), () => original.apply(match, args));
      };
    }
  }
  safe(fn) { try { return fn(); } catch (e) { this.record.errors.push(String(e.message)); this.m.log?.error?.('[replay] capture', e); return null; } }
  ticket() { return { id: this.record.id, key: this.record.key, shareCode: this.record.shareCode, startedAt: this.record.startedAt, expiresAt: this.record.expiresAt }; }
  at() { return Math.max(0, this.m.sched.now() - this.m.startedAt); }
  playerState(ps) { return { private: clone(ps.privateView()), field: clone(this.m.prepFieldMeta(ps)) }; }
  checkpoint() {
    if (this.closed) return;
    const paused = !!this.m.paused;
    if (paused !== this.lastPaused) {
      if (paused) { this.pauseStart = { from: this.at(), to: null }; this.record.pauses.push(this.pauseStart); }
      else if (this.pauseStart) this.pauseStart.to = this.at();
      this.lastPaused = paused;
    }
    const key = `${this.m.phase}:${this.m.round}`;
    if (this.closed || this.lastPhase === key) return;
    this.lastPhase = key;
    this.record.nodes.push({ at: this.at(), phase: this.m.phase, round: this.m.round, public: { ...clone(this.m.publicView()), replay: undefined }, seq: ++this.seq,
      players: Object.fromEntries(this.m.order.map((ps) => [ps.playerId, this.playerState(ps)])) });
  }
  action(ps, type, args, perform) {
    if (!ps || this.closed) return perform();
    const stamp = { at: this.at(), seq: ++this.seq, round: this.m.round, phase: this.m.phase, playerId: ps.playerId, type };
    const detail = this.safe(() => {
      const v = ps.privateView(), d = { args: clone(args) };
      if (type === 'buy') d.item = clone(v.shop.slots[args[0]]);
      if (type === 'reward') d.item = clone(v.shop.rewardOffer?.slots[args[0]]);
      if (type === 'choice') d.item = clone(this.m.sp?.cards[args[0]]);
      if (['move', 'sell', 'equip', 'destroy', 'art'].includes(type)) d.unit = clone([...v.board, ...v.hand, ...v.temp].filter(Boolean).find((u) => u.uid === args[0]));
      return d;
    });
    const alreadyPicked = type === 'band' ? !!this.m.draft?.picks[ps.playerId] : type === 'choice' ? this.m.sp?.picks[ps.playerId] != null : false;
    const out = perform();
    if (!out?.error && !alreadyPicked && !this.closed) this.safe(() => {
      if (type === 'band') detail.args[0] = ps.bandId;
      this.record.events.push({ ...stamp, detail, state: this.playerState(ps) });
      this.record.events.sort((a, b) => a.at - b.at || a.seq - b.seq);
      if (this.record.events.length > 20000) { this.record.errors.push('action-limit'); this.closed = true; }
    });
    return out;
  }
  field(f) {
    if (this.closed || this.record.fields.some((x) => x.id === f.battleId)) return;
    this.record.fields.push({ id: f.battleId, fieldId: f.fieldId, kind: f.kind, players: [...f.players], round: this.m.round,
      at: this.at(), speed: this.m.gameSpeed, spec: clone(f.spec), controls: [], endGt: null, result: null });
  }
  serverBattle(opts, battle) {
    if (opts.recordEvents === false || !opts.fieldId || opts.fieldId.startsWith('r:') || this.closed) return;
    const id = `${this.record.id}:${this.record.fields.length}`;
    const f = { battleId: id, fieldId: opts.fieldId, kind: opts.kind, players: (opts.players || []).map((p) => p.playerId),
      spec: buildBattleSpec({ ...opts, content: this.m.battleContent, boss: opts.sharedBoss ? { poolHp: opts.sharedBoss.hp, poolMax: opts.sharedBoss.maxHp } : null }) };
    this.field(f);
    const rec = this.record.fields.at(-1);
    // Server-run mode keeps the actual frames rather than re-simulating.
    rec.frames = []; rec.meta = null; rec.source = 'captured';
    const drain = battle.drainEvents?.bind(battle);
    if (drain) battle.drainEvents = (...args) => {
      const ev = drain(...args);
      this.safe(() => { if (!rec.meta) rec.meta = clone(battle.fieldMeta());
        rec.frames.push({ gt: battle.time, snap: clone(battle.snapshot()), progress: clone(battleProgress(battle)), ev: clone(ev) }); rec.endGt = battle.time; rec.endedAt = this.at(); });
      return ev;
    };
    const force = battle.forceEnd?.bind(battle);
    if (force) battle.forceEnd = (...args) => { const out = force(...args); rec.endGt = battle.time; return out; };
  }
  message(msg) {
    if (this.closed) return;
    if (msg?.t === 'm.communication') { this.record.communications.push({ ...clone(msg), at: this.at() }); return; }
    if (msg?.t === 'm.public') { this.record.publicTrack.push({ at: this.at(), public: { ...clone(msg), replay: undefined } }); return; }
    if (msg?.t !== 'b.pool') return;
    for (const f of this.record.fields.filter((x) => x.round === this.m.round && ['boss', 'hidden'].includes(x.kind))) {
      const live = this.m.fields.find((x) => x.battleId === f.id);
      const gt = live ? this.m._fieldElapsed(live) : Math.max(0, (this.at() - f.at) / 1000 * f.speed);
      const control = { gt, hp: msg.hp, acked: msg.acked?.[f.fieldId] };
      if (f.controls.at(-1)?.gt !== gt) f.controls.push(control);
    }
  }
  fieldDone(f) {
    const rec = this.record.fields.find((x) => x.id === f.battleId);
    if (rec) { rec.endedAt = this.at(); rec.endGt = f.result?.time ?? f.endGt ?? this.m._fieldElapsed(f); rec.result = clone(f.result); }
  }
  abort() {
    if (this.record.status !== 'recording') return;
    this.record.errors.push('match-interrupted');
    const result = buildResult(this.m, { victory: false, hiddenReached: this.m.hiddenReached, hiddenCleared: false, reason: 'interrupted' });
    this.record.result = clone({ ...result, restrictions: this.record.restrictions });
    this.record.endedAt = this.archive.now?.() ?? Date.now();
    this.closed = true; this.record.status = 'expired'; this.archive.expire(this.record, 'interrupted');
  }
  finish(result) {
    if (this.record.status !== 'recording') return;
    if (['abandoned', 'interrupted'].includes(result.reason)) {
      this.record.result = clone(result); this.record.endedAt = this.archive.now?.() ?? Date.now(); this.closed = true;
      this.record.status = 'expired'; this.archive.expire(this.record, 'interrupted'); return;
    }
    this.checkpoint();
    this.record.durationMs = this.at(); if (this.pauseStart?.to == null && this.pauseStart) this.pauseStart.to = this.at();
    for (const f of this.record.fields) { f.pauses = this.record.pauses.filter((p) => p.from >= f.at && p.from <= (f.endedAt ?? this.at())); if (f.endGt == null) { const live = this.m.fields.find((x) => x.battleId === f.id); f.endGt = live ? this.m._fieldElapsed(live) : 0; } } this.record.result = clone(result);
    this.record.endedAt = this.archive.now?.() ?? Date.now(); this.record.expiresAt = Number.isFinite(this.archive.ttlMs) ? this.record.endedAt + this.archive.ttlMs : 0;
    this.record.status = 'processing'; this.closed = true;
    this.archive.save(this.record, this.m.data);
    return this.ticket();
  }
}
