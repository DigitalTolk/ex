import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import { useIsMobile } from '@/hooks/useIsMobile';
import type { User } from '@/types';

interface PasswordResetTicket {
  resetURL: string;
  expiresAt: string;
  emailSent: boolean;
}

interface PasswordResetDialogProps {
  /** The guest whose password is being reset. */
  user: User;
  /** Called when the dialog dismisses; the caller unmounts it. */
  onClose: () => void;
}

/**
 * Admin-initiated password reset for a guest account.
 *
 * The backend emails the one-time link to the guest AND returns it here, so a
 * reset still completes when SMTP is unconfigured or the relay is down — the
 * admin just relays the link themselves. Which of those happened is stated
 * explicitly rather than implied, so an admin never assumes an email went out
 * that did not.
 *
 * Only ever opened for guests: SSO passwords live in the identity provider,
 * and the server rejects a reset for one.
 *
 * The caller renders this only while a target is selected, so switching
 * targets remounts it — a previous guest's link can never be shown under
 * another guest's name, and there is no closed/null state to guard against.
 */
export function PasswordResetDialog({ user, onClose }: PasswordResetDialogProps) {
  const isMobile = useIsMobile();
  const [ticket, setTicket] = useState<PasswordResetTicket | null>(null);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function createReset() {
    setError('');
    setIsSubmitting(true);
    try {
      const res = await apiFetch<PasswordResetTicket>(
        `/api/v1/users/${user.id}/password-reset`,
        { method: 'POST' },
      );
      setTicket(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create reset link');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent
        className="max-w-lg"
        finalFocus={false}
        mobileCloseLabel={ticket ? 'Done' : 'Cancel'}
        mobileAction={
          isMobile && !ticket
            ? { label: 'Create link', onClick: createReset, disabled: isSubmitting }
            : undefined
        }
      >
        <DialogHeader>
          <DialogTitle>Reset password</DialogTitle>
        </DialogHeader>

        {error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">
            {error}
          </div>
        )}

        {ticket ? (
          <div className="space-y-3">
            <p className="text-sm" role="status">
              {ticket.emailSent
                ? `A reset link was emailed to ${user.email}.`
                : 'Email is not configured, so nothing was sent. Share this link with them directly.'}
            </p>
            <div className="flex items-center gap-2">
              {/* No text-sm override — the Input's text-base md:text-sm keeps
                  16px on mobile so a stray tap doesn't iOS-zoom the sheet. */}
              <Input value={ticket.resetURL} readOnly aria-label="Password reset link" />
              <Button
                size="sm"
                onClick={() => navigator.clipboard.writeText(ticket.resetURL)}
              >
                Copy
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              The link can be used once and expires in one hour. Signing in with
              the new password ends their other sessions.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This creates a one-time link for {user.displayName} and emails it
              to {user.email}. Their current password keeps working until they
              choose a new one.
            </p>
            {!isMobile && (
              <Button className="w-full" onClick={createReset} disabled={isSubmitting}>
                {isSubmitting ? 'Creating...' : 'Create reset link'}
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
