// Account-owned social data; never identify a player by nickname alone.
import { doctorIdentity, doctorProfileKey } from './doctor.js';
export const MAX_FRIENDS = 200;
export const INVITE_TTL_MS = 120_000;
export const INVITE_COOLDOWN_MS = 30_000;
export const PROFILE_VISIBILITY = Object.freeze(['none', 'friends', 'friends_recent']);
export function sanitizeSocialPrivacy(value) {
  return { allowFriendSpectate: value?.allowFriendSpectate !== false, allowFriendJoin: value?.allowFriendJoin !== false,
    profileVisibility: PROFILE_VISIBILITY.includes(value?.profileVisibility) ? value.profileVisibility : 'friends_recent' };
}
export function isSocialPrivacy(value) {
  return !!value && typeof value.allowFriendSpectate === 'boolean' && typeof value.allowFriendJoin === 'boolean' && PROFILE_VISIBILITY.includes(value.profileVisibility);
}
export function canViewProfile(viewer, target) {
  if (!viewer || !target) return false;
  if (viewer === participantIdentity(target)) return true;
  const scope = sanitizeSocialPrivacy(target.preferences?.socialPrivacy).profileVisibility;
  return scope !== 'none' && ((target.friends || []).includes(viewer) || scope === 'friends_recent' && recentCoPlayers(target).some((row) => row.identity === viewer));
}
export function participantIdentity(p) {
  if (!p || p.isBot) return null;
  return doctorProfileKey(`${p.name}#${p.doctorCode || p.code || ''}`);
}
export function recentParticipatedGames(profile) {
  if (Array.isArray(profile?.socialRecentMatches)) return profile.socialRecentMatches.filter((g) => !g.isMatchingMatch).slice(0, 5);
  return (profile?.history || []).filter((e) => e.ended && (!e.playerId || !Array.isArray(e.result?.players)
    || e.result.players.some((p) => p.playerId === e.playerId))).slice(0, 5);
}
export function recentCoPlayers(profile) {
  const friends = new Set(profile?.friends || []), self = participantIdentity(profile), seen = new Set();
  const rows = [];
  for (const game of recentParticipatedGames(profile)) {
    if (game.isMatchingMatch || game.result?.isMatchingMatch || game.result?.matching) continue;
    for (const p of game.participants || []) {
      const identity = participantIdentity(p);
      if (!identity || identity === self || friends.has(identity) || seen.has(identity)) continue;
      seen.add(identity);
      rows.push({ identity, lastPlayedAt: game.endedAt || game.startedAt || 0 });
    }
  }
  return rows.sort((a, b) => b.lastPlayedAt - a.lastPlayedAt || a.identity.localeCompare(b.identity));
}
export const isSocialIdentity = (value) => typeof value === 'string' && !!doctorIdentity(value)?.code;
export const isSocialSearch = isSocialIdentity;
export const presenceRank = (status) => ({ playing: 0, spectating: 0, room: 1, online: 2, offline: 3 })[status] ?? 4;
