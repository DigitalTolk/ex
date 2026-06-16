import { useState } from 'react';
import { X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { MentionedUser } from '@/lib/non-member-mentions';

interface NonMemberInvitePromptProps {
  // Optional so every composer can render the prompt unconditionally and let it
  // decide whether to show — conversation (DM) composers pass `undefined` and
  // nothing renders.
  channelId?: string;
  channelName: string;
  users: MentionedUser[];
  onDismiss: () => void;
}

// Author-facing prompt shown after sending a message that @mentions people not
// in the channel: add one or several of them in one click, without opening the
// member list. Any channel member can invite (enforced server-side).
export function NonMemberInvitePrompt({ channelId, channelName, users, onDismiss }: NonMemberInvitePromptProps) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');

  // Nothing to offer (no channel, or no mentioned non-members) → render nothing.
  // Keeping the guard here lets callers mount the prompt unconditionally.
  if (!channelId || users.length === 0) return null;

  // Bind the now-narrowed channelId so the closure keeps the `string` type.
  const cid = channelId;
  const addAll = async () => {
    setAdding(true);
    setError('');
    try {
      for (const u of users) {
        await apiFetch(`/api/v1/channels/${encodeURIComponent(cid)}/members`, {
          method: 'POST',
          body: JSON.stringify({ userID: u.id, role: 'member' }),
        });
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.channelMembers(cid) });
      onDismiss();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add to the channel');
      setAdding(false);
    }
  };

  const names = users.map((u) => u.displayName).join(', ');
  const multiple = users.length > 1;
  return (
    <div
      role="status"
      data-testid="non-member-invite"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t bg-muted/30 px-3 py-2 text-sm"
    >
      <p className="min-w-0 text-muted-foreground">
        <span className="font-medium text-foreground">{names}</span>{' '}
        {multiple ? "aren't" : "isn't"} in ~{channelName} yet.
      </p>
      {error && (
        <span className="text-destructive" role="alert">
          {error}
        </span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <Button size="sm" onClick={addAll} disabled={adding}>
          {adding ? 'Adding…' : multiple ? `Add all (${users.length})` : 'Add to channel'}
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onDismiss}
          disabled={adding}
          aria-label="Dismiss invite suggestion"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
