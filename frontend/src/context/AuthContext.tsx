import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import type { User } from '@/types';
import {
  setAccessToken,
  clearAccessToken,
  apiFetch,
} from '@/lib/api';

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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const isAuthenticated = !!user;

  useEffect(() => {
    // On mount, attempt to refresh the access token
    // (the refresh token is in an httpOnly cookie)
    async function tryRestore() {
      try {
        const res = await fetch('/auth/token/refresh', {
          method: 'POST',
          credentials: 'include',
        });
        if (res.ok) {
          const data = await res.json();
          if (data.accessToken) {
            setAccessToken(data.accessToken);
            const me = await apiFetch<User>('/api/v1/users/me');
            setUser(me);
          }
        }
      } catch {
        // not authenticated
      } finally {
        setIsLoading(false);
      }
    }
    tryRestore();
  }, []);

  const login = useCallback(() => {
    window.location.href = '/auth/oidc/login';
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
    clearAccessToken();
    setUser(null);
  }, []);

  const setAuth = useCallback((token: string, userData: User) => {
    setAccessToken(token);
    setUser(userData);
  }, []);

  const patchUser = useCallback((patch: Partial<User>) => {
    setUser((current) => (current ? { ...current, ...patch } : current));
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, isAuthenticated, isLoading, login, logout, setAuth, patchUser }}
    >
      {children}
    </AuthContext.Provider>
  );
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
