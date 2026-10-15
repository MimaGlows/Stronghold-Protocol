import { sanitizeVoicePreferences } from '../../../../shared/voice.js';
import { sanitizeSocialPrivacy } from '../../../../shared/social.js';
// ui/gameLogic/settings.js — settings defaults and sanitising. Re-exported from ../gameLogic.js.



import { clamp, isObj } from './shared.js';
import { DEFAULT_HOTKEYS, sanitizeHotkeys } from './shortcuts.js';


// ---- settings ------------------------------------------------------------------------------------------------------

export const VOICE_LANGS = Object.freeze(['cn', 'jp']);
/** keys: the in-match shortcuts' key map (ui/gameLogic/shortcuts.js; settings → 快捷键). */
export const TEXT_SIZES = Object.freeze(['sm', 'md', 'lg', 'xl']);
export const DEFAULT_SETTINGS = Object.freeze({ voiceLanguage: 'jp', voiceOverrides: Object.freeze({}), socialPrivacy: Object.freeze(sanitizeSocialPrivacy(null)), bgm: 0.6, sfx: 0.8, voice: 0.8, muted: false, damageNumbers: true, officialDamageNumbers: false, ammoCount: false, quality: 'high', textSize: 'sm', matchingMotion: 'full', keys: DEFAULT_HOTKEYS });
const QUALITIES = ['high', 'medium', 'low'];

/**
 * Sanitize persisted settings.
 * @param {any} raw
 * @returns {{ bgm: number, sfx: number, voice: number, voiceLanguage: 'cn'|'jp', voiceOverrides: Record<string, string>, muted: boolean, damageNumbers: boolean, officialDamageNumbers: boolean, ammoCount: boolean, quality: 'high'|'medium'|'low',
 *   textSize: 'sm'|'md'|'lg'|'xl', matchingMotion: 'full'|'reduced', keys: Record<'refresh'|'freeze'|'levelUp'|'retreat'|'sell'|'ready', string> }}
 */
export function sanitizeSettings(raw) {
  const r = isObj(raw) ? raw : {};
  const vol = (v, d) => (Number.isFinite(v) ? clamp(Math.round(v * 100) / 100, 0, 1) : d);
  return {
    ...sanitizeVoicePreferences(r),
    socialPrivacy: sanitizeSocialPrivacy(r.socialPrivacy),
    bgm: vol(r.bgm, DEFAULT_SETTINGS.bgm),
    sfx: vol(r.sfx, DEFAULT_SETTINGS.sfx),
    voice: vol(r.voice, DEFAULT_SETTINGS.voice),
    muted: typeof r.muted === 'boolean' ? r.muted : DEFAULT_SETTINGS.muted,
    damageNumbers: typeof r.damageNumbers === 'boolean' ? r.damageNumbers : DEFAULT_SETTINGS.damageNumbers,
    officialDamageNumbers: typeof r.officialDamageNumbers === 'boolean' ? r.officialDamageNumbers : false,
    ammoCount: typeof r.ammoCount === 'boolean' ? r.ammoCount : DEFAULT_SETTINGS.ammoCount,
    quality: QUALITIES.includes(r.quality) ? r.quality : DEFAULT_SETTINGS.quality,
    textSize: TEXT_SIZES.includes(r.textSize) ? r.textSize : DEFAULT_SETTINGS.textSize,
    matchingMotion: r.matchingMotion === 'reduced' ? 'reduced' : 'full',
    keys: sanitizeHotkeys(r.keys),
  };
}
