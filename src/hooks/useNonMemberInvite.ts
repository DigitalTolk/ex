import { useCallback, useMemo, useState } from 'react';
import { useChannelMembers, useUserChannels } from '@/hooks/useChannels';
import { slugify } from '@/lib/format';
import { nonMemberMentions, type MentionedUser } from '@/lib/non-member-mentions';
import type { UserChannel } from '@/types';

// useNonMemberInvite drives the author-facing "add the people you just
// @mentioned to this channel" prompt (see NonMemberInvitePrompt). It is shared
// by every composer that can post into a channel — the channel view, the thread
// sidebar, and the /threads cards — so the invite bar behaves identically
// wherever you @mention a non-member.
//
// It is a no-op for conversation (DM) threads: those have no membership to add
// to, so callers pass `undefined` for channelId and nothing is ever surfaced.
export function useNonMemberInvite(channelId: string | undefined, selfId?: string) {
  const { data: members } = useChannelMembers(channelId);
  const [pendingInvites, setPendingInvites] = useState<MentionedUser[]>([]);

  const memberIdSet = useMemo(
    () => new Set(members?.map((m) => m.userID) ?? []),
    [members],
  );

  // The prompt prefixes the channel with "~", so it needs the slug. Derive it
  // from the user's channel list rather than threading a slug prop through
  // every composer — selecting only the slug, so another channel's unread
  // change does not re-render the composer that hosts this hook.
  const selectSlug = useCallback(
    (rows: UserChannel[]) => {
      const name = rows.find((c) => c.channelID === channelId)?.channelName;
      return name ? slugify(name) : '';
    },
    [channelId],
  );
  const { data: channelSlug = '' } = useUserChannels({ select: selectSlug });

  // Call after a successful send: surfaces an invite bar for any mentioned
  // non-members (supersedes a previous prompt; an empty result clears it).
  const checkMentions = useCallback(
    (body: string) => {
      setPendingInvites(channelId ? nonMemberMentions(body, memberIdSet, selfId) : []);
    },
    [channelId, memberIdSet, selfId],
  );

  const clearInvites = useCallback(() => setPendingInvites([]), []);

  return { pendingInvites, channelSlug, checkMentions, clearInvites };
}
