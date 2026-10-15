// Player portraits travel only with identity/room messages, never combat snapshots.
/** @typedef {{ kind: 'default' } | { kind: 'operator', charId: string, e2: boolean } | { kind: 'custom', dataUrl: string }} AvatarChoice */
export const DEFAULT_AVATAR = Object.freeze({ kind: 'default' });
export const MATCHING_AVATAR = Object.freeze({ kind: 'operator', charId: 'char_446_aroma', e2: true });
export const AVATAR_SIZE = 256;
export const AVATAR_MAX_BYTES = 24 * 1024;
export const AVATAR_INPUT_MAX_BYTES = 5 * 1024 * 1024;
// Allow independent avatar cookie generations for all three local instances while saving; WebSocket payloads still cap at 64 KiB.
export const AVATAR_COOKIE_HEADER_LIMIT = 256 * 1024;
const PREFIX = 'data:image/webp;base64,';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decode a small, strictly bounded WebP data URL without browser/Node-specific APIs. */
export function avatarBytes(url) {
  if (typeof url !== 'string' || !url.startsWith(PREFIX) || url.length > PREFIX.length + Math.ceil(AVATAR_MAX_BYTES / 3) * 4) return null;
  const s = url.slice(PREFIX.length);
  if (!s.length || s.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  const len = s.length / 4 * 3 - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0);
  if (len < 20 || len > AVATAR_MAX_BYTES) return null;
  const out = new Uint8Array(len);
  let index = 0;
  for (let i = 0; i < s.length; i += 4) {
    const a = ALPHABET.indexOf(s[i]), b = ALPHABET.indexOf(s[i + 1]);
    const c = s[i + 2] === '=' ? 0 : ALPHABET.indexOf(s[i + 2]);
    const d = s[i + 3] === '=' ? 0 : ALPHABET.indexOf(s[i + 3]);
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (index < len) out[index++] = n >>> 16;
    if (index < len) out[index++] = n >>> 8;
    if (index < len) out[index++] = n;
  }
  return out;
}

/** Check RIFF chunk boundaries, static image encoding and decoded dimensions. */
export function webpDimensions(b) {
  if (!b || b.length < 20) return null;
  const tag = (i) => String.fromCharCode(...b.slice(i, i + 4));
  const u32 = (i) => (b[i] + b[i + 1] * 256 + b[i + 2] * 65536 + b[i + 3] * 16777216);
  const u24 = (i) => b[i] + b[i + 1] * 256 + b[i + 2] * 65536;
  if (tag(0) !== 'RIFF' || tag(8) !== 'WEBP' || u32(4) !== b.length - 8) return null;
  let dims = null, extended = null, images = 0;
  for (let i = 12; i < b.length;) {
    if (i + 8 > b.length) return null;
    const kind = tag(i), size = u32(i + 4), p = i + 8, end = p + size + (size % 2);
    if (end > b.length || size === 0 || kind === 'ANIM' || kind === 'ANMF') return null;
    if (kind === 'VP8X') {
      if (size !== 10 || extended || (b[p] & 2)) return null;
      extended = { width: u24(p + 4) + 1, height: u24(p + 7) + 1 };
    } else if (kind === 'VP8 ') {
      if (size < 10 || (b[p] & 1) || b[p + 3] !== 0x9d || b[p + 4] !== 1 || b[p + 5] !== 0x2a) return null;
      dims = { width: (b[p + 6] + b[p + 7] * 256) & 0x3fff, height: (b[p + 8] + b[p + 9] * 256) & 0x3fff };
      images++;
    } else if (kind === 'VP8L') {
      if (size < 5 || b[p] !== 0x2f || (b[p + 4] >> 5) !== 0) return null;
      dims = { width: 1 + b[p + 1] + ((b[p + 2] & 0x3f) << 8), height: 1 + (b[p + 2] >> 6) + (b[p + 3] << 2) + ((b[p + 4] & 0x0f) << 10) };
      images++;
    }
    i = end;
  }
  if (images !== 1 || !dims || (extended && (dims.width !== extended.width || dims.height !== extended.height))) return null;
  return dims;
}

/** Structural check shared by saved cookies and the socket protocol. */
export function isAvatarChoice(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value);
  if (value.kind === 'default') return keys.length === 1;
  if (value.kind === 'operator') return keys.length === 3 && typeof value.charId === 'string'
    && /^char_[A-Za-z0-9_]+$/.test(value.charId) && value.charId.length <= 64 && typeof value.e2 === 'boolean';
  if (value.kind !== 'custom' || keys.length !== 2) return false;
  const d = webpDimensions(avatarBytes(value.dataUrl));
  return !!d && d.width === AVATAR_SIZE && d.height === AVATAR_SIZE;
}

/** Normalise and optionally validate operator IDs against the server's asset manifest. */
export function checkAvatarChoice(value, manifest) {
  if (!isAvatarChoice(value)) return { error: 'BAD_MSG', detail: 'invalid avatar' };
  if (value.kind === 'operator' && manifest !== undefined) {
    const chars = manifest?.chars;
    const rec = chars && Object.hasOwn(chars, value.charId) ? chars[value.charId] : null;
    if (!rec || typeof rec[value.e2 ? 'avatarE2' : 'avatar'] !== 'string') return { error: 'BAD_TARGET', detail: 'unknown operator avatar' };
  }
  const avatar = value.kind === 'default' ? DEFAULT_AVATAR : value.kind === 'operator'
    ? { kind: 'operator', charId: value.charId, e2: value.e2 } : { kind: 'custom', dataUrl: value.dataUrl };
  return { ok: true, avatar: Object.freeze(avatar) };
}

export function sameAvatar(a, b) {
  a = a || DEFAULT_AVATAR; b = b || DEFAULT_AVATAR;
  return a.kind === b.kind && (a.kind === 'default' || (a.kind === 'operator' ? a.charId === b.charId && a.e2 === b.e2 : a.dataUrl === b.dataUrl));
}
