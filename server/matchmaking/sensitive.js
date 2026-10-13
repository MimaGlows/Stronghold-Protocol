import fs from 'node:fs';
import { createHash } from 'node:crypto';

export function normalizeCallsign(value) {
  return String(value).normalize('NFKC').toLowerCase().replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu, '');
}
export class CallsignFilter {
  constructor(words) {
    this.abuse = Array.isArray(words) ? [] : words.abuse || [];
    words = Array.isArray(words) ? words : words.political || [];
    this.root = new Map();
    for (const source of words) {
      const word = normalizeCallsign(source).replace(/[\s\p{P}\p{S}]/gu, '');
      if (!word) continue;
      let node = this.root;
      for (const char of word) { if (!node.has(char)) node.set(char, new Map()); node = node.get(char); }
      node.set('', true);
    }
  }
  check(value) {
    const normalized = normalizeCallsign(value);
    const compact = normalized.replace(/[\s\p{P}\p{S}]/gu, '');
    const text = [...compact];
    for (let start = 0; start < text.length; start++) {
      let node = this.root;
      for (let i = start; i < text.length; i++) {
        node = node.get(text[i]);
        if (!node) break;
        if (node.has('')) return false;
      }
    }
    const segments = normalized.split(/[^a-z0-9]+/u).filter(Boolean);
    let letters = '';
    for (const token of [...segments, '']) {
      if (/^[a-z]$/u.test(token)) letters += token;
      else { if (letters.length > 1) segments.push(letters); letters = ''; }
    }
    for (const word of this.abuse) {
      if (/^[a-z0-9]+$/u.test(word) ? compact === word || segments.includes(word) : compact.includes(word)) return false;
    }
    return true;
  }
}
let filter;
export function defaultCallsignFilter() {
  if (!filter) {
    const bytes = fs.readFileSync(new URL('./sensitive-words.txt', import.meta.url));
    const meta = JSON.parse(fs.readFileSync(new URL('./sensitive-source.json', import.meta.url), 'utf8'));
    if (createHash('sha256').update(bytes).digest('hex') !== meta.sha256) throw new Error('Sensitive dictionary checksum mismatch');
    const abuse = fs.readFileSync(new URL('./sensitive-abuse.txt', import.meta.url));
    if (createHash('sha256').update(abuse).digest('hex') !== meta.abuseSha256) throw new Error('Sensitive abuse dictionary checksum mismatch');
    filter = new CallsignFilter({ political: bytes.toString('utf8').split(/\r?\n/).filter(Boolean), abuse: abuse.toString('utf8').split(/\r?\n/).filter(Boolean) });
  }
  return filter;
}
