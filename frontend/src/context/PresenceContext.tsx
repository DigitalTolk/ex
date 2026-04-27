import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';

interface PresenceState {
  online: Set<string>;
  isOnline: (userId: string) => boolean;
  setUserOnline: (userId: string, online: boolean) => void;
}

const PresenceContext = createContext<PresenceState | undefined>(undefined);

export function PresenceProvider({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState<Set<string>>(new Set());
  const { isAuthenticated, user } = useAuth();

  // Backfill the initial set of online user IDs once authenticated. The
  // current user is always seeded as online — they are obviously online if
  // the app is rendering, and a publish race can otherwise drop their own
  // presence event before the WebSocket subscribes to PresenceEvents.
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    apiFetch<{ online: string[] }>('/api/v1/presence')
      .then((data) => {
        if (cancelled) return;
        const next = new Set(data?.online ?? []);
        if (user?.id) next.add(user.id);
        setOnline(next);
      })
      .catch(() => {
        if (cancelled) return;
        // Even if backfill fails, seed self so the user's own dot is correct.
        if (user?.id) setOnline((prev) => (prev.has(user.id) ? prev : new Set(prev).add(user.id)));
      });
    return () => { cancelled = true; };
  }, [isAuthenticated, user?.id]);

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

  return (
    <PresenceContext.Provider value={{ online, isOnline, setUserOnline }}>
      {children}
    </PresenceContext.Provider>
  );
}

// Safe defaults for when usePresence is read outside a provider — used by
// UserHoverCard, which is rendered in many test contexts that don't bother
// to wrap in PresenceProvider. Throwing here would force every unrelated
// layout test to bring up the full presence stack.
const noopPresence: PresenceState = {
  online: new Set<string>(),
  isOnline: () => false,
  setUserOnline: () => undefined,
};

export function usePresence() {
  return useContext(PresenceContext) ?? noopPresence;
}
