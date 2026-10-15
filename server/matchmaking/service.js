import { createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { ERR } from '../../shared/constants.js';
import { MATCH_RECONNECT_MS, validPreference, matchingIdentity } from '../../shared/matchmaking.js';
import { sendSession } from '../net.js';
import { MatchingStore } from './store.js';
import { defaultCallsignFilter } from './sensitive.js';
import { MatchingParties } from './parties.js';
import { N_ } from '../../shared/i18n.js';

const ok = { ok: true };
const fail = (error) => ({ error });
export class MatchmakingService {
  constructor(lobby) {
    this.lobby = lobby;
    this.store = new MatchingStore();
    this.timers = new Map();
    this.reconnectTimers = new Map();
    this.sequence = 0;
    this.referenceSecret = randomBytes(32); this.references = new Map(); this.parties = new MatchingParties(this);
  }
  configure(dir) { this.store = new MatchingStore(dir); }
  identity(session) { return matchingIdentity(session?.profile); }
  rules(room) { return !!(room && (room.matchmaking || room.queueGenerated || (!!room.match && !!room.matchCtx?.matching))); }
  partyForIdentity(session) { const id=this.identity(session); return [...this.parties.parties.values()].find((p)=>p.members.some((m)=>m.identity===id)); }
  restricted(session) {
    if (this.rules(this.lobby.roomOf(session)) || !!this.partyForIdentity(session)) return true;
    const id=this.identity(session);
    return !!id && [...this.lobby.registry.all()].some((s)=>this.identity(s)===id && this.rules(this.lobby.roomOf(s)));
  }
  clearInvalidPreference(session, difficulty) {
    if (!session) return;
    const id = this.identity(session), preference = this.store.get(id).preference || null;
    if (!validPreference(this.lobby.safeData(), difficulty, preference)) {
      this.store.edit(id, (a) => { a.preference = null; });
      sendSession(session, { t: 'm.toast', kind: 'warn', text: N_('切换难度后，原阵营偏好不可用，已清空') }); this.state(session);
    }
  }
  reference(identity){const ref='ref:'+createHmac('sha256',this.referenceSecret).update(identity).digest('hex').slice(0,32);this.references.set(ref,identity);return ref;}
  state(session) {
    const identity = this.identity(session);
    if (!identity) return;
    const a = this.store.get(identity);
    sendSession(session, { t: 'matching.state', identity, selfReference:this.reference(identity), blocks: a.blocks.map(id=>this.reference(id)), blockLabels:Object.fromEntries(a.blocks.map(id=>[this.reference(id),id.replace(/#\d{4}$/,'')])) , bannedUntil: a.bannedUntil, preference: a.preference || null, party: this.parties.view(this.parties.of(session)||this.partyForIdentity(session)), restricted: this.restricted(session), serverNow: this.lobby.now() });
  }
  checkSession(session, difficulty, preference = null) {
    const identity = this.identity(session);
    if (!identity) return fail(ERR.MATCH_ACCOUNT);
    if (!defaultCallsignFilter().check(session.profile.name)) return fail(ERR.MATCH_NAME);
    if (this.store.get(identity).bannedUntil > this.lobby.now()) return fail(ERR.MATCH_BANNED);
    if (!validPreference(this.lobby.safeData(), difficulty, preference)) return fail(ERR.MATCH_PREFERENCE);
    return ok;
  }
  checkRoom(room, ready = true, excluded = new Set()) {
    const humans = room.activeHumans().filter((s) => !excluded.has(s.playerId));
    const identities = [];
    for (const seat of humans) {
      const session = this.lobby.registry.byId(seat.playerId);
      if (!session?.connected || (ready && seat.playerId !== room.hostId && !seat.ready)) return fail(ERR.NOT_READY);
      if (ready && room.matchmaking && !seat.preferenceSelected) return fail(ERR.MATCH_PREFERENCE);
      const checked = this.checkSession(session, room.difficulty, seat.preference);
      if (checked.error) { this.state(session); return checked; }
      const identity = this.identity(session);
      if (identities.some((other) => this.store.blocked(identity, other))) return fail(ERR.MATCH_BLOCKED);
      identities.push(identity);
    }
    return humans.length ? ok : fail(ERR.NOT_READY);
  }
  handle(session, msg) {
    try {
      if (msg.t === 'matching.sync') { this.state(session); return ok; }
      const identity = this.identity(session);
      if (!identity) return fail(ERR.MATCH_ACCOUNT);
      if (msg.t === 'matching.block') {
        const error = this.store.block(identity, this.references.get(msg.identity)||msg.identity, msg.matchId);
        this.state(session); return error ? fail(error) : ok;
      }
      if (msg.t === 'matching.unblock') {
        this.store.edit(identity, (a) => { a.blocks = a.blocks.filter((id) => id !== (this.references.get(msg.identity)||msg.identity)); });
        this.state(session); return ok;
      }
      if (msg.t === 'matching.create' || msg.t === 'matching.timeoutChoice') return fail(ERR.MATCH_STALE);
      if (msg.t === 'matching.setEnabled') return this.setEnabled(session, msg);
      if (msg.t === 'matching.roomPrepare') return this.roomPrepare(session, msg);
      if (msg.t === 'matching.preference') {
        const room = this.lobby.roomOf(session), p = this.parties.of(session), otherParty=this.partyForIdentity(session);
        if (room) return fail(ERR.MATCH_LOCKED);
        if (room?.match || this.lobby.social.playingElsewhere(session,null) || (otherParty && otherParty.phase !== 'idle')) return fail(ERR.MATCH_LOCKED);
        const difficulty = p?.difficulty || msg.difficulty;
        if (!difficulty || !validPreference(this.lobby.safeData(), difficulty, msg.bond)) return fail(ERR.MATCH_PREFERENCE);
        if (p && (msg.revision !== p.revision || msg.partyId !== p.id)) return fail(ERR.MATCH_STALE);
        this.store.edit(identity, (a) => { a.preference = msg.bond; });
        if (p) { p.members.find((m) => m.playerId === session.playerId).ready = false; this.parties.publish(p); } else this.state(session);
        return ok;
      }
      return this.parties.handle(session, msg);
    } catch (error) {
      this.lobby.log.error('[matching] request failed', error);
      return fail(ERR.INTERNAL);
    }
  }
  setEnabled(session, { on, bond, revision }) {
    const room = this.lobby.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match || room.queueGenerated) return fail(ERR.MATCH_LOCKED);
    if (room.mode !== 'coop') return fail(ERR.BAD_TARGET);
    if (revision !== room.matchingRevision) return fail(ERR.MATCH_STALE);
    if (on === room.matchmaking) return ok;
    const rejected = new Set();
    if (on) {
      if (room.seats.some((s) => s?.isBot)) return fail(ERR.MATCH_BOTS);
      if (bond === undefined) return fail(ERR.MATCH_PREFERENCE);
      const hostCheck = this.checkSession(session, room.difficulty, bond);
      if (hostCheck.error) return hostCheck;
      for (const seat of room.activeHumans()) {
        const member = this.lobby.registry.byId(seat.playerId);
        if (member?.profile && !defaultCallsignFilter().check(member.profile.name)) rejected.add(seat.playerId);
      }
      const checked = this.checkRoom(room, false, rejected); if (checked.error) return checked;
    }
    const newCode = on ? null : this.lobby.genCode();
    if (!on && !newCode) return fail(ERR.INTERNAL);
    const returned = on ? null : this.parties.detachBackfilled(room);
    if (room.disposed) { if (returned) this.parties.resumeBackfilled(returned); this.parties.pump(); return ok; }
    this.lobby.revokeShare(room);
    room.matchmaking = on;
    if (!on) room.shareCode = newCode;
    for (const seat of room.activeHumans()) {
      seat.preference = null; seat.preferenceSelected = false; seat.ready = false; seat.matchingSource = false; seat.matchingOrigin = null;
    }
    if (on) {
      const host = room.seatOf(session.playerId);
      host.preference = bond; host.preferenceSelected = true; host.ready = true;
      for (const playerId of rejected) {
        const target = this.lobby.registry.byId(playerId);
        this.lobby.removeMember(room, playerId);
        if (target?.connected) sendSession(target, { t: 'room.closed', reason: 'matching-name' });
        else if (target) target.notice = 'matching-name';
      }
    }
    this.lobby.broadcastState(room);
    if (returned) this.parties.resumeBackfilled(returned);
    this.parties.pump(); return ok;
  }
  roomPrepare(session, { bond, revision }) {
    const room = this.lobby.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.match || !room.matchmaking || room.queueGenerated) return fail(ERR.MATCH_LOCKED);
    if (revision !== room.matchingRevision) return fail(ERR.MATCH_STALE);
    const seat = room.seatOf(session.playerId);
    if (!seat || seat.isBot) return fail(ERR.SPECTATOR);
    const checked = this.checkSession(session, room.difficulty, bond); if (checked.error) return checked;
    seat.preference = bond; seat.preferenceSelected = true; seat.ready = true;
    this.lobby.broadcastState(room); return ok;
  }
  nextSeed() { try { return this.lobby.seedFn() >>> 0; } catch { return randomInt(2 ** 32); } }
  start(room) {
    if (room.matchmaking && room.seats.some((s) => s?.isBot)) return fail(ERR.MATCH_BOTS);
    const checked = this.checkRoom(room); if (checked.error) return checked;
    return this.begin(room, this.nextSeed(), room.activeHumans().some((s) => s.matchingSource) && !room.queueGenerated ? 0.7 : 0.6);
  }
  cancel() {} // Legacy room disposal hook; queues now belong to parties.
  begin(room, seed, protection = 0.6) {
    const checked = this.checkRoom(room);
    if (checked.error) return checked;
    const host = this.lobby.registry.byId(room.hostId);
    const key = host?.limitKey || null;
    if (key && this.lobby.opts.maxMatchesPerAddr > 0 && this.lobby.countRooms((r) => !!r.match && r.matchKey === key) >= this.lobby.opts.maxMatchesPerAddr) return fail(ERR.RATE);
    const bondWeights = room.matchmaking && !room.queueGenerated ? Object.fromEntries(room.activeHumans().filter((s) => s.preference).map((s) => [s.preference, s.playerId === room.hostId ? 1 : 2]).sort((a, b) => Number(b[1]) - Number(a[1]))) : null;
    room.nextMatching = { bondWeights, id: randomUUID(), seed, protection, generated: !!room.queueGenerated, participants: room.activeHumans().map((s) => ({ playerId: s.playerId, identity: this.identity(this.lobby.registry.byId(s.playerId)) })), preferences: room.activeHumans().map((s) => s.preference).filter(Boolean) };
    const result = this.lobby.startMatch(room, key);
    room.nextMatching = null;
    return result;
  }
  decorate(ctx, msg) {
    return ctx.matching && msg.t === 'm.result' ? { ...msg, matching: { id: ctx.matching.id, generated: ctx.matching.generated, participants: ctx.matching.participants.map(p=>({...p,identity:this.reference(p.identity),name:p.identity.replace(/#\d{4}$/,'')})) } } : msg;
  }
  settled(room, ctx, summary) {
    this.clearRoomReconnects(room); room.resultMatchingId = ctx.matching?.id || null; this.parties.settled(room);
    if (!ctx.matching || ['interrupted', 'shutdown', 'error'].includes(summary.reason)) return;
    this.store.remember(ctx.matching.id, ctx.matching.participants.map((p) => p.identity));
  }
  departure(room, playerId) {
    const ctx = room.matchCtx;
    if (!ctx?.matching || !room.match || room.match.ended || room.match.players?.get(playerId)?.alive === false) return;
    const who = ctx.matching.participants.find((p) => p.playerId === playerId);
    if (!who) return;
    this.store.abandon(who.identity, ctx.matching.id, this.lobby.now());
    for (const s of this.lobby.registry.all()) if (this.identity(s) === who.identity) this.state(s);
  }
  disconnect(room, session) {
    this.parties.disconnect(session);
    if (!room?.matchCtx?.matching || !room.seatOf(session.playerId)) return;
    this.reconnected(session);
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(session.playerId);
      if (!session.connected && room.matchCtx?.matching) this.lobby.removeMember(room, session.playerId);
    }, this.lobby.opts.matchmakingReconnectMs ?? MATCH_RECONNECT_MS);
    timer.unref?.(); this.reconnectTimers.set(session.playerId, timer);
  }
  reconnected(session) { clearTimeout(this.reconnectTimers.get(session.playerId)); this.reconnectTimers.delete(session.playerId); }
  clearRoomReconnects(room) { for (const seat of room.seats.filter(Boolean)) this.reconnected(seat); }
  close() { for (const timer of [...this.timers.values(), ...this.reconnectTimers.values()]) clearTimeout(timer); this.timers.clear(); this.reconnectTimers.clear(); this.parties.close(); }
}
