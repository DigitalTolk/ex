import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { setAccessToken, apiFetch } from '@/lib/api';
import { GENERAL_CHANNEL_SLUG } from '@/lib/roles';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import type { User } from '@/types';

export default function OIDCCallbackPage() {
  useDocumentTitle('Signing in…');
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { setAuth } = useAuth();

  useEffect(() => {
    async function handleCallback() {
      // Try URL hash fragment first, then query param
      const hash = window.location.hash;
      let token: string | null = null;

      if (hash) {
        const hashParams = new URLSearchParams(hash.substring(1));
        token = hashParams.get('token') || hashParams.get('access_token');
      }

      if (!token) {
        token = searchParams.get('token') || searchParams.get('access_token');
      }

      // Native/desktop deep-link handoff: the backend's OIDC callback minted a
      // one-time desktop_code and bounced through the shell (ex://mobile /
      // tauri://). When the shell lands the webview back on this route with
      // that code, complete it server-side — /auth/desktop/complete consumes
      // the code, sets the refresh cookie first-party, and redirects back
      // here with a real token. Full-page navigation on purpose: the cookie
      // is set on the redirect response.
      if (!token) {
        const desktopCode = searchParams.get('desktop_code');
        if (desktopCode) {
          window.location.replace(`/auth/desktop/complete?code=${encodeURIComponent(desktopCode)}`);
          return;
        }
      }

      if (!token) {
        // Maybe the server set the cookie directly; try refreshing
        try {
          const res = await fetch('/auth/token/refresh', {
            method: 'POST',
            credentials: 'include',
          });
          if (res.ok) {
            const data = await res.json();
            token = data.accessToken;
          }
        } catch {
          // ignore
        }
      }

      if (token) {
        setAccessToken(token);
        try {
          const user = await apiFetch<User>('/api/v1/users/me');
          setAuth(token, user);
          navigate(`/channel/${GENERAL_CHANNEL_SLUG}`, { replace: true });
          return;
        } catch {
          // fall through to error
        }
      }

      // Failed to authenticate
      navigate('/login', { replace: true });
    }

    handleCallback();
  }, [navigate, searchParams, setAuth]);

  return (
    <div className="flex min-h-dvh items-center justify-center">
      <p className="text-muted-foreground">Completing sign in...</p>
    </div>
  );
}
