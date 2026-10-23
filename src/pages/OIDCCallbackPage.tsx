import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { apiFetch, refreshAccessToken } from '@/lib/api';
import { takeReturnTo } from '@/lib/return-to';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import type { User } from '@/types';

// The sign-in landing page. The session comes ONLY from the refresh cookie
// the server set when it completed the sign-in (its OIDC callback, or an app
// shell's one-time desktop code): this page never trusts a token — or a
// desktop code — that its URL offers. Accepting one let a crafted link sign
// the clicker into someone else's account.
export default function OIDCCallbackPage() {
  useDocumentTitle('Signing in…');
  const navigate = useNavigate();
  const { setAuth } = useAuth();

  useEffect(() => {
    async function handleCallback() {
      const token = await refreshAccessToken().catch(() => null);
      if (token) {
        try {
          const user = await apiFetch<User>('/api/v1/users/me');
          setAuth(token, user);
          navigate(takeReturnTo('/'), { replace: true });
          return;
        } catch {
          // fall through to the login page
        }
      }
      navigate('/login', { replace: true });
    }

    void handleCallback();
  }, [navigate, setAuth]);

  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-muted-foreground">Completing sign in...</p>
    </div>
  );
}
