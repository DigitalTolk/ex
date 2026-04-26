import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/context/AuthContext';
import { apiFetch, setAccessToken } from '@/lib/api';
import { GENERAL_CHANNEL_SLUG } from '@/lib/roles';
import type { User } from '@/types';

export default function LoginPage() {
  const { token: inviteToken } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { login, setAuth } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isInviteMode = !!inviteToken;

  async function handleGuestLogin(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);
    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Login failed' }));
        throw new Error(data.error?.message || data.error || 'Login failed');
      }
      const data = await res.json();
      setAccessToken(data.accessToken);
      const u = await apiFetch<User>('/api/v1/users/me');
      setAuth(data.accessToken, u);
      navigate(`/channel/${GENERAL_CHANNEL_SLUG}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleInviteAccept(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);
    try {
      const res = await fetch('/auth/invite/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token: inviteToken, displayName, password }),
      });
      if (!res.ok) {
        const data = await res
          .json()
          .catch(() => ({ error: 'Invite acceptance failed' }));
        throw new Error(data.error || 'Invite acceptance failed');
      }
      const data = await res.json();
      setAccessToken(data.accessToken);
      const user = await apiFetch<User>('/api/v1/users/me');
      setAuth(data.accessToken, user);
      navigate(`/channel/${GENERAL_CHANNEL_SLUG}`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Invite acceptance failed',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">
            {isInviteMode ? 'Accept Invitation' : 'Welcome back'}
          </h1>
          <p className="text-muted-foreground">
            {isInviteMode
              ? 'Set up your account to get started'
              : 'Sign in to your workspace'}
          </p>
        </div>

        {error && (
          <div
            className="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
            role="alert"
          >
            {error}
          </div>
        )}

        {isInviteMode ? (
          <form onSubmit={handleInviteAccept} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="displayName">Display Name</Label>
              <Input
                id="displayName"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
                required
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Choose a password"
                required
                minLength={8}
              />
            </div>
            <Button
              type="submit"
              className="w-full"
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Setting up...' : 'Create Account'}
            </Button>
          </form>
        ) : (
          <>
            <Button
              onClick={login}
              className="w-full"
              size="lg"
              aria-label="Sign in with Single Sign-On"
            >
              Sign in with SSO
            </Button>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <Separator />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-muted/40 px-2 text-muted-foreground">
                  Or sign in as guest
                </span>
              </div>
            </div>

            <form onSubmit={handleGuestLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="guest-password">Password</Label>
                <Input
                  id="guest-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Your password"
                  required
                />
              </div>
              <Button
                type="submit"
                variant="secondary"
                className="w-full"
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Signing in...' : 'Sign in'}
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

function Separator() {
  return <div className="w-full border-t border-border" />;
}
