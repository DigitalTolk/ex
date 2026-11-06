import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAddChannelMembers } from '@/hooks/useChannels';
import type { MentionedUser, MentionedUserGroup } from '@/lib/non-member-mentions';

interface NonMemberInvitePromptProps {
  // Optional so every composer can render the prompt unconditionally and let it
  // decide whether to show — conversation (DM) composers pass `undefined` and
  // nothing renders.
  channelId?: string;
  channelName: string;
  users: MentionedUser[];
  // User groups mentioned, each with its members who aren't in the channel.
  groups?: MentionedUserGroup[];
  // Adding people to a private channel shows them its history.
  isPrivate?: boolean;
  onDismiss: () => void;
}

const NO_GROUPS: MentionedUserGroup[] = [];

// Author-facing prompt shown after sending a message that @mentions people not
// in the channel: add one or several of them in one click, without opening the
// member list. Any channel member can invite (enforced server-side).
export function NonMemberInvitePrompt({ channelId, channelName, users, groups = NO_GROUPS, isPrivate = false, onDismiss }: NonMemberInvitePromptProps) {
  const addMembers = useAddChannelMembers();
  // Stays disabled once added: the prompt is on its way out (onDismiss).
  const adding = addMembers.isPending || addMembers.isSuccess;
  const [error, setError] = useState('');

  // Everyone to add: the people named, then each group's missing members.
  const userIds = [...new Set([...users.map((u) => u.id), ...groups.flatMap((g) => g.missingUserIds)])];

  // Nothing to offer (no channel, or no mentioned non-members) → render nothing.
  // Keeping the guard here lets callers mount the prompt unconditionally.
  if (!channelId || userIds.length === 0) return null;

  const addAll = () => {
    setError('');
    addMembers.mutate(
      { channelId, userIds },
      {
        onSuccess: onDismiss,
        onError: (e) => setError(e instanceof Error ? e.message : 'Failed to add to the channel'),
      },
    );
  };

  const names = users.map((u) => u.displayName).join(', ');
  const multiple = users.length > 1;
  let addLabel = multiple ? `Add all (${users.length})` : 'Add to channel';
  if (groups.length > 0) addLabel = `Add them (${userIds.length})`;
  return (
    // The chat's centred column with the composer's gutter, so the card lines
    // up with the composer box below it instead of spanning the whole view.
    <div className="mx-auto w-full max-w-4xl px-3 pt-3 mobile:px-2 mobile:pt-1.5">
      <div
        role="status"
        data-testid="non-member-invite"
        className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border bg-muted/30 px-3 py-2 text-sm"
      >
        {users.length > 0 && (
          <p className="min-w-0 text-muted-foreground">
            <span className="font-medium text-foreground">{names}</span>{' '}
            {multiple ? "aren't" : "isn't"} in ~{channelName} yet.
          </p>
        )}
        {groups.map((g) => (
          <p key={g.groupId} className="min-w-0 text-muted-foreground" data-testid="usergroup-invite">
            <span className="font-medium text-foreground">
              {g.missingUserIds.length} {g.missingUserIds.length === 1 ? 'member' : 'members'} of @{g.handle}
            </span>{' '}
            {g.missingUserIds.length === 1 ? "isn't" : "aren't"} in ~{channelName} yet.
          </p>
        ))}
        {groups.length > 0 && isPrivate && (
          <p className="min-w-0 text-muted-foreground">They&apos;ll be able to see the channel&apos;s history.</p>
        )}
        {error && (
          <span className="text-destructive" role="alert">
            {error}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button size="sm" onClick={addAll} disabled={adding}>
            {adding ? 'Adding…' : addLabel}
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
    </div>
  );
}
