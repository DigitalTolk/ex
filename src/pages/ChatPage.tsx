import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AppLayout } from '@/components/layout/AppLayout';
import { useUnread } from '@/context/UnreadContext';
import { useAuth } from '@/context/AuthContext';
import { refreshPresence } from '@/context/PresenceContext';
import { usePresenceStore } from '@/stores/presence';
import { useNotifications } from '@/context/NotificationContext';
import { clearTyping, recordTyping, setSelfUserID } from '@/stores/typing';
import { useWebSocket } from '@/hooks/useWebSocket';
import { applyServerVersionEvent } from '@/hooks/useServerVersion';
import {
  applyActivityChangedEvent,
  applyActivityNewEvent,
  applyRemindersChangedEvent,
  refetchActivity,
} from '@/hooks/useActivity';
import { applyEmojiAddedEvent, applyEmojiRemovedEvent, invalidateEmojis } from '@/hooks/useEmoji';
import { EventType } from '@/lib/event-types';
import type { WSEventHandlers } from '@/lib/ws-events';
import { sendWS } from '@/lib/ws-sender';
import { localTimeZone } from '@/lib/user-time';
import { isUserAttentive, suppressionWindowMs } from '@/lib/user-activity';
import { classifyParentArrival, resolveParentKind } from '@/lib/message-arrival';
import { isAtBottom, isAtLiveTail, isReadHeld, noteMissedArrival, releaseRead, setUnreadAnchor, threadReadKey } from '@/lib/read-position';
import { slugify } from '@/lib/format';
import { isOwnMessage } from '@/lib/message-users';
import {
  appendMessageToCache,
  appendReplyToThreadCache,
  invalidateThreadBothScopes,
  invalidateUnfurlsForMessage,
  markMessageDeletedInCache,
  patchMessageInThreadCache,
  resyncMessageCache,
  updateMessageInCache,
} from '@/hooks/useMessages';
import { queryKeys } from '@/lib/query-keys';
import { applyUserUpdatedEvent } from '@/lib/user-cache';
import {
  onRunProgress as onAgentRunProgress,
  onRunUpdated as onAgentRunUpdated,
} from '@/stores/agent-runs';
import { onRunApproval as onAgentRunApproval } from '@/stores/agent-approvals';
import { RunActivityDrawer } from '@/components/chat/RunActivityDrawer';
import { DesktopRunnerAutostart } from '@/components/runners/DesktopRunnerAutostart';
import { hasDesktopRunner } from '@/lib/desktop-runner';
import { markParentRead } from '@/lib/mark-read';
import {
  bumpChannelUnread,
  bumpConversationUnread,
  cachedUnreadCount,
  clearChannelUnreadInCache,
  clearConversationUnreadInCache,
  touchConversationActivityInCache,
  setChannelNotifyCountInCache,
  setConversationNotifyCountInCache,
} from '@/lib/unread-cache';
import { shouldRefetchDraftsForRemoteUpdate, useDrafts } from '@/hooks/useDrafts';
import { useUserChannels } from '@/hooks/useChannels';
import { useUserConversations } from '@/hooks/useConversations';
import { shouldRefetchSidebarForRemoteUpdate, useCategories } from '@/hooks/useSidebar';
import { shouldRefetchUserStateForRemoteUpdate, useUserState } from '@/hooks/useUserState';
import { followConvertedConversation } from '@/hooks/useConvertConversation';
import { markThreadSeen, upsertUserThreadFromRoot, upsertUserThreadRow, userThreadInCache, useUserThreads } from '@/hooks/useThreads';
import { useIsMobile } from '@/hooks/useIsMobile';

// How long the phone's chat waits for its first lists before offering Retry.
export const CHAT_LOADING_RETRY_MS = 5_000;

// The phone's chat while its first lists load. This used to be an empty gray
// pane: a request that never settled (sent over a connection the network
// dropped while the app was suspended) left it gray until the app was killed.
// Requests are bounded now (lib/api) and retried, and this says so — with a
// Retry that sends whatever is still stuck again.
function MobileChatLoadingPage({ onRetry }: { onRetry: () => void }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), CHAT_LOADING_RETRY_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-sidebar"
      role="status"
      aria-label="Loading chat"
      data-testid="mobile-chat-loading"
    >
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">Connecting…</p>
      {slow && (
        <Button variant="outline" size="sm" onClick={onRetry} data-testid="mobile-chat-loading-retry">
          Retry
        </Button>
      )}
    </div>
  );
}

function queryReady(query: { isSuccess: boolean; isError: boolean; isPlaceholderData?: boolean }): boolean {
  return query.isError || (query.isSuccess && !query.isPlaceholderData);
}

function MobileChatReadyGate({ children }: { children: ReactNode }) {
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const channels = useUserChannels({ enabled: isMobile });
  const conversations = useUserConversations({ enabled: isMobile });
  const categories = useCategories({ enabled: isMobile });
  const drafts = useDrafts({ enabled: isMobile });
  const userState = useUserState({ enabled: isMobile });
  const threads = useUserThreads({ enabled: isMobile });

  if (isMobile && ![channels, conversations, categories, drafts, userState, threads].every(queryReady)) {
    // Send whatever is still out again. A reset drops the stuck request and
    // starts over (a refetch would only re-join a first load in flight).
    const retry = () => {
      for (const query of queryClient.getQueryCache().findAll({ type: 'active', fetchStatus: 'fetching' })) {
        void queryClient.resetQueries({ queryKey: query.queryKey, exact: true });
      }
    };
    return <MobileChatLoadingPage onRetry={retry} />;
  }

  return <>{children}</>;
}

export default function ChatPage() {
  const {
    isActiveChannel,
    isActiveConversation,
    markThreadNotificationUnread,
    isActiveThread: isActiveThreadScope,
    unhideConversation,
  } = useUnread();
  const { user, logout, patchUser } = useAuth();
  // Presence and typing are written straight to their stores: reading them
  // through usePresence()/useTyping() subscribed this root — and with it the
  // whole layout — to every presence and typing event in the workspace.
  const { dispatch: dispatchNotification, notifyApproval, setCurrentUserID } = useNotifications();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const reportedTimeZoneRef = useRef('');
  const activeThreadID = new URLSearchParams(location.search).get('thread');
  // A thread counts as active if it's the URL-driven thread (?thread=) OR a
  // locally-opened one ("Reply in thread"), which the views register in the
  // Unread context. Without the latter, replies to a locally-opened thread
  // would keep the Threads nav highlighted even while it's on screen.
  const isActiveThread = (threadRootID?: string) =>
    !!threadRootID && (activeThreadID === threadRootID || isActiveThreadScope(threadRootID));

  useEffect(() => {
    setCurrentUserID(user?.id ?? null);
    setSelfUserID(user?.id ?? null);
    return () => {
      setCurrentUserID(null);
      setSelfUserID(null);
    };
  }, [user?.id, setCurrentUserID]);

  // After a gap in the socket (reconnect, or a replay the server could no
  // longer serve), refetch what the durable inbox doesn't carry: the list
  // metadata, and everything driven by ephemeral events — the activity feed
  // and pending reminders (activity.*, reminders.changed), the Scheduled list,
  // and presence. resyncMessageCache is the safety net for any message-inbox
  // gap a replay didn't cover. The refetched channel/conversation lists carry
  // the authoritative server unread counts, so there's nothing else to reset.
  const refreshAfterGap = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
    queryClient.invalidateQueries({ queryKey: queryKeys.userConversations() });
    queryClient.invalidateQueries({ queryKey: queryKeys.userThreads() });
    queryClient.invalidateQueries({ queryKey: queryKeys.userState() });
    queryClient.invalidateQueries({ queryKey: queryKeys.drafts() });
    queryClient.invalidateQueries({ queryKey: queryKeys.scheduledMessages() });
    queryClient.invalidateQueries({ queryKey: queryKeys.channelMembers() });
    queryClient.invalidateQueries({ queryKey: queryKeys.activity() });
    queryClient.invalidateQueries({ queryKey: queryKeys.reminders() });
    // These never go stale on a timer (wsLiveQueryOptions), so a missed
    // category change or thread reply is only caught here.
    queryClient.invalidateQueries({ queryKey: queryKeys.sidebarCategories() });
    queryClient.invalidateQueries({ queryKey: ['thread'] });
    void resyncMessageCache(queryClient);
    // presence.changed is ephemeral (never replayed): every transition that
    // happened while disconnected is gone, so refetch the authoritative online
    // set or the dots drift stale until the next full re-auth.
    refreshPresence(queryClient);
  };

  // A channel was archived or unarchived: refetch it (by ID and by slug, so
  // whichever view is open picks up the read-only flag) and the sidebar list.
  const refreshArchivedState = ({ channelID }: { channelID: string }) => {
    queryClient.invalidateQueries({ queryKey: queryKeys.channel(channelID) });
    queryClient.invalidateQueries({ queryKey: queryKeys.channelBySlug() });
    queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
    queryClient.invalidateQueries({ queryKey: queryKeys.browseChannels() });
  };

  // userchannel.updated payload we can't read: the old blanket refresh is the
  // safe floor.
  const refreshUserChannelState = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
    queryClient.invalidateQueries({ queryKey: queryKeys.userConversations() });
    queryClient.invalidateQueries({ queryKey: queryKeys.sidebarCategories() });
    queryClient.invalidateQueries({ queryKey: queryKeys.userState() });
  };

  // One handler per event (lib/ws-events): useWebSocket validates each frame's
  // payload against its event's schema and hands the parsed value here.
  const handlers: WSEventHandlers = {
    [EventType.MessageNew]: (msg) => {
      const { parentID, parentMessageID, authorID } = msg;
      // The author has finished typing the moment their message lands;
      // drop them from the indicator immediately rather than waiting
      // up to 6s for the expiry to tick. Pass parentMessageID so a
      // thread reply clears the thread bucket (not the main one).
      clearTyping(parentID, authorID, parentMessageID ?? '');
      const userChannels = queryClient.getQueryData<{ channelID: string }[]>(queryKeys.userChannels()) ?? [];
      const userConversations = queryClient.getQueryData<{ conversationID: string }[]>(queryKeys.userConversations()) ?? [];
      const parentKind = resolveParentKind(
        msg.parentType,
        userChannels.some((channel) => channel.channelID === parentID),
        userConversations.some((conv) => conv.conversationID === parentID),
      );
      // A webhook post is authored by the `webhook` sentinel (legacy rows: by
      // its creator) and is never "your own message", even for the webhook's
      // creator — so it bumps their unread indicator like the desktop alert
      // the backend sends them.
      const isOwnAuthor = isOwnMessage(msg, user?.id);
      // What this message does to its parent's unread state is a pure rule
      // (lib/message-arrival, mirrored from CLAUDE.md's truth table): only a
      // top-level, non-system message from someone else counts; and "the
      // route is open" only reads it while the user is demonstrably LOOKING
      // (the ghost-DM bug). The views re-mark read on window focus.
      const viewingParent =
        parentKind === 'channel'
          ? isActiveChannel(parentID)
          : parentKind === 'conversation' && isActiveConversation(parentID);
      const atLiveTail = isAtLiveTail(parentID);
      const arrival = classifyParentArrival({
        isOwnAuthor,
        isThreadReply: !!parentMessageID,
        isSystem: !!msg.system,
        viewingParent,
        attentive: isUserAttentive(suppressionWindowMs),
        atBottom: isAtBottom(parentID) && atLiveTail,
        held: isReadHeld(parentID),
      });
      if (arrival === 'bump-unread' && viewingParent && parentKind) {
        if (!atLiveTail) {
          // The open list is a window of older history (opened from a link):
          // the message can't be shown in it, so the list offers a pill.
          noteMissedArrival(parentID);
        } else if (!cachedUnreadCount(queryClient, parentKind, parentID)) {
          // Arriving unseen in the open chat (window away, scrolled up, or held
          // unread): the first unread starts the "New messages" line.
          setUnreadAnchor(parentID, { kind: 'message', messageID: msg.id }, { replace: true });
        }
      }
      // Posting reads the parent for you server-side, so your own top-level
      // post ends a "Mark as unread" hold.
      if (isOwnAuthor && !parentMessageID && parentKind && isReadHeld(parentID)) {
        releaseRead(parentID);
        if (parentKind === 'channel') clearChannelUnreadInCache(queryClient, parentID);
        else clearConversationUnreadInCache(queryClient, parentID);
      }
      if (parentKind && arrival === 'mark-read') {
        // Watching it happen — clear any badge left over from an idle
        // spell and keep the server caught up for reloads.
        void markParentRead(queryClient, { kind: parentKind, id: parentID });
      } else if (arrival === 'bump-unread') {
        // Patch the unread count straight into the list cache (single
        // source) — no session delta to reconcile.
        if (parentKind === 'channel') bumpChannelUnread(queryClient, parentID);
        else if (parentKind === 'conversation') bumpConversationUnread(queryClient, parentID);
      }
      if (parentKind === 'conversation') {
        if (isOwnAuthor || !isActiveConversation(parentID)) {
          unhideConversation(parentID);
        }
      }
      // Patch the message-list cache directly. invalidateQueries here
      // would walk forward from pages[0] and truncate deep-link page
      // chains (see appendMessageToCache). Thread replies don't touch
      // the main list — the parent's replyCount/lastReplyAt/authors
      // arrive via the message.edited event the backend publishes
      // alongside message.new (driven by IncrementReplyMetadata).
      if (parentMessageID) {
        const threadKey = threadReadKey(parentMessageID);
        // Posting reads the thread for you, ending a "Mark as unread" hold.
        if (isOwnAuthor) releaseRead(threadKey);
        if (isActiveThread(parentMessageID) && !isReadHeld(threadKey)) {
          // Reading OTHERS' replies persists the seen watermark. Your own
          // reply is marked seen server-side by the backend ("posting
          // reads the thread for you"), so skip the redundant PUT and only
          // bump the local seen map.
          markThreadSeen(
            parentMessageID,
            msg.createdAt,
            isOwnAuthor
              ? undefined
              : {
                  parentID,
                  parentType: msg.parentType === 'conversation' ? 'conversation' : 'channel',
                },
          );
        }
        // Append the reply straight into the open thread's cache so the
        // ThreadPanel / ThreadCard updates live. Only fall back to an
        // invalidate when the thread isn't cached (panel closed) — a reply to
        // a closed thread has nothing to patch, and re-opening fetches fresh,
        // so the fallback is a near no-op that avoids a refetch-driven flicker
        // on the visible thread.
        if (!appendReplyToThreadCache(queryClient, parentID, parentMessageID, msg)) {
          invalidateThreadBothScopes(queryClient, parentID, parentMessageID, msg.parentType);
        }
        // NOTE: /threads is patched from the root's message.edited event
        // (upsertUserThreadFromRoot in the message.edited handler), NOT
        // invalidated here — an invalidate would refetch ListUserThreads, whose
        // eventually-consistent DynamoDB read can race the just-written thread
        // state and clobber the patch. The notification handler refetches only
        // for threads we can't patch (non-member participants).
      } else {
        appendMessageToCache(queryClient, parentID, msg);
      }
    },
    [EventType.MessageEdited]: (msg) => {
      const { parentID, parentMessageID, id } = msg;
      updateMessageInCache(queryClient, parentID, msg);
      // Patch the thread cache in place instead of invalidating it, so a
      // reaction/edit/pin echoed over WS updates the message in /threads and
      // the ThreadPanel immediately (no refetch flicker), matching the in-place
      // update the main message list gets above.
      patchMessageInThreadCache(queryClient, parentID, parentMessageID || id, msg);
      // A thread root's replyCount/lastReplyAt bump (published alongside every
      // reply) patches the /threads list directly — this is what keeps /threads
      // live without a refetch, avoiding the read-after-write race.
      upsertUserThreadFromRoot(queryClient, msg);
      // Link-preview cards pointing at this message (in other channels)
      // are now stale — refetch them so the edited body/attachments show.
      invalidateUnfurlsForMessage(queryClient, id);
    },
    [EventType.MessageDeleted]: (msg) => {
      const { parentID, parentMessageID, id } = msg;
      markMessageDeletedInCache(queryClient, parentID, id, parentMessageID, msg);
      invalidateThreadBothScopes(queryClient, parentID, parentMessageID || id, msg.parentType);
      invalidateUnfurlsForMessage(queryClient, id);
      // /threads page reads body + replyCount via the userThreads list;
      // a deletion can change either, so refresh the list too.
      queryClient.invalidateQueries({ queryKey: queryKeys.userThreads() });
    },
    [EventType.MembersChanged]: ({ channelID }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.channelMembers(channelID) });
      queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
      // The "X was added/removed" system message arrives via message.new
      // and is appended via appendMessageToCache. Invalidating the
      // message list here would walk forward from pages[0] and truncate
      // a deep-linked page chain.
    },
    [EventType.ConversationNew]: () => {
      // Refresh conversation list in sidebar
      queryClient.invalidateQueries({ queryKey: queryKeys.userConversations() });
    },
    [EventType.ConversationConverted]: (evt) => followConvertedConversation(queryClient, evt, navigate),
    // Archiving no longer removes anyone: the channel turns read-only (or,
    // unarchived, writable again) in place. Refetch it and the sidebar list —
    // the open view swaps its composer for the archived notice; nobody is
    // navigated away.
    [EventType.ChannelArchived]: refreshArchivedState,
    [EventType.ChannelUnarchived]: refreshArchivedState,
    [EventType.ChannelRemoved]: ({ channelID }) => {
      const userChannels = queryClient.getQueryData<{ channelID: string; channelName: string }[]>(queryKeys.userChannels());
      const open = userChannels?.find((c) => c.channelID === channelID);
      queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
      queryClient.invalidateQueries({ queryKey: queryKeys.channelMembers(channelID) });
      // The directory's BrowsePublic results are guest-scoped (only joined
      // channels), so a kicked-out guest must refetch to drop the channel
      // they no longer belong to from the listing.
      queryClient.invalidateQueries({ queryKey: queryKeys.browseChannels() });
      if (open && window.location.pathname.endsWith(`/channel/${slugify(open.channelName)}`)) {
        navigate('/', { replace: true });
      }
    },
    // A rename, a new description or a public channel made private: the
    // directory and channel browser list it differently too.
    [EventType.ChannelUpdated]: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.channelBySlug() });
      queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
      queryClient.invalidateQueries({ queryKey: queryKeys.browseChannels() });
    },
    [EventType.ChannelNew]: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.browseChannels() });
      queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
    },
    [EventType.PresenceChanged]: ({ userID, online }) => {
      usePresenceStore.getState().setUserOnline(userID, online);
    },
    // Patched from the payload: a refetch per client per catalogue change,
    // and a fresh emoji map that re-hydrated every mounted message body.
    [EventType.EmojiAdded]: (emoji) => applyEmojiAddedEvent(queryClient, emoji),
    [EventType.EmojiRemoved]: ({ name }) => applyEmojiRemovedEvent(queryClient, name),
    [EventType.WebhookChanged]: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.incomingWebhooks() });
    },
    [EventType.ProjectChanged]: () => {
      // A project or its design references changed (any member, any device):
      // the list and every open project detail refetch.
      queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
    },
    [EventType.SettingsUpdated]: () => {
      // An admin saved the workspace settings — refetch what they gate (the
      // Runners tab appears or goes away without a reload).
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaceSettings() });
    },
    [EventType.RunnersChanged]: () => {
      // One of my computers was connected or disconnected, or came online.
      queryClient.invalidateQueries({ queryKey: queryKeys.runnerTokens() });
    },
    // An item landed in the activity stream — add it from the payload so the
    // sidebar badge + list update without refetching the whole feed.
    [EventType.ActivityNew]: ({ item }) => applyActivityNewEvent(queryClient, item),
    // A reminder was set or cancelled (here or on another device), fired, or
    // went with its message or channel — refetch the pending list.
    [EventType.RemindersChanged]: () => applyRemindersChangedEvent(queryClient),
    [EventType.ScheduledMessagesChanged]: () => {
      // Scheduled, edited, sent or failed on another tab/device (or by the
      // server at send time) — refetch the Scheduled list.
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduledMessages() });
    },
    // Items were marked read/unread or removed (here or on another device),
    // so every device's badge follows instead of lingering until the next
    // activity.new (SPEC GAP-3 / I-4).
    [EventType.ActivityRead]: (change) => applyActivityChangedEvent(queryClient, change),
    // Participant-scoped reply metadata: the server only sends this to users
    // who belong in the thread, so patch the /threads row directly from the
    // payload — no participation guess, no eventually-consistent refetch. This
    // covers threads the viewer didn't author (which the message.edited-driven
    // upsertUserThreadFromRoot deliberately skips) and the sender's own tabs.
    [EventType.ThreadUpdated]: (summary) => upsertUserThreadRow(queryClient, summary),
    [EventType.UserUpdated]: (updated) => {
      const currentUser = user;
      if (currentUser && updated.id === currentUser.id) {
        patchUser({
          ...(Object.prototype.hasOwnProperty.call(updated, 'userStatus')
            ? { userStatus: updated.userStatus ?? undefined }
            : {}),
          ...(updated.timeZone !== undefined ? { timeZone: updated.timeZone } : {}),
          ...(updated.lastSeenAt !== undefined ? { lastSeenAt: updated.lastSeenAt } : {}),
          ...(updated.phone !== undefined ? { phone: updated.phone } : {}),
          ...(updated.manager !== undefined ? { manager: updated.manager ?? undefined } : {}),
        });
      }
      // Every cached copy of the user (profile, batches, roster, searches,
      // the directory, member lists, DM rows) takes the changed fields in
      // place; see lib/user-cache.
      applyUserUpdatedEvent(queryClient, updated, currentUser?.id);
    },
    [EventType.UserChannelUpdated]: (evt) => {
      // userchannel.updated multiplexes several per-user sidebar changes;
      // dispatch on the payload instead of blanket-invalidating four
      // queries. That blanket refetch ran on EVERY conversation send (the
      // backend fans an activity touch to all participants, including the
      // author), so each sent DM cost four extra list fetches.
      if (evt.conversationID && evt.updatedAt !== undefined) {
        // Top-level message activity: bump the row's updatedAt in place so
        // the sidebar re-sorts. A missing row (just-activated conversation
        // not yet listed) falls back to one targeted refetch.
        if (!touchConversationActivityInCache(queryClient, evt.conversationID, evt.updatedAt)) {
          queryClient.invalidateQueries({ queryKey: queryKeys.userConversations() });
        }
        return;
      }
      if (evt.threads) {
        // A thread was followed or unfollowed elsewhere: its list and its
        // unread alert changed.
        queryClient.invalidateQueries({ queryKey: queryKeys.userThreads() });
        queryClient.invalidateQueries({ queryKey: queryKeys.userState() });
        return;
      }
      if (evt.userState) {
        // Skip the echo of THIS tab's own user-state write (thread-seen
        // PUTs, the server-side author-seen a thread reply triggers) — the
        // tab already has that state; other tabs never arm the window.
        if (shouldRefetchUserStateForRemoteUpdate()) {
          queryClient.invalidateQueries({ queryKey: queryKeys.userState() });
        }
        return;
      }
      if (evt.categories) {
        // Category CRUD re-buckets rows; refetch the grouping inputs.
        queryClient.invalidateQueries({ queryKey: queryKeys.sidebarCategories() });
        queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
        queryClient.invalidateQueries({ queryKey: queryKeys.userConversations() });
        return;
      }
      if (
        evt.favorite !== undefined ||
        evt.categoryID !== undefined ||
        evt.sidebarPosition !== undefined ||
        evt.notificationPrefs !== undefined
      ) {
        // Skip the echo of THIS tab's own drag-reorder — the optimistic
        // cache already holds the authoritative order we just wrote, and a
        // refetch here reads eventually-consistent DynamoDB that can return
        // the pre-reorder order and snap the row back (the "doesn't stick"
        // bug). A position/category/favorite change from ANOTHER tab (window
        // not armed) still refetches.
        if (evt.sidebarPosition !== undefined && !shouldRefetchSidebarForRemoteUpdate()) {
          return;
        }
        // Row-level preference change (rare, user-initiated): refetch the
        // affected list; category/position moves also re-bucket.
        queryClient.invalidateQueries({
          queryKey: evt.channelID ? queryKeys.userChannels() : queryKeys.userConversations(),
        });
        if (evt.categoryID !== undefined || evt.sidebarPosition !== undefined) {
          queryClient.invalidateQueries({ queryKey: queryKeys.sidebarCategories() });
        }
        return;
      }
      if (evt.unread && (evt.channelID || evt.conversationID)) {
        // Marked unread in another tab/device: refetch the row for the
        // server's rewound count.
        queryClient.invalidateQueries({
          queryKey: evt.channelID ? queryKeys.userChannels() : queryKeys.userConversations(),
        });
        return;
      }
      if (evt.channelID) {
        // Bare {channelID}: the user read this channel in another tab —
        // clear the badge in place, no refetch.
        clearChannelUnreadInCache(queryClient, evt.channelID);
        return;
      }
      if (evt.conversationID) {
        clearConversationUnreadInCache(queryClient, evt.conversationID);
        return;
      }
      refreshUserChannelState();
    },
    [EventType.SidebarUpdated]: () => {
      // A server-side sidebar reorder committed (the move endpoint). The
      // ACTING tab already holds the truth from the move response and armed
      // the echo-ignore window — other tabs/devices refetch both lists so
      // their order converges on what the server computed.
      if (!shouldRefetchSidebarForRemoteUpdate()) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
      queryClient.invalidateQueries({ queryKey: queryKeys.userConversations() });
    },
    [EventType.AttachmentDeleted]: ({ id }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.attachment(id) });
    },
    [EventType.ChannelMuted]: () => {
      // Either tab toggled mute — refetch the user's channel list so the
      // sidebar bell-slash indicator stays in sync across browser tabs.
      queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
    },
    // Account-level notification settings changed (another tab/device).
    // Patch the in-memory user so every open settings surface reflects it.
    [EventType.NotificationSettingsUpdated]: ({ settings }) => patchUser({ notificationSettings: settings }),
    [EventType.NotificationNew]: (n) => {
      if (n.parentMessageID) {
        // A thread marked unread stays unread even while open.
        if (isActiveThread(n.parentMessageID) && !isReadHeld(threadReadKey(n.parentMessageID))) {
          markThreadSeen(n.parentMessageID, n.createdAt, {
            parentID: n.parentID,
            parentType: n.parentType,
          });
        } else {
          markThreadNotificationUnread(n.parentMessageID);
        }
        // Only refetch /threads when we couldn't patch the row from the root's
        // message.edited event (e.g. a thread participant who isn't a channel
        // member, so never receives the channel-topic events). When the row is
        // already present, refetching would just re-run the race-prone read and
        // risk clobbering the patched row.
        if (!userThreadInCache(queryClient, n.parentMessageID)) {
          queryClient.invalidateQueries({ queryKey: queryKeys.userThreads() });
        }
        queryClient.invalidateQueries({ queryKey: queryKeys.userState() });
      }
      // A top-level channel/DM notification.new is the ALERT (popup/sound,
      // handled by NotificationContext) AND it carries the recipient's
      // authoritative alerted-unread badge — SET the sidebar row to it (the
      // plain availability indicator still rides message.new). Thread
      // notifications never touch parent badges (the Threads nav owns them).
      if (!n.parentMessageID && typeof n.parentUnreadNotifyCount === 'number' && n.parentUnreadNotifyCount > 0) {
        if (n.parentType === 'conversation') {
          setConversationNotifyCountInCache(queryClient, n.parentID, n.parentUnreadNotifyCount);
        } else {
          setChannelNotifyCountInCache(queryClient, n.parentID, n.parentUnreadNotifyCount);
        }
      }
      dispatchNotification(n);
    },
    [EventType.DraftUpdated]: () => {
      if (!shouldRefetchDraftsForRemoteUpdate()) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.drafts() });
    },
    [EventType.ServerVersion]: ({ version }) => applyServerVersionEvent(queryClient, version),
    [EventType.Ping]: () => {
      const detected = localTimeZone();
      if (!detected || detected === reportedTimeZoneRef.current) return;
      reportedTimeZoneRef.current = detected;
      sendWS({ type: 'timezone.update', timeZone: detected });
    },
    [EventType.ForceLogout]: () => {
      // Server tells us this session must end (admin disabled the account
      // mid-session). Wipe local auth state and bounce to /login so the
      // user sees the same screen they'd hit after a normal logout —
      // refresh tokens were already wiped server-side.
      void logout().finally(() => navigate('/login', { replace: true }));
    },
    // parentMessageID present → typing inside a thread reply composer.
    // Routed into typingByThread; ThreadPanel reads that bucket so the
    // indicator surfaces in the side panel rather than the main list.
    [EventType.Typing]: ({ parentID, userID, parentMessageID }) => recordTyping(parentID, userID, parentMessageID ?? ''),
    // Live agent-run activity for the channel's activity bar. run.updated is
    // the lifecycle (add on active, remove on terminal); run.progress is the
    // "what is it doing" beat. Both land in the agent-runs store; the
    // AgentActivityIndicator subscribes per parent.
    [EventType.RunUpdated]: onAgentRunUpdated,
    [EventType.RunProgress]: onAgentRunProgress,
    // Blocking approval requests (plan-v2 §7): the card above the composer
    // for the invoker; requests appear pending, settle frames remove them.
    [EventType.RunApproval]: (a) => {
      onAgentRunApproval(a);
      // The run.approval frame is the authoritative signal for a blocking gate,
      // so the desktop alert is derived from it rather than from the parallel
      // notification.new (whose identity is the invoking message, which every
      // gate in a run shares). Only a fresh PENDING gate addressed to this user
      // alerts — settle/expiry frames just clear the card.
      if (a.state !== 'pending') return;
      if (!user?.id || a.invokerID !== user.id) return;
      const parentType = a.parentType === 'conversation' ? 'conversation' : 'channel';
      // Channel routes are by SLUG, so resolve it from the cached channel list
      // the same way the channel-rename/remove handlers below do. A cache miss
      // yields no link rather than a broken one — the alert still surfaces.
      let deepLink = '';
      if (parentType === 'conversation') {
        deepLink = `/conversation/${a.parentID}`;
      } else {
        const chans = queryClient.getQueryData<{ channelID: string; channelName: string }[]>(
          queryKeys.userChannels(),
        );
        const ch = chans?.find((c) => c.channelID === a.parentID);
        if (ch) deepLink = `/channel/${slugify(ch.channelName)}`;
      }
      const options = a.options ?? undefined;
      notifyApproval({
        approvalID: a.approvalID,
        runID: a.runID ?? '',
        parentID: a.parentID,
        parentType,
        agentName: a.agentName || undefined,
        summary: a.summary ?? '',
        asksChoice: !!options && options.length > 0,
        options,
        messageID: a.messageID,
        deepLink,
      });
    },
  };

  useWebSocket({
    handlers,
    // A payload that fails its schema is reported by ws-events; these refetch
    // what it would have patched, so nothing stays stale.
    invalidPayloadFallbacks: {
      [EventType.UserChannelUpdated]: refreshUserChannelState,
      [EventType.EmojiAdded]: () => invalidateEmojis(queryClient),
      [EventType.EmojiRemoved]: () => invalidateEmojis(queryClient),
      [EventType.ActivityNew]: () => refetchActivity(queryClient),
      [EventType.ActivityRead]: () => refetchActivity(queryClient),
    },
    onReconnect: refreshAfterGap,
    // The server's durable inbox lost our cursor — same recovery.
    onReplayExhausted: refreshAfterGap,
    enabled: !!user,
  });

  return (
    <AppLayout>
      <MobileChatReadyGate>
        <Outlet />
      </MobileChatReadyGate>
      {/* Run Activity Drawer: mounted once at the chat root; opened from the
          agent activity chip via the run-drawer store. */}
      <RunActivityDrawer />
      {hasDesktopRunner() && <DesktopRunnerAutostart />}
    </AppLayout>
  );
}
