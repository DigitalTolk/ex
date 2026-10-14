import { useCallback, useMemo } from 'react';
import { useActivity, useRemoveActivityItems, useSetActivityItemsRead } from '@/hooks/useActivity';
import { useUserChannels } from '@/hooks/useChannels';
import { useUserConversations } from '@/hooks/useConversations';
import { useEmojiMap } from '@/hooks/useEmoji';
import { useUnfollowThread } from '@/hooks/useThreads';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { copyToClipboard } from '@/lib/clipboard';
import { showToast } from '@/lib/toast';
import { slugify } from '@/lib/format';
import { activityHref, groupActivity, isWebhookItem, type ActivityRow } from '@/lib/activity-feed';
import { selectActivityRow } from '@/stores/sidebar-mode';
import type { ActivityChannelInfo, ActivityConversationInfo } from '@/components/activity/ActivityRow';
import type { Reminder, UserChannel, UserConversation } from '@/types';

// Only what the rows show, so an unread bump on a channel or DM (a new list
// array every message) doesn't re-render the panel: structural sharing keeps
// these selections' references while names and types are unchanged.
export const selectChannels = (rows: UserChannel[]) =>
  rows.map((c) => ({ id: c.channelID, name: c.channelName, private: c.channelType === 'private' }));
export const selectConversations = (rows: UserConversation[]) =>
  rows.map((c) => ({ id: c.conversationID, name: c.displayName, group: c.type === 'group' }));

// useActivityRowData is everything an Activity row needs to render and act:
// the grouped rows, the names and places they refer to, their deep links and
// the read/remove handlers. Shared by the Activity sidebar list and the
// hover preview on the bell, so the two never drift.
export function useActivityRowData() {
  const { data: feed, isLoading, isError, refetch } = useActivity();
  const { data: channels } = useUserChannels({ select: selectChannels });
  const { data: conversations } = useUserConversations({ select: selectConversations });
  const { data: emojiMap } = useEmojiMap();
  const setItemsRead = useSetActivityItemsRead();
  const removeItems = useRemoveActivityItems();
  const unfollowThread = useUnfollowThread();

  const channelByID = useMemo(() => {
    const m = new Map<string, ActivityChannelInfo>();
    for (const c of channels ?? []) m.set(c.id, c);
    return m;
  }, [channels]);
  const slugByChannelID = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of channels ?? []) m.set(c.id, slugify(c.name));
    return m;
  }, [channels]);
  const conversationByID = useMemo(() => {
    const m = new Map<string, ActivityConversationInfo>();
    for (const c of conversations ?? []) m.set(c.id, c);
    return m;
  }, [conversations]);

  const items = useMemo(() => feed?.items ?? [], [feed]);
  const allRows = useMemo(() => groupActivity(items), [items]);
  const hrefFor = useCallback((i: Reminder | ActivityRow['lead']) => activityHref(i, slugByChannelID), [slugByChannelID]);

  // Names for the people the rows name (each row names its newest actor).
  const actorIDs = useMemo(
    () => allRows.flatMap((r) => (r.lead.actorID && !isWebhookItem(r.lead) ? [r.lead.actorID] : [])),
    [allRows],
  );
  const { map: users } = useUsersBatch(actorIDs);

  const setRead = setItemsRead.mutate;
  const remove = removeItems.mutate;
  // Opening a row selects it and reads its unread items.
  const openRow = useCallback(
    (row: ActivityRow) => {
      selectActivityRow(row.key);
      if (row.unreadIDs.length > 0) setRead({ ids: row.unreadIDs, read: true });
    },
    [setRead],
  );
  // Marking a row unread marks its newest item, so the row reads unread
  // without counting every message in a busy conversation again.
  const onSetRead = useCallback(
    (row: ActivityRow, read: boolean) => setRead({ ids: read ? row.unreadIDs : [row.lead.id], read }),
    [setRead],
  );
  const onRemove = useCallback((row: ActivityRow) => remove(row.items.map((i) => i.id)), [remove]);
  // "Clear all before this": every item older than the row goes.
  const onClearBefore = useCallback(
    (row: ActivityRow) => {
      const ids = items.filter((i) => i.createdAt < row.lead.createdAt).map((i) => i.id);
      if (ids.length > 0) remove(ids);
    },
    [items, remove],
  );
  const onCopyLink = useCallback(
    (row: ActivityRow) => {
      void copyToClipboard(new URL(hrefFor(row.lead), window.location.origin).toString()).then(() => showToast('Link copied', 'success'));
    },
    [hrefFor],
  );
  // "Turn off notifications for replies": stop following the thread the
  // row's reply belongs to.
  const unfollow = unfollowThread.mutate;
  const onMuteThread = useCallback(
    (row: ActivityRow) => {
      const { lead } = row;
      unfollow(
        {
          parentID: lead.parentID,
          parentType: lead.parentType === 'conversation' ? 'conversation' : 'channel',
          threadRootID: lead.parentMessageID || lead.messageID,
        },
        {
          onSuccess: () => showToast('You will no longer be notified about replies in this thread', 'success'),
          onError: () => showToast("Couldn't turn off notifications — please try again."),
        },
      );
    },
    [unfollow],
  );
  // The channel slug a row's reminder deep link needs; undefined for a DM.
  const slugFor = useCallback((row: ActivityRow) => slugByChannelID.get(row.lead.parentID), [slugByChannelID]);

  return {
    feed,
    isLoading,
    isError,
    refetch,
    items,
    allRows,
    hrefFor,
    slugFor,
    users,
    emojiMap,
    channelByID,
    conversationByID,
    setRead,
    openRow,
    onSetRead,
    onRemove,
    onClearBefore,
    onCopyLink,
    onMuteThread,
  };
}
