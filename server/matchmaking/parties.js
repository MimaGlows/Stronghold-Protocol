// Owner-approved lobby parties, separate from room seats. All transfers are synchronous transactions.
import { randomUUID } from 'node:crypto';
import { ERR, DIFFICULTIES, MAX_SEATS } from '../../shared/constants.js';
import { MATCHING_AVATAR, DEFAULT_AVATAR } from '../../shared/avatar.js';
import { MATCH_WAIT_MS } from '../../shared/matchmaking.js';
import { INVITE_TTL_MS, INVITE_COOLDOWN_MS } from '../../shared/social.js';
import { sendSession } from '../net.js';
const ok = { ok: true }, fail = (error) => ({ error });
export class MatchingParties {
  constructor(service) {
    this.service = service; this.lobby = service.lobby;
    this.parties = new Map(); this.membership = new Map(); this.invites = new Map(); this.cooldowns = new Map();
    this.sequence = 0; this.pumping = false;
    this.timer = setInterval(() => this.pump(), 1000); this.timer.unref?.();
  }
  of(session) { return this.parties.get(this.membership.get(session?.playerId)) || null; }
  inviteable(p) { return !!p && ['idle', 'searching', 'extended'].includes(p.phase); }
  // Call only after destination checks succeed; another tab may own this account's party seat.
  leaveIdentity(session) {
    const identity = this.service.identity(session);
    for (const p of [...this.parties.values()]) for (const m of [...p.members]) {
      if (m.identity !== identity) continue;
      const member = this.session(m);
      if (!member) continue;
      const room = this.lobby.roomOf(member);
      if (room?.queueGenerated && !room.match) {
        this.lobby.leave(member); sendSession(member, { t: 'room.closed', reason: 'invited' });
      }
      this.leave(member);
    }
  }
  session(member) { return this.lobby.registry.byId(member.playerId); }
  view(p) {
    if (!p) return null;
    return { id: p.id, revision: p.revision, leaderId: p.leaderId, difficulty: p.difficulty, phase: p.phase,
      attemptId: p.attempt?.id || null, startedAt: p.attempt?.startedAt || 0,
      members: p.members.map((m) => { const s = this.session(m); return { playerId: m.playerId, identity: m.identity, name: s?.profile?.name || m.name,
        avatar: s?.avatar?.kind === 'custom' ? MATCHING_AVATAR : s?.avatar || DEFAULT_AVATAR,
        preference: this.service.store.get(m.identity).preference || null, ready: m.ready, connected: !!s?.connected }; }),
      invites: [...this.invites.values()].filter((i) => i.partyId === p.id).map((i) => ({ id: i.id, identity: i.to, expiresAt: i.expiresAt })),
      permissions: { edit: p.phase === 'idle', start: p.phase === 'idle', cancel: !!p.attempt } };
  }
  publish(p) { if (!p) return; p.revision++; for (const m of p.members) { const s = this.session(m); if (s) this.service.state(s); } this.lobby.social?.changed(); }
  ensure(session, difficulty, preference = this.service.store.get(this.service.identity(session)).preference || null) {
    if (this.lobby.roomOf(session)) return fail(ERR.MATCH_LOCKED);
    if (this.lobby.social.playingElsewhere(session, null)) return fail(ERR.ROOM_STARTED);
    let p = this.of(session);
    if (p) return p;
    const id = this.service.identity(session);
    if ([...this.parties.values()].some((v) => v.members.some((m) => m.identity === id))) return fail(ERR.MATCH_LOCKED);
    const check = this.service.checkSession(session, difficulty, preference);
    if (check.error) return check;
    p = { id: randomUUID(), revision: 0, leaderId: session.playerId, difficulty, phase: 'idle', attempt: null,
      members: [{ playerId: session.playerId, identity: id, name: session.profile.name, ready: false, connected: true }] };
    this.parties.set(p.id, p); this.membership.set(session.playerId, p.id); this.publish(p); return p;
  }
  check(p, ready = true) {
    const ids = [];
    for (const m of p.members) {
      const s = this.session(m);
      if (!s?.connected || this.service.identity(s) !== m.identity || (ready && m.playerId !== p.leaderId && !m.ready)) return fail(ERR.NOT_READY);
      if (this.lobby.roomOf(s)) return fail(ERR.MATCH_LOCKED);
      const c = this.service.checkSession(s, p.difficulty, this.service.store.get(m.identity).preference || null); if (c.error) return c;
      if (ids.some((id) => this.service.store.blocked(id, m.identity))) return fail(ERR.MATCH_BLOCKED);
      ids.push(m.identity);
    }
    return ok;
  }
  cancel(p) { p.attempt = null; p.phase = 'idle'; for (const m of p.members) m.ready = false; this.publish(p); }
  beginSearch(p) {
    const checked = this.check(p); if (checked.error) return checked;
    for (const i of [...this.invites.values()]) if (i.partyId === p.id) this.endInvite(i, 'expired');
    p.attempt = { id: randomUUID(), seed: this.service.nextSeed(), startedAt: this.lobby.now(), order: ++this.sequence };
    p.phase = 'searching'; this.publish(p); this.pump(); return ok;
  }
  endInvite(i, reason) {
    this.invites.delete(i.id);
    for (const s of this.lobby.social.sessions(i.to)) this.lobby.social.emit(s, 'social.inviteEnded', { inviteId: i.id, reason });
  }
  leave(session) {
    const p = this.of(session); if (!p) return ok;
    if (p.attempt) this.cancel(p);
    this.membership.delete(session.playerId); p.members = p.members.filter((m) => m.playerId !== session.playerId);
    if (p.leaderId === session.playerId) { p.leaderId = p.members[0]?.playerId; for (const i of [...this.invites.values()]) if (i.partyId === p.id) this.endInvite(i, 'expired'); }
    if (!p.members.length) this.parties.delete(p.id); else this.publish(p);
    this.service.state(session); return ok;
  }
  disconnect(session) { const p = this.of(session); if (!p) return; p.members.find((m)=>m.playerId===session.playerId).connected=false; if (p.attempt) this.cancel(p); else this.publish(p); }
  onHello(session) { const p=this.of(session); if(!p)return; const m=p.members.find((v)=>v.playerId===session.playerId); if(m.identity!==this.service.identity(session))this.leave(session); else if(!m.connected) { m.connected=true; this.publish(p); } }
  invite(session, identity, difficulty) {
    let p = this.of(session);
    if (p && (!this.inviteable(p) || p.leaderId !== session.playerId)) return fail(ERR.MATCH_LOCKED);
    if (!this.lobby.social.related(session, identity) || identity === this.service.identity(session)) return fail(ERR.BAD_TARGET);
    const targets = this.lobby.social.sessions(identity); if (!targets.length) return fail(ERR.NOT_READY);
    if (p?.members.some((m) => m.identity === identity)) return fail(ERR.ALREADY);
    const d = p?.difficulty || difficulty;
    if (!DIFFICULTIES.includes(d)) return fail(ERR.BAD_MSG);
    const target = targets[0];
    const c = this.service.checkSession(target, d, this.service.store.get(identity).preference || null); if (c.error) return c;
    const ids = p?.members.map((m) => m.identity) || [this.service.identity(session)];
    if (ids.some((id) => this.service.store.blocked(id, identity))) return fail(ERR.MATCH_BLOCKED);
    if ([...this.invites.values()].some((i) => i.partyId === p?.id && i.to === identity)) return fail(ERR.ALREADY);
    const key = `${this.service.identity(session)}:${identity}`, now = this.lobby.now();
    if (now - (this.cooldowns.get(key) ?? -Infinity) < INVITE_COOLDOWN_MS) return fail(ERR.RATE);
    if (this.invites.size >= 1000 || (p && p.members.length + [...this.invites.values()].filter((i) => i.partyId === p.id).length >= MAX_SEATS)) return fail(ERR.ROOM_FULL);
    if (!p) { p = this.ensure(session, d); if (p.error) return p; }
    const i = { id: randomUUID(), partyId: p.id, to: identity, from: this.service.identity(session), expiresAt: now + INVITE_TTL_MS };
    this.invites.set(i.id, i); this.cooldowns.set(key, now);
    for (const s of targets) this.emitInvite(s, i); this.publish(p); return ok;
  }
  emitInvite(s, i) { const p = this.parties.get(i.partyId); if (p) this.lobby.social.emit(s, 'social.invite', { kind: 'matching', inviteId: i.id, from: i.from, difficulty: p.difficulty, expiresAt: i.expiresAt, serverNow: this.lobby.now() }); }
  respond(session, msg) {
    const i = this.invites.get(msg.inviteId), p = i && this.parties.get(i.partyId);
    if (!i || i.to !== this.service.identity(session) || !this.inviteable(p) || i.expiresAt <= this.lobby.now()) return fail(ERR.MATCH_STALE);
    if (!msg.accept) { this.endInvite(i, 'declined'); this.publish(p); return ok; }
    if (this.lobby.roomOf(session)?.match || this.lobby.social.playingElsewhere(session, null)) return fail(ERR.ROOM_STARTED);
    if (p.members.some((m) => m.identity === i.to)) return fail(ERR.ALREADY);
    if (p.members.length >= MAX_SEATS) return fail(ERR.ROOM_FULL);
    const c = this.check(p, false); if (c.error) return c;
    const checked = this.service.checkSession(session, p.difficulty, this.service.store.get(i.to).preference || null); if (checked.error) return checked;
    if (p.members.some((m) => this.service.store.blocked(m.identity, i.to))) return fail(ERR.MATCH_BLOCKED);
    this.leaveIdentity(session);
    if (this.lobby.roomOf(session)) {
      this.lobby.leave(session); sendSession(session, { t: 'room.closed', reason: 'invited' });
    }
    if (p.attempt) this.cancel(p);
    p.members.push({ playerId: session.playerId, identity: i.to, name: session.profile.name, ready: false, connected: true }); this.membership.set(session.playerId, p.id);
    this.endInvite(i, 'accepted'); this.publish(p); return ok;
  }
  handle(session, msg) {
    if (msg.t === 'matching.invite') return this.invite(session, msg.identity, msg.difficulty);
    if (msg.t === 'matching.inviteRespond') return this.respond(session, msg);
    if (msg.t === 'matching.return') {
      const room = this.lobby.roomOf(session); if (!room?.queueGenerated || room.match || room.resultMatchingId !== msg.matchId) return fail(ERR.MATCH_STALE);
      this.lobby.leave(session); const p = this.of(session);
      if (p) { const m = p.members.find((v) => v.playerId === session.playerId); m.ready = false;
        if (p.members.every((v) => !this.lobby.roomOf(this.session(v)))) p.phase = 'idle'; this.publish(p); }
      sendSession(session, { t: 'matching.returned' }); return ok;
    }
    let p = this.of(session);
    const fresh = !p && ['matching.start','matching.prepare'].includes(msg.t) && msg.revision === 0 && msg.partyId == null;
    if (fresh) { p = msg.t === 'matching.prepare' ? this.ensure(session, msg.difficulty, msg.bond) : this.ensure(session, msg.difficulty); if (p.error) return p; }
    if (!p) return fail(ERR.MATCH_STALE);
    if (!fresh && msg.partyId !== p.id) return fail(ERR.MATCH_STALE);
    if (msg.t === 'matching.leave') { if (this.lobby.roomOf(session)?.match) return fail(ERR.MATCH_LOCKED); return this.leave(session); }
    if (!fresh && msg.revision !== p.revision) return fail(ERR.MATCH_STALE);
    if (msg.t === 'matching.ready' && !msg.ready && p.attempt) {
      if (msg.attemptId !== p.attempt.id) return fail(ERR.MATCH_STALE);
      this.cancel(p); return ok;
    }
    if (msg.t === 'matching.cancel') { if (!p.attempt || msg.attemptId !== p.attempt.id || p.leaderId !== session.playerId) return fail(ERR.MATCH_STALE); this.cancel(p); return ok; }
    if (p.phase !== 'idle') return fail(ERR.MATCH_LOCKED);
    if (msg.t === 'matching.prepare') {
      if (msg.difficulty !== p.difficulty) return fail(ERR.MATCH_STALE);
      const checked = this.service.checkSession(session, p.difficulty, msg.bond); if (checked.error) return checked;
      this.service.store.edit(this.service.identity(session), (a) => { a.preference = msg.bond; });
      p.members.find((m) => m.playerId === session.playerId).ready = true;
      this.publish(p);
      if (p.members.every((m) => m.ready && this.session(m)?.connected)) {
        const result = this.beginSearch(p);
        if (result.error) { p.members.find((m) => m.playerId === session.playerId).ready = false; this.publish(p); }
        return result;
      }
      return ok;
    }
    if (msg.t === 'matching.ready') { p.members.find((m) => m.playerId === session.playerId).ready = msg.ready; this.publish(p); return ok; }
    if (p.leaderId !== session.playerId) return fail(ERR.NOT_HOST);
    if (msg.t === 'matching.difficulty') {
      p.difficulty = msg.difficulty;
      for (const i of [...this.invites.values()]) if (i.partyId === p.id) this.endInvite(i,'expired');
      for (const m of p.members) { const s = this.session(m); m.ready = false; this.service.clearInvalidPreference(s, p.difficulty); }
      this.publish(p); return ok;
    }
    if (msg.t === 'matching.start') {
      const c = this.check(p); if (c.error) return c;
      p.members.find((m) => m.playerId === p.leaderId).ready = true;
      return this.beginSearch(p);
    }
    return fail(ERR.BAD_MSG);
  }
  compatible(parties, room = null) {
    if (room && this.service.checkRoom(room, false).error) return false;
    const ids = room ? room.activeHumans().map((s) => this.service.identity(this.lobby.registry.byId(s.playerId))) : [];
    for (const p of parties) { if (this.check(p).error) return false; for (const m of p.members) { if (ids.some((id) => this.service.store.blocked(id, m.identity))) return false; ids.push(m.identity); } }
    return true;
  }
  combinations(queue) {
    const compare = (a,b) => { const x=a.map((p)=>p.attempt.order).sort((v,w)=>v-w), y=b.map((p)=>p.attempt.order).sort((v,w)=>v-w); for(let i=0;i<Math.min(x.length,y.length);i++) if(x[i]!==y[i]) return x[i]-y[i]; return x.length-y.length; };
    for (const shapes of [[[4],[2,2],[1,1,1,1]], [[2,1,1]], [[3,1]]]) {
      const found=[];
      for (const shape of shapes) {
        for (const anchor of queue) {
          const remaining=[...shape], index=remaining.indexOf(anchor.members.length); if(index<0) continue; remaining.splice(index,1);
          const candidates=queue.filter((p)=>p!==anchor && p.difficulty===anchor.difficulty);
          if (remaining.some((size)=>candidates.filter((p)=>p.members.length===size).length < remaining.filter((v)=>v===size).length)) continue;
          const walk=(sizes,chosen) => {
            if (!sizes.length) return this.compatible(chosen) ? chosen : null;
            for (const p of candidates) { if(p.members.length!==sizes[0] || chosen.includes(p)) continue;
              if(!this.compatible([...chosen,p])) continue;
              const result=walk(sizes.slice(1),[...chosen,p]); if(result) return result; }
            return null;
          };
          const result=walk(remaining,[anchor]); if(result) { found.push(result); break; }
        }
      }
      if(found.length) return [{ parties:found.sort(compare)[0] }];
    }
    return [];
  }
  transfer(parties, room = null) {
    const original = parties.flatMap((p) => p.members).map((m) => this.session(m));
    if (!room) {
      const host = this.lobby.registry.byId(parties[0].leaderId);
      const result = this.lobby.create(host, { mode: 'coop', difficulty: parties[0].difficulty }); if (result.error) return result;
      room = this.lobby.roomOf(host); room.queueGenerated = true; this.lobby.revokeShare(room);
    }
    const generated = room.queueGenerated;
    for (const s of original) {
      if (s.roomCode !== room.code) { const result = this.lobby.joinRoom(s, room); if (result.error) throw new Error('Validated party transfer failed'); }
      const seat = room.seatOf(s.playerId); seat.ready = true; seat.preferenceSelected = true; seat.preference = this.service.store.get(this.service.identity(s)).preference || null; seat.matchingSource = true;
    }
    const seed = parties[0].attempt.seed;
    for (const p of parties) { p.phase = generated ? 'playing' : 'backfilled'; if (generated) p.attempt = null; this.publish(p); }
    if (generated) {
      const result = this.service.begin(room, seed, 0.6);
      if (result.error) { for (const s of original) this.lobby.removeMember(room, s.playerId); for (const p of parties) this.cancel(p); return result; }
    } else {
      for (const p of parties) for (const m of [...p.members]) this.leave(this.session(m));
      this.lobby.broadcastState(room);
    }
    return ok;
  }
  pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (const i of [...this.invites.values()]) if (i.expiresAt <= this.lobby.now() || !this.inviteable(this.parties.get(i.partyId))) { const p = this.parties.get(i.partyId); this.endInvite(i, 'expired'); this.publish(p); }
      let queue = [...this.parties.values()].filter((p) => !!p.attempt && ['searching','extended'].includes(p.phase)).sort((a,b) => a.attempt.order-b.attempt.order);
      for (const p of queue) { if (this.check(p).error) this.cancel(p); else if (p.phase === 'searching' && this.lobby.now()-p.attempt.startedAt >= (this.lobby.opts.matchmakingWaitMs ?? MATCH_WAIT_MS)) { p.phase = 'extended'; this.publish(p); } }
      queue = queue.filter((p) => !!p.attempt);
      for (let i=0;i<queue.length;i++) {
        const combination=this.combinations(queue.filter((p)=>p.attempt && ['searching','extended'].includes(p.phase)))[0]; if(!combination) break;
        const ps=combination.parties.sort((a,b)=>a.attempt.order-b.attempt.order);
        const result=this.transfer(ps); if(result.error) for(const p of ps) this.cancel(p);
      }
      for (const p of queue.filter((v) => v.phase === 'extended')) {
        const rooms = [...this.lobby.rooms.values()].filter((r) => r.matchmaking && !r.queueGenerated && !r.match && !r.disposed && r.difficulty === p.difficulty && r.seats.filter((s) => s?.isBot).length === 0 && r.seats.filter((s) => !s).length >= p.members.length).sort((a,b) => a.createdAt-b.createdAt || a.code.localeCompare(b.code));
        const room = rooms.find((r) => this.compatible([p], r)); if (room) this.transfer([p], room);
      }
      for (const [key, at] of this.cooldowns) if (this.lobby.now()-at > INVITE_COOLDOWN_MS) this.cooldowns.delete(key);
    } catch (error) { this.lobby.log.error('[matching] party scheduler failed', error); }
    finally { this.pumping = false; }
  }
  settled(room) { if (!room.queueGenerated) return; for (const p of this.parties.values()) if (p.members.some((m) => this.session(m)?.roomCode === room.code)) { p.phase = 'settled'; p.attempt = null; for (const m of p.members) m.ready = false; this.publish(p); } }
  close() { clearInterval(this.timer); this.parties.clear(); this.membership.clear(); this.invites.clear(); this.cooldowns.clear(); }
}
