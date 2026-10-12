// A callsign plus an optional four-digit archive code. Names keep the existing NAME_MAX_LEN limit.
import { NAME_MAX_LEN } from './constants.js';
export function doctorIdentity(raw) {
  const value = String(raw ?? '').normalize('NFC').trim();
  const match = /^(.*?)#(\d{4})$/.exec(value);
  const name = (match ? match[1] : value).trim();
  if (!name || name.length > NAME_MAX_LEN || name.includes('#')) return null;
  return { name, code: match?.[2] || null };
}
/** A cache owner always requires a complete identity; a bare callsign is not an account. */
export function doctorProfileKey(raw) { const p = doctorIdentity(raw); return p?.code ? `${p.name}#${p.code}` : null; }
