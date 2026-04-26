import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { ApiError, apiFetch } from '@/lib/api';

interface InviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Status = 'idle' | 'sent' | 'already-member';

export function InviteDialog({ open, onOpenChange }: InviteDialogProps) {
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [inviteLink, setInviteLink] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setStatus('idle');
    setIsSubmitting(true);
    try {
      const res = await apiFetch<{ token: string }>('/auth/invite', {
        method: 'POST',
        body: JSON.stringify({ email, channelIDs: [] }),
      });
      setInviteLink(`${window.location.origin}/invite/${res.token}`);
      setStatus('sent');
    } catch (err) {
      // 409 Conflict typically means the user already exists / is a member.
      if (err instanceof ApiError && err.status === 409) {
        setStatus('already-member');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to create invite');
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleClose(open: boolean) {
    if (!open) {
      setEmail('');
      setInviteLink('');
      setError('');
      setStatus('idle');
    }
    onOpenChange(open);
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg min-h-[300px]">
        <DialogHeader>
          <DialogTitle>Invite someone</DialogTitle>
        </DialogHeader>

        {status === 'sent' && inviteLink ? (
          <div className="space-y-3">
            <p className="text-sm text-emerald-600 dark:text-emerald-400" role="status">
              Invitation sent! Share this link:
            </p>
            <div className="flex items-center gap-2">
              <Input value={inviteLink} readOnly className="text-sm" />
              <Button size="sm" onClick={() => navigator.clipboard.writeText(inviteLink)}>
                Copy
              </Button>
            </div>
          </div>
        ) : status === 'already-member' ? (
          <div className="space-y-3">
            <div className="rounded-md bg-amber-100 dark:bg-amber-900/30 p-3 text-sm text-amber-900 dark:text-amber-200" role="status">
              User is already a member of this workspace.
            </div>
            <Button
              variant="outline"
              onClick={() => { setStatus('idle'); setEmail(''); }}
            >
              Invite someone else
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">
                {error}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="invite-email">Email address</Label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="colleague@example.com"
                required
                autoFocus
              />
            </div>
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? 'Sending...' : 'Send invitation'}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
