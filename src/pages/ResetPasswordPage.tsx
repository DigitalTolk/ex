import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { captureServerVersion } from '@/lib/api';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { UpdateBanner } from '@/components/UpdateBanner';

/**
 * Password recovery for guest (local password) accounts, in two modes driven
 * by the route:
 *
 *  - /forgot-password        request a reset link by email
 *  - /reset-password/:token  redeem that link and choose a new password
 *
 * SSO users never reach a working path here: the backend silently ignores a
 * request for an OIDC address (answering the same way it does for an unknown
 * one, so neither can be probed) and refuses to redeem a token onto one.
 */
export default function ResetPasswordPage() {
  const { token } = useParams<{ token: string }>();
  const isRedeemMode = !!token;
  useDocumentTitle(isRedeemMode ? 'Choose a new password' : 'Reset password');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function post(path: string, body: unknown) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    captureServerVersion(res);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error?.message || data.error || 'Something went wrong');
    }
  }

  async function handleRequest(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);
    try {
      await post('/auth/password/forgot', { email });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleRedeem(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    // Checked here as well as by the browser's required/minLength so the
    // mismatch message is specific rather than a generic validation bubble.
    if (password !== confirmPassword) {
      setError('The two passwords do not match');
      return;
    }
    setIsSubmitting(true);
    try {
      await post('/auth/password/reset', { token, password });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setIsSubmitting(false);
    }
  }

  const heading = isRedeemMode ? 'Choose a new password' : 'Reset your password';

  return (
    <div className="flex min-h-dvh flex-col bg-muted/40">
      <UpdateBanner />
      <div className="flex min-h-0 flex-1 items-center justify-center px-4">
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center space-y-2">
            <h1 className="text-2xl font-bold tracking-tight">{heading}</h1>
            <p className="text-muted-foreground">
              {isRedeemMode
                ? 'Pick something you have not used before'
                : 'We will email you a link to set a new one'}
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

          {done ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground" role="status">
                {isRedeemMode
                  ? 'Your password has been changed. You have been signed out everywhere else.'
                  : 'If that address belongs to a guest account, a reset link is on its way. The link expires in one hour.'}
              </p>
              <Link to="/login" className={buttonVariants({ className: 'w-full' })}>
                Back to sign in
              </Link>
            </div>
          ) : isRedeemMode ? (
            <form onSubmit={handleRedeem} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="new-password">New password</Label>
                <Input
                  id="new-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  required
                  minLength={8}
                  autoFocus
                  autoComplete="new-password"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm-password">Confirm password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Repeat your new password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                />
              </div>
              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? 'Saving...' : 'Set new password'}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleRequest} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="reset-email">Email</Label>
                <Input
                  id="reset-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  autoFocus
                  autoComplete="email"
                />
              </div>
              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? 'Sending...' : 'Email me a reset link'}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Signing in with SSO? Your password is managed by your identity
                provider, not here.
              </p>
            </form>
          )}

          {!done && (
            <div className="text-center">
              <Link
                to="/login"
                className="text-sm text-muted-foreground underline-offset-4 hover:underline"
              >
                Back to sign in
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
