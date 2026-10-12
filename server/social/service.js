import { compactRecord } from '../../shared/stats.js';
import { N_ } from '../../shared/i18n.js';
import { createHash, randomBytes } from 'node:crypto';
import { sendSession } from '../net.js';
import { doctorIdentity, doctorProfileKey } from '../../shared/doctor.js';
import { DEFAULT_AVATAR } from '../../shared/avatar.js';
import { ERR, PHASE } from '../../shared/constants.js';
import { MAX_FRIENDS, INVITE_TTL_MS, INVITE_COOLDOWN_MS, participantIdentity, recentCoPlayers, presenceRank, sanitizeSocialPrivacy, canViewProfile } from '../../shared/social.js';
const ok = { ok: true };
const fail = (detail, error = ERR.BAD_TARGET) => ({ error, detail });
const keyOf = (session) => participantIdentity(session?.profile);

/** Ephemeral presence/invitations; durable relationships live in ProfileStore. */
export class SocialService {
  constructor(lobby) {
    this.lobby = lobby; this.subscribers = new Map(); this.cache = new Map();
    this.invites = new Map(); this.cooldown = new Map(); this.closed = false;
    this.timer = null; this.migrate();
  }
  migrate() {
    for(const p of this.lobby.accountStats?.allProfiles() || []) {
      if(p.socialVersion===1) continue;
      const matches=[];
      for(const r of p.statistics?.records||[]) {
        const a=this.lobby.accountStats.rawArchive(r.id);
        if(!a?.result || ['abandoned','interrupted'].includes(a.result.reason)) continue;
        if(!a.participants?.some(x=>participantIdentity(x)===participantIdentity(p))) continue;
        matches.push({id:r.id,endedAt:a.endedAt||r.t,participants:a.participants.filter(x=>!x.isBot&&participantIdentity(x)).map(({name,doctorCode})=>({name,doctorCode}))});
      }
      p.socialRecentMatches=matches.sort((a,b)=>b.endedAt-a.endedAt||a.id.localeCompare(b.id)).slice(0,5);
      p.friends=Array.isArray(p.friends)?[...new Set(p.friends.filter(x=>doctorProfileKey(x)&&x!==participantIdentity(p)))].slice(0,200):[];
      p.socialVersion=1; this.lobby.profiles.save(p);
    }
  }
  remember(ctx,summary) {
    if(['abandoned','interrupted'].includes(summary.reason)) return;
    const participants=ctx.profiles.map(o=>({name:o.profile.name,doctorCode:o.profile.code}));
    for(const o of ctx.profiles) {
      const p=this.lobby.profiles.read(o.profile.name,o.profile.code); if(!p)continue;
      const match={id:ctx.statsId,endedAt:this.lobby.now(),participants};
      p.socialRecentMatches=[match,...(p.socialRecentMatches||[]).filter(m=>m.id!==match.id)].slice(0,5);
      p.socialVersion=1; p.friends ||= []; this.lobby.profiles.save(p); o.profile=p;
    }
    this.changed();
  }
  history(token,identity,id,options={}) {
    const s=this.lobby.registry.byToken(token);if(!s?.connected||!s.profile)return {status:401};
    const viewer=this.lobby.profiles.read(s.profile.name,s.profile.code),target=this.lookup(identity);if(!target)return {status:404};
    if(!canViewProfile(participantIdentity(viewer),target))return {status:403};
    const rows=(target.statistics?.records||[]).filter(r=>r.end==='settled');
    if(!id) {
      const offset=Math.floor(Math.max(0,Math.min(1000,Number(options.offset)||0))), snap=this.lobby.accountStats.snapshot(target,0);
      const records=[];let bytes=0;
      for(const r of rows.slice(offset,offset+50)) {
        const row={...compactRecord(r),replay:r.replay?{id:r.id,socialIdentity:identity,playerId:r.selfId,expired:r.replay.expired}:null};
        const size=Buffer.byteLength(JSON.stringify(row));if(records.length&&bytes+size>40_000)break;
        records.push(row);bytes+=size;
      }
      return {status:200,body:{profileKey:identity,revision:target.statistics?.revision||0,aggregate:snap.aggregate,records,total:rows.length,offset,next:offset+records.length<rows.length?offset+records.length:null}};
    }
    const row=rows.find(r=>r.id===id);if(!row?.replay)return {status:404};
    const record=this.lobby.accountStats.getReplay(id,row.replay.key,row.replay.owner,options);if(!record)return {status:404};
    // Never disclose private capabilities, reconnect tokens, preferences or an unadvertised public share code.
    const {key:secret,shareCode, ...body}=record;void secret;void shareCode;
    return {status:200,body};
  }
  lookup(identity) {
    const key = participantIdentity(doctorIdentity(identity));
    if (!key || !this.lobby.profiles) return null;
    if (this.cache.has(key)) return this.cache.get(key);
    const p = doctorIdentity(key), profile = this.lobby.profiles.read(p.name, p.code);
    if (profile) this.cacheProfile(key, profile);
    return profile;
  }
  cacheProfile(key, profile) {
    this.cache.set(key, structuredClone(profile));
    if (this.cache.size > 2048) this.cache.delete(this.cache.keys().next().value);
  }
  profileSaved(profile) {
    const key = participantIdentity(profile); this.cacheProfile(key, profile);
    for (const sub of this.subscribers.values()) if (sub.owner === key) this.snapshot(sub.session);
    this.flush();
  }
  sessions(identity) { return [...this.lobby.registry.all()].filter((s) => s.connected && keyOf(s) === identity); }
  activeIndex() {
    const map = new Map();
    for (const session of this.lobby.registry.all()) {
      const key = keyOf(session); if (!key || !session.connected) continue;
      const located = this.lobby.roomOf(session), room = located?.disposed ? null : located, status = room?.match ? (room.spectatorOf(session.playerId) ? 'spectating' : 'playing') : room ? 'room' : 'online';
      const current = map.get(key);
      if (!current || presenceRank(status) < presenceRank(current.status)) map.set(key, { session, room, status });
    }
    return map;
  }
  row(identity, index, extra = {}, viewer = null) {
    const profile = this.lookup(identity); if (!profile) return null;
    const live = index.get(identity), room = live?.room;
    const avatar = profile.avatar || DEFAULT_AVATAR;
    const privacy = sanitizeSocialPrivacy(profile.preferences?.socialPrivacy);
    const row = { identity, name: profile.name, code: profile.code, status: live?.status || 'offline', canViewProfile: canViewProfile(viewer, profile), avatarRevision: createHash('sha256').update(JSON.stringify(avatar)).digest('hex').slice(0, 16), ...extra };
    if (room) {
      row.mode = room.mode; row.difficulty = room.difficulty;
      row.canJoin = room.mode === 'coop' && !room.match && privacy.allowFriendJoin;
      row.canSpectate = !!room.match && privacy.allowFriendSpectate;
      row.players = room.seats.filter(Boolean).length; row.spectators = room.spectators.length;
      const pub = room.socialPublic || room.match?.publicView?.();
      if (room.match && pub) {
        const player = pub.players?.find((p) => p.playerId === live.session.playerId);
        row.round = pub.round ?? 0; row.bandId = player?.bandId || null;
        row.lp = player ? Math.max(0, Number.isFinite(pub.teamLp) && [PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE].includes(pub.phase) ? pub.teamLp : (player.lp || 0) - (player.pendingLp || 0)) : null;
      }
    }
    return row;
  }
  lists(identity, index = this.activeIndex()) {
    const profile = this.lookup(identity);
    const friends = [...new Set(profile?.friends || [])].map((id) => this.row(id, index, {}, identity)).filter(Boolean)
      .sort((a, b) => presenceRank(a.status) - presenceRank(b.status) || a.identity.localeCompare(b.identity));
    const recent = recentCoPlayers(profile).map(({ identity: id, ...extra }) => this.row(id, index, extra, identity)).filter(Boolean);
    return { friends, recent };
  }
  emit(session, type, fields) { sendSession(session, { t: type, profileKey: keyOf(session), ...fields }); }
  snapshot(session) {
    const owner = keyOf(session); if (!owner || !session.connected) return;
    const lists = this.lists(owner), rows = [...lists.friends, ...lists.recent];
    const sub = { owner, session, identities: new Set(rows.map((r) => r.identity)), last: new Map(rows.map((r) => [r.identity, JSON.stringify(r)])), gameAt: new Map(rows.map((r) => [r.identity, this.lobby.now()])) };
    this.subscribers.set(session.playerId, sub);
    this.emit(session, 'social.state', lists);
  }
  flush() {
    if (this.closed || !this.subscribers.size) return;
    const index = this.activeIndex();
    for (const [id, sub] of this.subscribers) {
      if (!sub.session.connected || sub.owner !== keyOf(sub.session)) { this.subscribers.delete(id); continue; }
      const entries = [];
      for (const target of sub.identities) {
        const old = JSON.parse(sub.last.get(target));
        const row = this.row(target, index, old.lastPlayedAt == null ? {} : { lastPlayedAt: old.lastPlayedAt }, sub.owner);
        if (!row) continue;
        const now = this.lobby.now(), fields = ['round', 'bandId', 'lp'];
        const gameChanged = fields.some((field) => row[field] !== old[field]);
        if (gameChanged && ['playing', 'spectating'].includes(row.status)) {
          if (old.status === row.status && now - sub.gameAt.get(target) < 1000) {
            for (const field of fields) { if (old[field] === undefined) delete row[field]; else row[field] = old[field]; }
          } else sub.gameAt.set(target, now);
        }
        const encoded = JSON.stringify(row);
        if (sub.last.get(target) !== encoded) { entries.push(row); sub.last.set(target, encoded); }
      }
      if (entries.length) this.emit(sub.session, 'social.presence', { entries });
    }
  }
  onHello(session) {
    const old = this.subscribers.get(session.playerId);
    if (old && old.owner !== keyOf(session)) this.subscribers.delete(session.playerId);
    this.changed();
  }
  related(session, identity) {
    const p = this.lookup(keyOf(session));
    return (p?.friends || []).includes(identity) || recentCoPlayers(p).some((r) => r.identity === identity);
  }
  current(session) { return this.lookup(keyOf(session)); }
  playingElsewhere(session, target) {
    return [...this.lobby.registry.all()].filter((s) => keyOf(s) === keyOf(session)).some((s) => {
      const room = this.lobby.roomOf(s);
      return room?.match && room !== target && !!room.seatOf(s.playerId);
    });
  }
  handle(session, msg) {
    if (!session.profile || !this.lobby.profiles) return fail(N_('好友系统需要完整代号'));
    if (!this.timer) { this.timer = setInterval(() => this.changed(), 1000); this.timer.unref(); }
    const identity = msg.identity ? participantIdentity(doctorIdentity(msg.identity)) : null;
    switch (msg.t) {
      case 'social.sync': {
        const latest = this.lobby.profiles.read(session.profile.name, session.profile.code);
        this.cacheProfile(keyOf(session), latest); this.snapshot(session);
        for (const invite of this.invites.values()) if (invite.to === keyOf(session)) this.emitInvite(session, invite);
        return ok;
      }
      case 'social.search': {
        const query = doctorIdentity(msg.identity);
        if (!query) return fail(N_('请输入代号，不能只输入代码'));
        const found = query.code ? { identities: [identity], truncated: false } : this.lobby.profiles.searchNames(query.name);
        const index = this.activeIndex(), entries = found.identities.map((key) => this.row(key, index, {}, keyOf(session))).filter(Boolean);
        this.emit(session, 'social.search', { query: query.code ? identity : query.name, entries, truncated: found.truncated, entry: query.code ? entries[0] || null : null }); return ok;
      }
      case 'social.avatar': {
        if (!this.related(session, identity)) return fail(N_('不能读取此玩家的头像'));
        const p = this.lookup(identity); if (!p) return fail(N_('未找到该代号#代码'));
        this.emit(session, 'social.avatar', { identity, avatar: p.avatar || DEFAULT_AVATAR, avatarRevision: this.row(identity, this.activeIndex()).avatarRevision }); return ok;
      }
      case 'social.add':
      case 'social.remove': {
        if (identity === keyOf(session)) return fail(N_('不能添加自己为好友'));
        if (!this.lookup(identity)) return fail(N_('未找到该代号#代码'));
        const profile = this.current(session), friends = [...new Set(profile.friends || [])], included = friends.includes(identity);
        if (msg.t === 'social.add' && included) return fail(N_('已是好友'), ERR.ALREADY);
        if (msg.t === 'social.add' && friends.length >= MAX_FRIENDS) return fail(N_('好友数量已达上限'));
        const updated = msg.t === 'social.add' ? [...friends, identity] : friends.filter((id) => id !== identity);
        try { this.lobby.profiles.friends(profile, updated); } catch { return fail(N_('好友保存失败，请重试'), ERR.INTERNAL); }
        return ok;
      }
      case 'social.join':
      case 'social.spectate': {
        if (!(this.current(session).friends || []).includes(identity)) return fail(N_('请先添加该玩家为好友'));
        const live = this.activeIndex().get(identity);
        if (!live?.room) return fail(N_('对方已离开房间'));
        const privacy = sanitizeSocialPrivacy(this.lookup(identity)?.preferences?.socialPrivacy);
        if (msg.t === 'social.join' && !privacy.allowFriendJoin) return fail(N_('对方不允许好友直接加入房间，请使用链接或邀请'));
        if (msg.t === 'social.spectate' && !privacy.allowFriendSpectate) return fail(N_('对方不允许好友直接观战，请使用观战链接'));
        if (this.playingElsewhere(session, live.room)) return fail(N_('请先退出当前对局'), ERR.ROOM_STARTED);
        if (msg.t === 'social.join') {
          if (live.room.match) return fail(N_('对方已开始模拟，可以观战'), ERR.ROOM_STARTED);
          return this.capacityResult(this.lobby.join(session, { code: live.room.code }), false);
        }
        if (!live.room.match) return fail(N_('对方的模拟已结束'));
        return this.capacityResult(this.lobby.spectate(session, { code: live.room.code }), true);
      }
      case 'social.invite': return this.invite(session, identity);
      case 'social.inviteRespond': return this.respond(session, msg);
      default: return fail(N_('未知好友操作'), ERR.BAD_MSG);
    }
  }
  capacityResult(result, spectator) {
    return result.error === ERR.ROOM_FULL ? fail(spectator ? N_('无法加入房间，人数已满；观战席位已满') : N_('无法加入房间，人数已满'), ERR.ROOM_FULL) : result;
  }
  invite(session, to) {
    const room = this.lobby.roomOf(session), from = keyOf(session), now = this.lobby.now();
    if (!room || room.mode !== 'coop' || room.match || !room.seatOf(session.playerId)) return fail(N_('只能在同盟等待房间邀请玩家'));
    if (to === from || !this.related(session, to)) return fail(N_('只能邀请好友或近期玩家'));
    if (this.sessions(to).some((s) => s.roomCode === room.code)) return fail(N_('该玩家已在当前同盟中'), ERR.ALREADY);
    if (!this.sessions(to).length) return fail(N_('对方当前离线'));
    if (room.freeSeat() < 0) return fail(N_('无法加入房间，人数已满'), ERR.ROOM_FULL);
    if (now - (this.cooldown.get(`${from}:${to}`) ?? -Infinity) < INVITE_COOLDOWN_MS) return fail(N_('请稍后再次邀请'), ERR.RATE);
    if (this.invites.size >= 1000 || [...this.invites.values()].filter((i) => i.to === to).length >= 5) return fail(N_('待处理邀请过多，请稍后再试'), ERR.RATE);
    const invite = { id: randomBytes(16).toString('hex'), from, to, room, inviter: session.playerId, expiresAt: now + INVITE_TTL_MS };
    this.invites.set(invite.id, invite); this.cooldown.set(`${from}:${to}`, now);
    for (const target of this.sessions(to)) this.emitInvite(target, invite);
    return ok;
  }
  emitInvite(session, invite) {
    this.emit(session, 'social.invite', { inviteId: invite.id, from: invite.from, difficulty: invite.room.difficulty, expiresAt: invite.expiresAt, serverNow: this.lobby.now() });
  }
  valid(invite) {
    const room = invite.room, inviter = this.lobby.registry.byId(invite.inviter);
    return this.lobby.now() < invite.expiresAt && !room.disposed && !room.match && this.lobby.rooms.get(room.code) === room && inviter && keyOf(inviter) === invite.from && inviter.roomCode === room.code && !!room.seatOf(inviter.playerId);
  }
  end(invite, reason) {
    this.invites.delete(invite.id);
    for (const session of this.sessions(invite.to)) this.emit(session, 'social.inviteEnded', { inviteId: invite.id, reason });
  }
  respond(session, { inviteId, accept }) {
    const invite = this.invites.get(inviteId);
    if (!invite || invite.to !== keyOf(session)) return fail(N_('邀请已失效'));
    if (!this.valid(invite)) { this.end(invite, 'expired'); return fail(N_('邀请已失效')); }
    if (!accept) { this.end(invite, 'declined'); return ok; }
    const current = this.lobby.roomOf(session);
    if (current?.match || this.playingElsewhere(session, invite.room)) return fail(N_('请先退出当前对局'), ERR.ROOM_STARTED);
    const result = this.capacityResult(this.lobby.join(session, { code: invite.room.code }), false);
    if (result.error) return result;
    this.end(invite, 'accepted'); return ok;
  }
  changed() {
    try { this.sweep(); this.flush(); } catch (error) { this.lobby.log.error('[social] state unavailable', error); }
  }
  sweep() {
    for (const invite of this.invites.values()) if (!this.valid(invite)) this.end(invite, 'expired');
    const now = this.lobby.now(); for (const [pair, at] of this.cooldown) if (now - at >= INVITE_COOLDOWN_MS) this.cooldown.delete(pair);
  }
  close() { clearInterval(this.timer); this.closed = true; this.subscribers.clear(); this.invites.clear(); this.cache.clear(); this.cooldown.clear(); }
}
