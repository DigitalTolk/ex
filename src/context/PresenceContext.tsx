import { useEffect, type ReactNode } from 'react';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { usePresenceStore } from '@/stores/presence';

// Presence lives in the zustand store (@/stores/presence): hot paths subscribe
// per user (useIsOnline), so a presence.changed re-renders only the rows whose
// user flipped. This provider owns the backfill of the authoritative online
// set: a query, run once signed in and again whenever it is invalidated —
// ChatPage does after a socket gap, since presence.changed is ephemeral
// (never replayed) and every transition during a disconnect is otherwise lost.

export const presenceQueryKey = ['presence'] as const;

// The backfill is retried (three attempts in all, jittered exponential
// backoff): it used to be one-shot, so a single failed request at boot left
// EVERY presence dot dark for the session. Held in a mutable holder so tests
// can use a zero delay instead of sleeping out the production curve.
export const presenceRetry = {
  delay: (failures: number) => Math.min(5_000, 500 * 2 ** failures) * (0.5 + Math.random() / 2),
};

async function fetchOnline(): Promise<string[]> {
  const data = await apiFetch<{ online?: string[] }>('/api/v1/presence');
  return data?.online ?? [];
}

// refreshPresence refetches the authoritative online set. It supersedes a
// fetch still in flight — the first load included, which a plain refetch
// would only join — so a slow older response can never overwrite a newer one.
export function refreshPresence(qc: QueryClient): void {
  void qc
    .cancelQueries({ queryKey: presenceQueryKey })
    .then(() => qc.invalidateQueries({ queryKey: presenceQueryKey }));
}

export function PresenceProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, user } = useAuth();
  const selfID = user?.id;
  const { data, dataUpdatedAt, errorUpdatedAt } = useQuery({
    queryKey: presenceQueryKey,
    queryFn: fetchOnline,
    enabled: isAuthenticated,
    retry: 2,
    retryDelay: (failures) => presenceRetry.delay(failures),
    // Kept current by presence.changed between fetches: refetched on each
    // sign-in and on invalidation, never on focus or a timer.
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // Each completed fetch replaces the set. The current user is always seeded
  // as online — they obviously are while the app runs, and a publish race
  // can otherwise drop their own presence event before the WS subscribes.
  useEffect(() => {
    if (!dataUpdatedAt) return;
    const next = new Set(data);
    if (selfID) next.add(selfID);
    usePresenceStore.getState().replaceOnline(next);
  }, [data, dataUpdatedAt, selfID]);

  // Even when every retry fails, seed self so the user's own dot is right;
  // live presence.changed events keep updating the set.
  useEffect(() => {
    if (errorUpdatedAt && selfID) usePresenceStore.getState().setUserOnline(selfID, true);
  }, [errorUpdatedAt, selfID]);

  return <>{children}</>;
}

interface PresenceState {
  online: Set<string>;
  isOnline: (userId: string) => boolean;
  setUserOnline: (userId: string, online: boolean) => void;
}

const setUserOnline = (userId: string, online: boolean) => usePresenceStore.getState().setUserOnline(userId, online);

// usePresence subscribes to the WHOLE online set — every presence change
// anywhere re-renders the caller. For one user's dot use useIsOnline; for a
// value read in a handler, usePresenceStore.getState().online.
export function usePresence(): PresenceState {
  const online = usePresenceStore((s) => s.online);
  return { online, isOnline: (userId) => online.has(userId), setUserOnline };
}
