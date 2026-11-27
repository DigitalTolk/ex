import { useMemo } from 'react';
import type { RenderOpts } from '@/lib/markdown';
import { UserHoverCard } from '@/components/UserHoverCard';
import { UserGroupMentionCard } from '@/components/UserGroupMentionCard';

export type MentionRenderOpts = Pick<RenderOpts, 'currentUserId' | 'renderUserMention' | 'renderUserGroupMention'>;

// mentionRenderOpts is how a message draws its @-mentions, wherever its
// markdown is (body, block text, card text): the reader's own highlighted, a
// person's profile on hover, a group's members on click. keyPrefix keeps the
// cards' keys unique per message.
export function mentionRenderOpts(currentUserId: string | undefined, keyPrefix: string): MentionRenderOpts {
  return {
    currentUserId,
    renderUserMention: (userId, displayName, _isSelf, pill) => (
      <UserHoverCard
        key={`mention-${userId}-${keyPrefix}`}
        userId={userId}
        displayName={displayName}
        currentUserId={currentUserId}
        showInlineStatus={false}
        triggerClassName="inline cursor-pointer align-baseline"
      >
        {pill}
      </UserHoverCard>
    ),
    renderUserGroupMention: (groupId, handle, pill) => (
      <UserGroupMentionCard key={`usergroup-${groupId}-${keyPrefix}`} groupId={groupId} handle={handle} currentUserId={currentUserId}>
        {pill}
      </UserGroupMentionCard>
    ),
  };
}

// useMentionRenderOpts is mentionRenderOpts kept stable while the reader is
// the same, so memoized text isn't parsed again on every re-render.
export function useMentionRenderOpts(currentUserId: string | undefined, keyPrefix: string): MentionRenderOpts {
  return useMemo(() => mentionRenderOpts(currentUserId, keyPrefix), [currentUserId, keyPrefix]);
}
