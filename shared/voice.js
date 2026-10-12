// Listening preferences and a single resolver shared by every operator voice trigger.
import { sanitizeSocialPrivacy } from './social.js';
export const VOICE_LANGUAGES = Object.freeze(['cn', 'jp']);
export const DEFAULT_VOICE_LANGUAGE = 'jp';
const charIdOk = (id) => /^char_[A-Za-z0-9_]{1,64}$/.test(id);
export function isVoicePreferences(value) {
  return !!value && VOICE_LANGUAGES.includes(value.voiceLanguage) && !!value.voiceOverrides
    && typeof value.voiceOverrides === 'object' && !Array.isArray(value.voiceOverrides)
    && Object.keys(value.voiceOverrides).length <= 1024
    && Object.entries(value.voiceOverrides).every(([id, lang]) => charIdOk(id) && VOICE_LANGUAGES.includes(lang));
}
export function sanitizeVoicePreferences(raw) {
  const voiceOverrides = {};
  for (const [id, lang] of Object.entries(raw?.voiceOverrides || {}).slice(0, 1024)) {
    if (charIdOk(id) && VOICE_LANGUAGES.includes(lang)) voiceOverrides[id] = lang;
  }
  const language = raw?.voiceLanguage ?? raw?.voiceLang;
  return { voiceLanguage: VOICE_LANGUAGES.includes(language) ? language : DEFAULT_VOICE_LANGUAGE, voiceOverrides };
}
export function defaultProfilePreferences() {
  return { ...sanitizeVoicePreferences(null), socialPrivacy: sanitizeSocialPrivacy(null), loadout: {}, ops: {}, notOwned: [], diy: {} };
}
/** Ordered banks, not filenames guessed from a different language's URL. */
export function resolveVoiceLines(manifest, charId, slot, preferences) {
  const language = preferences?.voiceOverrides?.[charId] || preferences?.voiceLanguage || DEFAULT_VOICE_LANGUAGE;
  const other = language === 'jp' ? 'cn' : 'jp';
  const bank = (lang) => manifest?.audio?.voices?.[lang] || (lang === 'cn' ? manifest?.audio?.voice : manifest?.audio?.voiceJp);
  return [language, other].map((lang) => {
    const value = bank(lang)?.[charId]?.[slot];
    return (Array.isArray(value) ? value : [value]).filter((url) => typeof url === 'string' && url.length);
  }).filter((lines) => lines.length);
}
