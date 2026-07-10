import { create } from 'zustand';

// Presence source of truth. State lives in a zustand store (not React
// context) so hot-path consumers can subscribe per-user via useIsOnline —
// a presence.changed event then re-renders only the rows whose user
// actually flipped, instead of every context consumer in the tree.
// PresenceProvider (src/context/PresenceContext.tsx) still owns the
// lifecycle — auth-gated backfill, retry, reconnect refresh — and writes
// here; it re-exposes the same context API for whole-set consumers
// (e.g. SearchBar result sorting).

interface PresenceStoreState {
  online: Set<string>;
  setUserOnline: (userId: string, online: boolean) => void;
  replaceOnline: (ids: Iterable<string>) => void;
}

export const usePresenceStore = create<PresenceStoreState>((set) => ({
  online: new Set<string>(),
  setUserOnline: (userId, isOnlineNow) =>
    set((state) => {
      // Identity-preserving bail-out: a no-op transition must not produce
      // a new Set, or every subscriber re-renders for nothing.
      const has = state.online.has(userId);
      if (isOnlineNow === has) return state;
      const next = new Set(state.online);
      if (isOnlineNow) next.add(userId);
      else next.delete(userId);
      return { online: next };
    }),
  replaceOnline: (ids) => set({ online: new Set(ids) }),
}));

// Per-user subscription: re-renders only when THIS user's flag changes
// (zustand bails out on unchanged selector results).
export function useIsOnline(userId: string | undefined): boolean {
  return usePresenceStore((s) => (userId ? s.online.has(userId) : false));
}

// Test helper: reset between tests so suites don't leak presence.
export function resetPresenceStoreForTests() {
  usePresenceStore.setState({ online: new Set<string>() });
}
