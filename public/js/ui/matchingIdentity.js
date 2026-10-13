import { useStore } from '../store.js';

/** Visible identities omit archive codes throughout a matching experience. */
export function useMatchingPrivacy() {
  return useStore((s) => !!s.matching?.restricted || !!s.room?.matching?.rules || !!s.match?.public?.matchmaking || !!s.match?.result?.matching);
}
