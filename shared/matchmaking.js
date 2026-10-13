// Experimental rules approved by the owner, 2026-10-12. Never used by ordinary matches.
export const MATCH_WAIT_MS = 60_000;
export const MATCH_RECONNECT_MS = 10 * 60_000;
export const MATCH_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const MATCH_PENALTIES = Object.freeze([30 * 60_000, 60 * 60_000, 3 * 60 * 60_000, 24 * 60 * 60_000]);
export const MATCH_BLOCK_LIMIT = 20;
export const CORE_PREFERENCES = Object.freeze(['yanShip', 'sargonShip', 'victoriaShip', 'kjeragShip', 'lateranoShip', 'egirShip', 'siracusaShip', 'kazimierzShip']);
export function validPreference(data, difficulty, bond) {
  if (bond == null) return true;
  const mode = data?.config?.modes?.[`mode_multi_${difficulty.toLowerCase()}`];
  return CORE_PREFERENCES.includes(bond) && !mode?.inactiveBondIds?.includes(bond);
}
export function matchingIdentity(profile) {
  return profile?.name && /^\d{4}$/.test(profile.code || '') ? `${profile.name}#${profile.code}` : null;
}
