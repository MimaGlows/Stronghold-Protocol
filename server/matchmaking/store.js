import fs from 'node:fs';
import path from 'node:path';
import { MATCH_WINDOW_MS, MATCH_PENALTIES, MATCH_BLOCK_LIMIT } from '../../shared/matchmaking.js';

// Matching records have their own atomic store, so profile preference writes cannot overwrite sanctions.
export class MatchingStore {
  constructor(dir = null) {
    this.file = dir ? path.join(dir, 'accounts.json') : null;
    this.accounts = {};
    if (this.file && fs.existsSync(this.file)) {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || !saved.accounts || typeof saved.accounts !== 'object') throw new Error('Invalid matching store');
      this.accounts = saved.accounts;
    }
  }
  get(identity) { return this.accounts[identity] || { preference: null, blocks: [], abandons: [], bannedUntil: 0, results: [] }; }
  edit(identity, update) {
    const account = structuredClone(this.get(identity));
    update(account);
    const accounts = { ...this.accounts, [identity]: account };
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify({ version: 1, accounts }));
      fs.renameSync(this.file + '.tmp', this.file);
    }
    this.accounts = accounts;
    return account;
  }
  blocked(a, b) { return a === b || this.get(a).blocks.includes(b) || this.get(b).blocks.includes(a); }
  block(identity, target, matchId) {
    const account = this.get(identity);
    if (identity === target || !account.results.some((r) => r.id === matchId && r.participants.includes(target))) return 'MATCH_BAD_TEAMMATE';
    if (account.blocks.includes(target)) return null;
    if (account.blocks.length >= MATCH_BLOCK_LIMIT) return 'MATCH_BLOCK_FULL';
    this.edit(identity, (a) => { a.blocks.push(target); });
    return null;
  }
  remember(id, participants) {
    for (const identity of participants) this.edit(identity, (a) => {
      a.results = [{ id, participants }, ...a.results.filter((r) => r.id !== id)].slice(0, 30);
    });
  }
  abandon(identity, id, now) {
    const account = this.get(identity);
    if (account.abandons.some((r) => r.id === id)) return account;
    return this.edit(identity, (a) => {
      a.abandons = a.abandons.filter((r) => r.at > now - MATCH_WINDOW_MS);
      const duration = MATCH_PENALTIES[Math.min(a.abandons.length, MATCH_PENALTIES.length - 1)];
      a.abandons.push({ id, at: now });
      a.bannedUntil = Math.max(a.bannedUntil || 0, now + duration);
    });
  }
}
