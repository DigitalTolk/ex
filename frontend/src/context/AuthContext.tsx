import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { User } from '@/types';
import {
  setAccessToken,
  clearAccessToken,
  apiFetch,
  refreshAccessToken,
} from '@/lib/api';
import { AUTH_INVALID_EVENT } from '@/lib/auth-events';
import { queryClient } from '@/lib/query-client';
import { resetDraftSessionState } from '@/hooks/useDrafts';
import { resetUserStateSessionState } from '@/hooks/useUserState';
import { resetSidebarReorderSessionState } from '@/hooks/useSidebar';
import { clearMobilePushUser, identifyMobilePushUser } from '@/lib/mobile-push-identity';

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: () => void;
  logout: () => Promise<void>;
  setAuth: (token: string, user: User) => void;
  patchUser: (patch: Partial<User>) => void;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

// Backoff between boot-restore attempts after a network-level failure; the
// last step repeats until the server is reachable again. A definitive
// rejection (server answered "no session") never retries — it goes straight
// to the login page.
const restoreRetryDelaysMs = [1000, 2000, 4000, 8000, 15000];
// Bound on the /users/me boot fetch, mirroring the refresh timeout in
// lib/api — an unbounded fetch here kept the app on the blank boot screen
// for as long as a half-open connection stayed silent.
const restoreTimeoutMs = 10_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const isAuthenticated = !!user;

  useEffect(() => {
    // On mount, attempt to refresh the access token (the refresh token is in
    // an httpOnly cookie). Network-level failures retry with backoff — a
    // waking mobile radio or a server mid-deploy must delay boot, not park it
    // on the loading screen forever or bounce a valid session to /login.
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    async function tryRestore() {
      for (;;) {
        try {
          const token = await refreshAccessToken();
          if (token) {
            setAccessToken(token);
            const me = await apiFetch<User>('/api/v1/users/me', {
              signal: AbortSignal.timeout(restoreTimeoutMs),
            });
            setUser(me);
            void identifyMobilePushUser(me).catch(() => undefined);
          }
          break; // definitive: signed in, or the server rejected the session
        } catch {
          const delay = restoreRetryDelaysMs[Math.min(attempt, restoreRetryDelaysMs.length - 1)];
          attempt += 1;
          await new Promise<void>((resolve) => {
            retryTimer = setTimeout(resolve, delay);
          });
        }
      }
      setIsLoading(false);
    }
    void tryRestore();
    // Clearing the pending timer parks the loop on an unresolved promise, so
    // an unmounted provider stops retrying without extra bookkeeping.
    return () => {
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, []);

  const login = useCallback(() => {
    window.location.href = '/auth/oidc/login';
  }, []);

  // resetLocalSession drops all in-memory + cached session state (token, user,
  // every cached query, process-wide draft state) so a subsequent (different)
  // user in the same document can't read the previous session's
  // messages/channels/drafts. Shared by logout and the terminal-invalid handler.
  const resetLocalSession = useCallback(() => {
    clearAccessToken();
    setUser(null);
    queryClient.clear();
    resetDraftSessionState();
    resetUserStateSessionState();
    resetSidebarReorderSessionState();
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch('/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // ignore
    }
    void clearMobilePushUser().catch(() => undefined);
    resetLocalSession();
  }, [resetLocalSession]);

  // A terminally-invalid session (refresh failed mid-session) broadcasts
  // AUTH_INVALID_EVENT from apiFetch. React to it here so the app drops the
  // user and ProtectedRoute redirects to /login, instead of leaving a
  // "logged-in" shell whose queries all silently 401.
  useEffect(() => {
    window.addEventListener(AUTH_INVALID_EVENT, resetLocalSession);
    return () => window.removeEventListener(AUTH_INVALID_EVENT, resetLocalSession);
  }, [resetLocalSession]);

  const setAuth = useCallback((token: string, userData: User) => {
    setAccessToken(token);
    setUser(userData);
    void identifyMobilePushUser(userData).catch(() => undefined);
  }, []);

  const patchUser = useCallback((patch: Partial<User>) => {
    setUser((current) => (current ? { ...current, ...patch } : current));
  }, []);

  // Memoize so the context value only changes when auth state does — the
  // callbacks are already stable, so consumers don't re-render on every
  // unrelated parent render.
  const value = useMemo(
    () => ({ user, isAuthenticated, isLoading, login, logout, setAuth, patchUser }),
    [user, isAuthenticated, isLoading, login, logout, setAuth, patchUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}

export function useOptionalAuth(): AuthState | null {
  return useContext(AuthContext) ?? null;
}
