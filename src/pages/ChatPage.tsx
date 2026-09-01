import { useEffect, useRef, type ReactNode } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AppLayout } from '@/components/layout/AppLayout';
import { useUnread } from '@/context/UnreadContext';
import { useAuth } from '@/context/AuthContext';
import { usePresence } from '@/context/PresenceContext';
import { useNotifications, type NotificationPayload } from '@/context/NotificationContext';
import { useTyping } from '@/context/TypingContext';
import { useWebSocket } from '@/hooks/useWebSocket';
import { setServerVersion } from '@/hooks/useServerVersion';
import { sendWS } from '@/lib/ws-sender';
import { localTimeZone } from '@/lib/user-time';
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
import type { NotificationSettings } from '@/types';
import {
  parseAttachmentDeleted,
  parseChannelID,
  parseMembersChanged,
  parseMessage,
  parseMessageDeleted,
  parsePresence,
  parseServerVersion,
  parseThreadUpdated,
  parseTyping,
  parseUserChannelUpdated,
  parseUserUpdated,
} from '@/lib/ws-schemas';
import {
  onRunProgress as onAgentRunProgress,
  onRunUpdated as onAgentRunUpdated,
} from '@/stores/agent-runs';
import { onRunApproval as onAgentRunApproval } from '@/stores/agent-approvals';
import { RunActivityDrawer } from '@/components/chat/RunActivityDrawer';
import { apiFetch } from '@/lib/api';
import {
  bumpChannelUnread,
  bumpConversationUnread,
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
import { markThreadSeen, upsertUserThreadFromRoot, upsertUserThreadRow, userThreadInCache, useUserThreads } from '@/hooks/useThreads';
import { useIsMobile } from '@/hooks/useIsMobile';

function MobileChatLoadingPage() {
  return (
    <div
      className="h-full min-h-0 flex-1 bg-sidebar"
      aria-label="Loading chat"
      data-testid="mobile-chat-loading"
    />
  );
}

function queryReady(query: { isSuccess: boolean; isError: boolean; isPlaceholderData?: boolean }): boolean {
  return query.isError || (query.isSuccess && !query.isPlaceholderData);
}

function MobileChatReadyGate({ children }: { children: ReactNode }) {
  const isMobile = useIsMobile();
  const channels = useUserChannels({ enabled: isMobile });
  const conversations = useUserConversations({ enabled: isMobile });
  const categories = useCategories({ enabled: isMobile });
  const drafts = useDrafts({ enabled: isMobile });
  const userState = useUserState({ enabled: isMobile });
  const threads = useUserThreads({ enabled: isMobile });

  if (
    isMobile &&
    ![channels, conversations, categories, drafts, userState, threads].every(queryReady)
  ) {
    return <MobileChatLoadingPage />;
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
  const { setUserOnline, refreshPresence } = usePresence();
  const { dispatch: dispatchNotification, notifyApproval, setCurrentUserID } = useNotifications();
  const { recordTyping, clearTyping, setSelfUserID } = useTyping();
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
  }, [user?.id, setCurrentUserID, setSelfUserID]);

  useWebSocket({
    onMessageNew: (data: unknown) => {
      const msg = parseMessage(data);
      if (!msg) return;
      const { parentID, parentMessageID, authorID } = msg;
      // The author has finished typing the moment their message lands;
      // drop them from the indicator immediately rather than waiting
      // up to 6s for the expiry to tick. Pass parentMessageID so a
      // thread reply clears the thread bucket (not the main one).
      clearTyping(parentID, authorID, parentMessageID ?? '');
      const userChannels = queryClient.getQueryData<{ channelID: string }[]>(queryKeys.userChannels()) ?? [];
      const userConversations = queryClient.getQueryData<{ conversationID: string }[]>(queryKeys.userConversations()) ?? [];
      const isCachedChannel = userChannels.some((channel) => channel.channelID === parentID);
      const isCachedConversation = userConversations.some((conv) => conv.conversationID === parentID);
      const isChannelParent = msg.parentType === 'channel' || (!msg.parentType && isCachedChannel);
      const isConversationParent =
        msg.parentType === 'conversation' || (!msg.parentType && !isCachedChannel && isCachedConversation);
      // A webhook message carries its creator's userID as authorID, but it is
      // not "your own message": the bot posted it, not you. Mirror the backend
      // notification path (which excludes the author only for non-webhook
      // messages) so a webhook YOU created still bumps your unread indicator —
      // otherwise it would fire a desktop alert but leave the badge unset.
      const isOwnAuthor = isOwnMessage(msg, user?.id);
      if (!isOwnAuthor) {
        if (isChannelParent) {
          // A reply posted into a thread, or a system event (someone joining
          // /leaving), isn't "new channel activity" — only a top-level human
          // message bumps the channel's unread indicator.
          if (!parentMessageID && !msg.system) {
            if (isActiveChannel(parentID)) {
              // Already viewing it — keep the server caught up so the badge
              // doesn't reappear on a reload (mirrors the conversation path).
              void apiFetch<void>(`/api/v1/channels/${encodeURIComponent(parentID)}/read`, { method: 'PUT' })
                .catch(() => undefined);
            } else {
              // Patch the unread count straight into the list cache (single
              // source) — no session delta to reconcile.
              bumpChannelUnread(queryClient, parentID);
            }
          }
        } else if (isConversationParent) {
          // Mirror the channel rule: only a top-level human message is "new
          // conversation activity". A thread-only reply (or a system event)
          // must NOT bump the DM's unread count — the backend no longer bumps
          // the conversation seq for thread replies either, so the two agree.
          if (!parentMessageID && !msg.system) {
            if (isActiveConversation(parentID)) {
              clearConversationUnreadInCache(queryClient, parentID);
              void apiFetch<void>(`/api/v1/conversations/${encodeURIComponent(parentID)}/read`, { method: 'PUT' })
                .catch(() => undefined);
            } else {
              bumpConversationUnread(queryClient, parentID);
            }
          }
        }
      }
      if (isConversationParent) {
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
        if (isActiveThread(parentMessageID)) {
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
        // (upsertUserThreadFromRoot in onMessageEdited), NOT invalidated here —
        // an invalidate would refetch ListUserThreads, whose eventually-consistent
        // DynamoDB read can race the just-written thread state and clobber the
        // patch. The notification handler refetches only for threads we can't
        // patch (non-member participants).
      } else {
        appendMessageToCache(queryClient, parentID, msg);
      }
    },
    onMessageEdited: (data: unknown) => {
      const msg = parseMessage(data);
      if (!msg) return;
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
      upsertUserThreadFromRoot(queryClient, msg, user?.id);
      // Link-preview cards pointing at this message (in other channels)
      // are now stale — refetch them so the edited body/attachments show.
      invalidateUnfurlsForMessage(queryClient, id);
    },
    onMessageDeleted: (data: unknown) => {
      const msg = parseMessageDeleted(data);
      if (!msg) return;
      const { parentID, parentMessageID, id } = msg;
      markMessageDeletedInCache(queryClient, parentID, id, parentMessageID, msg);
      invalidateThreadBothScopes(queryClient, parentID, parentMessageID || id, msg.parentType);
      invalidateUnfurlsForMessage(queryClient, id);
      // /threads page reads body + replyCount via the userThreads list;
      // a deletion can change either, so refresh the list too.
      queryClient.invalidateQueries({ queryKey: queryKeys.userThreads() });
    },
    onMembersChanged: (data: unknown) => {
      const evt = parseMembersChanged(data);
      if (!evt) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.channelMembers(evt.channelID) });
      queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
      // The "X was added/removed" system message arrives via message.new
      // and is appended via appendMessageToCache. Invalidating the
      // message list here would walk forward from pages[0] and truncate
      // a deep-linked page chain.
    },
    onConversationNew: () => {
      // Refresh conversation list in sidebar
      queryClient.invalidateQueries({ queryKey: queryKeys.userConversations() });
    },
    onChannelArchived: (data: unknown) => {
      const evt = parseChannelID(data);
      if (!evt) return;
      // Look up the slug from the cached userChannels list before
      // invalidating so we can match the URL (which uses slug, not ID).
      const userChannels = queryClient.getQueryData<{ channelID: string; channelName: string }[]>(queryKeys.userChannels());
      const open = userChannels?.find((c) => c.channelID === evt.channelID);
      queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
      queryClient.invalidateQueries({ queryKey: queryKeys.browseChannels() });
      if (open && window.location.pathname.endsWith(`/channel/${slugify(open.channelName)}`)) {
        navigate('/', { replace: true });
      }
    },
    onChannelRemoved: (data: unknown) => {
      const evt = parseChannelID(data);
      if (!evt) return;
      const userChannels = queryClient.getQueryData<{ channelID: string; channelName: string }[]>(queryKeys.userChannels());
      const open = userChannels?.find((c) => c.channelID === evt.channelID);
      queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
      queryClient.invalidateQueries({ queryKey: queryKeys.channelMembers(evt.channelID) });
      // The directory's BrowsePublic results are guest-scoped (only joined
      // channels), so a kicked-out guest must refetch to drop the channel
      // they no longer belong to from the listing.
      queryClient.invalidateQueries({ queryKey: queryKeys.browseChannels() });
      if (open && window.location.pathname.endsWith(`/channel/${slugify(open.channelName)}`)) {
        navigate('/', { replace: true });
      }
    },
    onChannelUpdated: (data: unknown) => {
      if (!parseChannelID(data)) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.channelBySlug() });
      queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
    },
    onChannelNew: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.browseChannels() });
      queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
    },
    onPresenceChanged: (data: unknown) => {
      const evt = parsePresence(data);
      if (!evt) return;
      setUserOnline(evt.userID, evt.online);
    },
    onEmojiAdded: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.emojis() });
    },
    onEmojiRemoved: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.emojis() });
    },
    onWebhookChanged: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.incomingWebhooks() });
    },
    onActivityNew: () => {
      // A reaction hint or fired reminder landed — refetch the durable activity
      // stream (source of truth) so the sidebar badge + list update live.
      queryClient.invalidateQueries({ queryKey: queryKeys.activity() });
    },
    onThreadUpdated: (data: unknown) => {
      // Participant-scoped reply metadata: the server only sends this to users
      // who belong in the thread, so patch the /threads row directly from the
      // payload — no participation guess, no eventually-consistent refetch. This
      // covers threads the viewer didn't author (which the message.edited-driven
      // upsertUserThreadFromRoot deliberately skips) and the sender's own tabs.
      const evt = parseThreadUpdated(data);
      if (!evt) return;
      upsertUserThreadRow(queryClient, evt);
    },
    onUserUpdated: (data: unknown) => {
      const updated = parseUserUpdated(data);
      if (!updated) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.user(updated.id) });
      const currentUser = user;
      if (currentUser && updated.id === currentUser.id) {
        patchUser({
          ...(Object.prototype.hasOwnProperty.call(updated, 'userStatus')
            ? { userStatus: updated.userStatus === null ? undefined : updated.userStatus as typeof currentUser.userStatus }
            : {}),
          ...(updated.timeZone !== undefined ? { timeZone: updated.timeZone } : {}),
          ...(updated.lastSeenAt !== undefined ? { lastSeenAt: updated.lastSeenAt } : {}),
          ...(updated.phone !== undefined ? { phone: updated.phone } : {}),
          ...(updated.manager !== undefined ? { manager: updated.manager ?? undefined } : {}),
        });
      }
      // Avatar/displayName changed for some user — invalidate user batches and
      // member lists so all open views refresh stale presigned avatar URLs.
      queryClient.invalidateQueries({ queryKey: queryKeys.usersBatch() });
      queryClient.invalidateQueries({ queryKey: queryKeys.allUsers() });
      queryClient.invalidateQueries({ queryKey: ['searchUsers'] });
      queryClient.invalidateQueries({ queryKey: queryKeys.channelMembers() });
      queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
      queryClient.invalidateQueries({ queryKey: queryKeys.userConversations() });
      // The Directory page's Members tab fetches users into local
      // useState (not React Query), so cache invalidation isn't enough
      // — broadcast a DOM event the page listens to and refetches on.
      window.dispatchEvent(new CustomEvent('ex:user-updated'));
    },
    onUserChannelUpdated: (data: unknown) => {
      // userchannel.updated multiplexes several per-user sidebar changes;
      // dispatch on the payload instead of blanket-invalidating four
      // queries. That blanket refetch ran on EVERY conversation send (the
      // backend fans an activity touch to all participants, including the
      // author), so each sent DM cost four extra list fetches.
      const evt = parseUserChannelUpdated(data);
      const blanketRefresh = () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
        queryClient.invalidateQueries({ queryKey: queryKeys.userConversations() });
        queryClient.invalidateQueries({ queryKey: queryKeys.sidebarCategories() });
        queryClient.invalidateQueries({ queryKey: queryKeys.userState() });
      };
      if (!evt) {
        // Unparseable/legacy payload — the old blanket refresh is the safe floor.
        blanketRefresh();
        return;
      }
      if (evt.conversationID && evt.updatedAt !== undefined) {
        // Top-level message activity: bump the row's updatedAt in place so
        // the sidebar re-sorts. A missing row (just-activated conversation
        // not yet listed) falls back to one targeted refetch.
        if (!touchConversationActivityInCache(queryClient, evt.conversationID, evt.updatedAt)) {
          queryClient.invalidateQueries({ queryKey: queryKeys.userConversations() });
        }
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
      blanketRefresh();
    },
    onSidebarUpdated: () => {
      // A server-side sidebar reorder committed (the move endpoint). The
      // ACTING tab already holds the truth from the move response and armed
      // the echo-ignore window — other tabs/devices refetch both lists so
      // their order converges on what the server computed.
      if (!shouldRefetchSidebarForRemoteUpdate()) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
      queryClient.invalidateQueries({ queryKey: queryKeys.userConversations() });
    },
    onAttachmentDeleted: (data: unknown) => {
      const evt = parseAttachmentDeleted(data);
      if (!evt) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.attachment(evt.id) });
    },
    onChannelMuted: () => {
      // Either tab toggled mute — refetch the user's channel list so the
      // sidebar bell-slash indicator stays in sync across browser tabs.
      queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
    },
    onNotificationSettingsUpdated: (data: unknown) => {
      // Account-level notification settings changed (another tab/device).
      // Patch the in-memory user so every open settings surface reflects it.
      const evt = data as { settings?: NotificationSettings } | undefined;
      if (evt?.settings) {
        patchUser({ notificationSettings: evt.settings });
      }
    },
    onNotification: (data: unknown) => {
      const n = data as NotificationPayload | undefined;
      if (!n || !n.kind) return;
      if (n.parentMessageID) {
        if (isActiveThread(n.parentMessageID)) {
          markThreadSeen(n.parentMessageID, n.createdAt, {
            parentID: n.parentID,
            parentType: n.parentType === 'conversation' ? 'conversation' : 'channel',
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
    onDraftUpdated: () => {
      if (!shouldRefetchDraftsForRemoteUpdate()) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.drafts() });
    },
    onServerVersion: (data: unknown) => {
      const evt = parseServerVersion(data);
      if (!evt) return;
      setServerVersion(evt.version);
    },
    onPing: () => {
      const detected = localTimeZone();
      if (!detected || detected === reportedTimeZoneRef.current) return;
      reportedTimeZoneRef.current = detected;
      sendWS({ type: 'timezone.update', timeZone: detected });
    },
    onForceLogout: () => {
      // Server tells us this session must end (admin disabled the account
      // mid-session). Wipe local auth state and bounce to /login so the
      // user sees the same screen they'd hit after a normal logout —
      // refresh tokens were already wiped server-side.
      void logout().finally(() => navigate('/login', { replace: true }));
    },
    onTyping: (data: unknown) => {
      const evt = parseTyping(data);
      if (!evt) return;
      // parentMessageID present → typing inside a thread reply composer.
      // Routed into typingByThread; ThreadPanel reads that bucket so the
      // indicator surfaces in the side panel rather than the main list.
      recordTyping(evt.parentID, evt.userID, evt.parentMessageID ?? '');
    },
    // Live agent-run activity for the channel's activity bar. run.updated is
    // the lifecycle (add on active, remove on terminal); run.progress is the
    // "what is it doing" beat. Both land in the agent-runs store; the
    // AgentActivityIndicator subscribes per parent.
    onRunUpdated: (data: unknown) => {
      onAgentRunUpdated(data);
    },
    onRunProgress: (data: unknown) => {
      onAgentRunProgress(data);
    },
    // Blocking approval requests (plan-v2 §7): the card above the composer
    // for the invoker; requests appear pending, settle frames remove them.
    onRunApproval: (data: unknown) => {
      onAgentRunApproval(data);
      // The run.approval frame is the authoritative signal for a blocking gate,
      // so the desktop alert is derived from it rather than from the parallel
      // notification.new (whose identity is the invoking message, which every
      // gate in a run shares). Only a fresh PENDING gate addressed to this user
      // alerts — settle/expiry frames just clear the card.
      const a = data as {
        approvalID?: string;
        runID?: string;
        invokerID?: string;
        agentName?: string;
        parentID?: string;
        parentType?: string;
        messageID?: string;
        summary?: string;
        options?: string[];
        state?: string;
      } | null;
      if (!a?.approvalID || !a.parentID || a.state !== 'pending') return;
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
      notifyApproval({
        approvalID: a.approvalID,
        runID: a.runID ?? '',
        parentID: a.parentID,
        parentType,
        agentName: a.agentName || undefined,
        summary: a.summary ?? '',
        asksChoice: Array.isArray(a.options) && a.options.length > 0,
        options: Array.isArray(a.options) ? a.options : undefined,
        messageID: a.messageID,
        deepLink,
      });
    },
    onReconnect: () => {
      // Refresh non-infinite peripheral lists outright. With server
      // replay enabled, message events arrive via the durable inbox,
      // but list metadata (channels/threads/drafts/members) isn't in
      // the inbox so we refetch it. resyncMessageCache stays as a
      // safety net for any inbox gap a replay didn't cover.
      queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
      queryClient.invalidateQueries({ queryKey: queryKeys.userConversations() });
      queryClient.invalidateQueries({ queryKey: queryKeys.userThreads() });
      queryClient.invalidateQueries({ queryKey: queryKeys.userState() });
      queryClient.invalidateQueries({ queryKey: queryKeys.drafts() });
      queryClient.invalidateQueries({ queryKey: queryKeys.channelMembers() });
      // The refetched userChannels/userConversations carry authoritative server
      // unread counts — the single source — so there's nothing else to reset.
      void resyncMessageCache(queryClient);
      // presence.changed is ephemeral (never replayed): every transition that
      // happened while disconnected is gone, so refetch the authoritative
      // online set or the dots drift stale until the next full re-auth.
      refreshPresence();
    },
    onReplayExhausted: () => {
      // Server's durable inbox lost our cursor — same recovery as
      // a plain reconnect: invalidate peripherals + tail-resync.
      queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
      queryClient.invalidateQueries({ queryKey: queryKeys.userConversations() });
      queryClient.invalidateQueries({ queryKey: queryKeys.userThreads() });
      queryClient.invalidateQueries({ queryKey: queryKeys.userState() });
      queryClient.invalidateQueries({ queryKey: queryKeys.drafts() });
      queryClient.invalidateQueries({ queryKey: queryKeys.channelMembers() });
      void resyncMessageCache(queryClient);
      refreshPresence();
    },
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
    </AppLayout>
  );
}
