import { useCallback, useContext, useMemo, useRef, useState } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { useChannelMembers, useUserChannels } from '@/hooks/useChannels';
import { apiFetch } from '@/lib/api';
import { slugify } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import {
  nonMemberGroupMentions,
  nonMemberMentions,
  typedUserGroupMentions,
  userGroupTokens,
  type MentionedUser,
  type MentionedUserGroup,
} from '@/lib/non-member-mentions';
import type { User, UserChannel } from '@/types';
import type { UserGroup, UserGroupDetail } from '@/types/generated';

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
  // Read from context (not useQueryClient, which throws without a provider):
  // with no client there is nothing to look groups up in, and only the
  // people named are offered.
  const queryClient = useContext(QueryClientContext);
  const [pendingInvites, setPendingInvites] = useState<MentionedUser[]>([]);
  const [pendingGroupInvites, setPendingGroupInvites] = useState<MentionedUserGroup[]>([]);
  // Each check supersedes the previous one; a group lookup that resolves late
  // must not overwrite a newer result.
  const checkSeq = useRef(0);

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
  // Adding people to a private channel shows them its history: the prompt
  // says so.
  const selectPrivate = useCallback(
    (rows: UserChannel[]) => rows.find((c) => c.channelID === channelId)?.channelType === 'private',
    [channelId],
  );
  const { data: channelIsPrivate = false } = useUserChannels({ select: selectPrivate });

  // Group mentions — picked ("@[group-…|oncall]") or typed ("@oncall") — offer
  // the group's members who aren't in the channel. Each group's members come
  // from its detail (cached, else fetched); a disabled or unreadable group is
  // skipped.
  const checkGroupMentions = useCallback(
    (body: string, seq: number) => {
      if (!queryClient) return;
      const known = queryClient.getQueryData<UserGroup[]>(queryKeys.userGroups(false)) ?? [];
      const refs = [...userGroupTokens(body)];
      for (const g of typedUserGroupMentions(body, known)) {
        if (!refs.some((r) => r.id === g.id)) refs.push(g);
      }
      if (refs.length === 0) {
        setPendingGroupInvites([]);
        return;
      }
      void Promise.all(
        refs.map((g) =>
          queryClient
            .fetchQuery({
              queryKey: queryKeys.userGroup(g.id),
              queryFn: () => apiFetch<UserGroupDetail>(`/api/v1/usergroups/${encodeURIComponent(g.id)}`),
              staleTime: 30_000,
            })
            .catch(() => undefined),
        ),
      ).then((details) => {
        if (seq !== checkSeq.current) return;
        const byId = new Map(details.filter((d): d is UserGroupDetail => !!d && !d.disabled).map((d) => [d.id, d.memberIds ?? []]));
        const users = queryClient.getQueryData<User[]>(queryKeys.allUsers()) ?? [];
        const inactive = new Set(users.filter((u) => u.status === 'deactivated').map((u) => u.id));
        setPendingGroupInvites(nonMemberGroupMentions(refs, memberIdSet, (id) => byId.get(id), selfId, (id) => inactive.has(id)));
      });
    },
    [queryClient, memberIdSet, selfId],
  );

  // Call after a successful send: surfaces an invite bar for any mentioned
  // non-members (supersedes a previous prompt; an empty result clears it).
  const checkMentions = useCallback(
    (body: string) => {
      const seq = ++checkSeq.current;
      setPendingInvites(channelId ? nonMemberMentions(body, memberIdSet, selfId) : []);
      if (channelId) {
        checkGroupMentions(body, seq);
      } else {
        setPendingGroupInvites([]);
      }
    },
    [channelId, memberIdSet, selfId, checkGroupMentions],
  );

  const clearInvites = useCallback(() => {
    checkSeq.current++;
    setPendingInvites([]);
    setPendingGroupInvites([]);
  }, []);

  return { pendingInvites, pendingGroupInvites, channelSlug, channelIsPrivate, checkMentions, clearInvites };
}
