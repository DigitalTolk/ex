import { createContext, useContext, useEffect, useMemo, useState, useCallback, useRef, type ReactNode } from 'react';
import { useLatestRef } from '@/hooks/useLatestRef';
import { ExponentialBackoff, handleAll, retry } from 'cockatiel';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';

interface PresenceState {
  online: Set<string>;
  isOnline: (userId: string) => boolean;
  setUserOnline: (userId: string, online: boolean) => void;
  // refreshPresence refetches the authoritative online set. Called on WS
  // reconnect: presence.changed is ephemeral (never replayed), so every
  // transition that happened during a disconnect is otherwise lost until the
  // next full re-auth — online dots drifted stale after any network blip.
  refreshPresence: () => void;
}

const PresenceContext = createContext<PresenceState | undefined>(undefined);

// The backfill read is retried (jittered exponential backoff): it used to be
// one-shot, so a single failed request at boot left EVERY presence dot dark
// for the entire session. Held in a mutable holder so tests can swap in a
// zero-backoff policy instead of sleeping out the production curve.
export const presenceRetry = {
  policy: retry(handleAll, {
    maxAttempts: 3,
    backoff: new ExponentialBackoff({ initialDelay: 500, maxDelay: 5_000 }),
  }),
};

export function PresenceProvider({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState<Set<string>>(new Set());
  const { isAuthenticated, user } = useAuth();
  // Monotonic token so a slow in-flight backfill can never clobber the
  // result of a NEWER refresh (reconnects can fire while one is running).
  const fetchSeqRef = useRef(0);
  const userIDRef = useLatestRef(user?.id);

  const refreshPresence = useCallback(() => {
    const seq = ++fetchSeqRef.current;
    presenceRetry.policy
      .execute(() => apiFetch<{ online: string[] }>('/api/v1/presence'))
      .then((data) => {
        if (seq !== fetchSeqRef.current) return;
        const next = new Set(data?.online ?? []);
        // The current user is always seeded as online — they are obviously
        // online if the app is running, and a publish race can otherwise
        // drop their own presence event before the WS subscribes.
        if (userIDRef.current) next.add(userIDRef.current);
        setOnline(next);
      })
      .catch(() => {
        if (seq !== fetchSeqRef.current) return;
        // Even when every retry fails, seed self so the user's own dot is
        // correct; live presence.changed events keep updating the set.
        const selfID = userIDRef.current;
        if (selfID) setOnline((prev) => (prev.has(selfID) ? prev : new Set(prev).add(selfID)));
      });
    // userIDRef is a stable ref — listed to satisfy exhaustive-deps.
  }, [userIDRef]);

  // Backfill the initial set of online user IDs once authenticated.
  useEffect(() => {
    if (!isAuthenticated) return;
    refreshPresence();
  }, [isAuthenticated, refreshPresence]);

  const isOnline = useCallback((userId: string) => online.has(userId), [online]);

  const setUserOnline = useCallback((userId: string, isOnlineNow: boolean) => {
    setOnline((prev) => {
      const has = prev.has(userId);
      if (isOnlineNow && has) return prev;
      if (!isOnlineNow && !has) return prev;
      const next = new Set(prev);
      if (isOnlineNow) next.add(userId);
      else next.delete(userId);
      return next;
    });
  }, []);

  // Memoized so a presence event only re-renders consumers via the `online`
  // set itself — an unmemoized literal re-rendered EVERY usePresence
  // consumer (all avatars/dots) on each provider render.
  const value = useMemo(
    () => ({ online, isOnline, setUserOnline, refreshPresence }),
    [online, isOnline, setUserOnline, refreshPresence],
  );

  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
}

// Safe defaults for when usePresence is read outside a provider — used by
// UserHoverCard, which is rendered in many test contexts that don't bother
// to wrap in PresenceProvider. Throwing here would force every unrelated
// layout test to bring up the full presence stack.
const noopPresence: PresenceState = {
  online: new Set<string>(),
  isOnline: () => false,
  setUserOnline: () => undefined,
  refreshPresence: () => undefined,
};

export function usePresence() {
  return useContext(PresenceContext) ?? noopPresence;
}
