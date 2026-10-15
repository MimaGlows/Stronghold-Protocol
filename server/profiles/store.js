import { defaultProfilePreferences } from '../../shared/voice.js';
import { doctorProfileKey } from '../../shared/doctor.js';
import { recentParticipatedGames } from '../../shared/social.js';
// Durable profile lookup by the explicitly chosen callsign/code, separate from live reconnect tokens.
import fs from 'node:fs';
import path from 'node:path';
import { isAvatarChoice } from '../../shared/avatar.js';
import { createHash, randomInt } from 'node:crypto';
export class ProfileStore {
  constructor(dir) {
    this.dir = dir; this.names = new Set(); this.identities = new Set(); this.onSave = null;
    if (fs.existsSync(dir)) for (const file of fs.readdirSync(dir).filter((f) => /^[a-f0-9]{64}\.json$/.test(f))) {
      try { const p = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); if (typeof p.name === 'string') this.names.add(p.name); const key = doctorProfileKey(`${p.name}#${p.code}`); if (key) this.identities.add(key); } catch { /* A damaged profile is reported when that identity is opened. */ }
    }
  }
  availability(name, code) { return { nameExists: this.names.has(name), codeExists: !!code && !!this.read(name, code) }; }
  searchNames(name, limit = 20) {
    const query = name.normalize('NFC').toLocaleLowerCase();
    const matches = [...this.identities].filter((key) => key.slice(0, -5).toLocaleLowerCase().includes(query))
      .sort((a, b) => Number(b.slice(0, -5).toLocaleLowerCase() === query) - Number(a.slice(0, -5).toLocaleLowerCase() === query) || a.localeCompare(b));
    return { identities: matches.slice(0, limit), truncated: matches.length > limit };
  }
  file(name, code) { return path.join(this.dir, createHash('sha256').update(JSON.stringify([name, code])).digest('hex') + '.json'); }
  read(name, code) {
    try {
      const p = JSON.parse(fs.readFileSync(this.file(name, code), 'utf8'));
      if (p.name !== name || p.code !== code || !isAvatarChoice(p.avatar) || !Array.isArray(p.history)) throw new Error('invalid stored profile');
      return p;
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  save(profile) {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.file(profile.name, profile.code), temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(profile)); fs.renameSync(temp, file); this.names.add(profile.name); this.identities.add(`${profile.name}#${profile.code}`);
    try { this.onSave?.(profile); } catch { /* Successful disk saves must not fail due to notification delivery. */ }
  }
  resolve(name, code, avatar) {
    if (!code) {
      const start = randomInt(10000);
      for (let i = 0; i < 10000; i++) { const candidate = String((start + i) % 10000).padStart(4, '0'); if (!this.read(name, candidate)) { code = candidate; break; } }
      if (!code) throw new Error('doctor codes exhausted');
    }
    const existing = this.read(name, code);
    const profile = existing || { name, code, avatar: avatar || { kind: 'default' }, history: [] };
    if (!existing) this.save(profile);
    return { profile, restored: !!existing };
  }
  avatar(profile, avatar) { const latest = this.read(profile.name, profile.code) || profile; latest.avatar = avatar; this.save(latest); return latest; }
  preferences(profile, patch) {
    const latest = this.read(profile.name, profile.code) || profile;
    latest.preferences = { ...defaultProfilePreferences(), ...latest.preferences, ...patch };
    this.save(latest); return latest;
  }
  friends(profile, friends) {
    const latest = this.read(profile.name, profile.code) || profile;
    latest.friends = friends; this.save(latest); return latest;
  }
  backfillParticipants(profile, archive) {
    if (!archive) return profile;
    const latest = this.read(profile.name, profile.code) || profile;
    let changed = false;
    for (const entry of recentParticipatedGames(latest)) {
      if (Array.isArray(entry.participants)) continue;
      const record = archive.get(entry.id, entry.key, { summaryOnly: true });
      entry.participants = (record?.participants || record?.result?.players || []).map(({ name, doctorCode, isBot }) => ({ name, doctorCode, isBot: !!isBot }));
      changed = true;
    }
    if (changed) this.save(latest);
    return latest;
  }
  remember(profile, ticket, playerId, result) {
    const latest = this.read(profile.name, profile.code) || profile;
    if (!result.players?.some((p) => p.playerId === playerId)) return latest;
    const ended = typeof result.victory === 'boolean';
    if (!ended && latest.history.some((e) => e.id === ticket.id)) return latest;
    const entry = { ...ticket, playerId, modeId: result.modeId, difficulty: result.difficulty, ended, ...(ended ? { endedAt: Date.now() } : {}), participants: result.players.map(({ name, doctorCode, isBot }) => ({ name, doctorCode, isBot: !!isBot })), names: result.players.map((p) => p.name),
      ...(ended ? { result: { victory: result.victory, roundsPassed: result.roundsPassed, ...(result.matchPrivacy?{matchPrivacy:true}:{}), players: result.players.map(({ playerId, name }) => ({ playerId, name })) } } : {}) };
    latest.history = [entry, ...(latest.history || []).filter((e) => e.id !== ticket.id)].slice(0, 200);
    this.save(latest); return latest;
  }
}
