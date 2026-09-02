import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/context/AuthContext';
import { useEmailAdminStatus, useSendTestEmail } from '@/hooks/useEmailAdmin';

/**
 * Mail diagnostics.
 *
 * Verifying email settings otherwise means inviting a real person or resetting
 * a real password and hoping something arrives. This panel shows the effective
 * transport and sends a real message through it, reporting the transport's own
 * error verbatim when it fails — "connection refused" or "535 auth failed" is
 * what an admin needs to fix the configuration.
 */
export function EmailAdminPanel() {
  const { user } = useAuth();
  const { data, isLoading, isError, error } = useEmailAdminStatus();
  const send = useSendTestEmail();
  // Empty means "send to me": the server falls back to the caller's address.
  const [to, setTo] = useState('');

  if (isLoading) {
    return (
      <section className="space-y-4 rounded-lg border bg-card p-5">
        <h2 className="text-base font-semibold">Email</h2>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </section>
    );
  }

  if (isError) {
    return (
      <section className="space-y-4 rounded-lg border bg-card p-5">
        <h2 className="text-base font-semibold">Email</h2>
        <p className="text-sm text-destructive" role="alert">
          {error instanceof Error ? error.message : 'Could not load email status'}
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-4 rounded-lg border bg-card p-5">
      <div>
        <h2 className="text-base font-semibold">Email</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Invitations and password-reset links are delivered by email. Send a
          test message to confirm the settings work before someone depends on
          them.
        </p>
      </div>

      {data?.configured ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Transport</dt>
          <dd data-testid="email-provider">{data.provider}</dd>
          <dt className="text-muted-foreground">From</dt>
          <dd data-testid="email-from">{data.from}</dd>
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="email-unconfigured">
          Email isn't configured for this deployment. Set{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">EMAIL_PROVIDER</code>{' '}
          and its settings, then restart the server. Until then invitations and
          reset links are shown in the app for you to share by hand.
        </p>
      )}

      {data?.configured && (
        <div className="space-y-2">
          <Label htmlFor="test-email-to">Send a test message to</Label>
          <div className="flex items-center gap-2">
            <Input
              id="test-email-to"
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder={user?.email ?? 'you@example.com'}
              autoComplete="off"
              spellCheck={false}
            />
            <Button
              onClick={() => send.mutate(to.trim())}
              disabled={send.isPending}
              className="shrink-0"
            >
              {send.isPending ? 'Sending...' : 'Send test email'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Leave blank to send to {user?.email ?? 'your own address'}.
          </p>

          {send.isSuccess && (
            <p className="text-sm" role="status">
              Test message sent to {send.data.to}. If it doesn't arrive, check
              the spam folder and the sending domain's SPF/DKIM records — the
              server handed it to {send.data.provider} without an error.
            </p>
          )}
          {send.isError && (
            <div
              className="space-y-1 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
              role="alert"
            >
              <p>Sending failed. The transport reported:</p>
              {/* The raw error is the point — it names the actual
                  misconfiguration. */}
              <p className="font-mono text-xs break-words" data-testid="test-email-error">
                {send.error instanceof Error ? send.error.message : 'Unknown error'}
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
