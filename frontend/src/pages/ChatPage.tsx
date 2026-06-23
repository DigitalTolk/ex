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
import {
  appendMessageToCache,
  invalidateThreadBothScopes,
  invalidateUnfurlsForMessage,
  markMessageDeletedInCache,
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
  parseTyping,
} from '@/lib/ws-schemas';
import { apiFetch } from '@/lib/api';
import { shouldRefetchDraftsForRemoteUpdate, useDrafts } from '@/hooks/useDrafts';
import { useUserChannels } from '@/hooks/useChannels';
import { useUserConversations } from '@/hooks/useConversations';
import { useCategories } from '@/hooks/useSidebar';
import { useUserState } from '@/hooks/useUserState';
import { markThreadSeen, useUserThreads } from '@/hooks/useThreads';
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
    markChannelUnread,
    markChannelNotificationUnread,
    clearConversationUnread,
    isActiveConversation,
    markConversationUnread,
    markThreadNotificationUnread,
    isActiveThread: isActiveThreadScope,
    unhideConversation,
  } = useUnread();
  const { user, logout, patchUser } = useAuth();
  const { setUserOnline } = usePresence();
  const { dispatch: dispatchNotification, setCurrentUserID } = useNotifications();
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
      if (authorID !== user?.id) {
        if (isChannelParent) {
          // A reply posted into a thread, or a system event (someone joining
          // /leaving), isn't "new channel activity" — only a top-level human
          // message bumps the channel's unread indicator.
          if (!parentMessageID && !msg.system) {
            markChannelUnread(parentID);
          }
        } else if (isConversationParent) {
          if (isActiveConversation(parentID)) {
            clearConversationUnread(parentID);
            void apiFetch<void>(`/api/v1/conversations/${encodeURIComponent(parentID)}/read`, { method: 'PUT' })
              .catch(() => undefined)
              .finally(() => {
                queryClient.invalidateQueries({ queryKey: queryKeys.userConversations() });
              });
          } else {
            markConversationUnread(parentID);
            queryClient.invalidateQueries({ queryKey: queryKeys.userConversations() });
          }
        }
      }
      if (isConversationParent) {
        if (authorID === user?.id || !isActiveConversation(parentID)) {
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
          markThreadSeen(parentMessageID, msg.createdAt, {
            parentID,
            parentType: msg.parentType === 'conversation' ? 'conversation' : 'channel',
          });
        }
        invalidateThreadBothScopes(queryClient, parentID, parentMessageID);
        queryClient.invalidateQueries({ queryKey: queryKeys.userThreads() });
      } else {
        appendMessageToCache(queryClient, parentID, msg);
      }
    },
    onMessageEdited: (data: unknown) => {
      const msg = parseMessage(data);
      if (!msg) return;
      const { parentID, parentMessageID, id } = msg;
      updateMessageInCache(queryClient, parentID, msg);
      invalidateThreadBothScopes(queryClient, parentID, parentMessageID || id);
      // Link-preview cards pointing at this message (in other channels)
      // are now stale — refetch them so the edited body/attachments show.
      invalidateUnfurlsForMessage(queryClient, id);
    },
    onMessageDeleted: (data: unknown) => {
      const msg = parseMessageDeleted(data);
      if (!msg) return;
      const { parentID, parentMessageID, id } = msg;
      markMessageDeletedInCache(queryClient, parentID, id, parentMessageID, msg);
      invalidateThreadBothScopes(queryClient, parentID, parentMessageID || id);
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
    onUserUpdated: (data: unknown) => {
      const updated = data as { id?: string; userStatus?: unknown; timeZone?: string; lastSeenAt?: string } | undefined;
      if (updated?.id) {
        queryClient.invalidateQueries({ queryKey: queryKeys.user(updated.id) });
      }
      const currentUser = user;
      if (updated?.id && currentUser && updated.id === currentUser.id) {
        patchUser({
          ...(Object.prototype.hasOwnProperty.call(updated, 'userStatus')
            ? { userStatus: updated.userStatus === null ? undefined : updated.userStatus as typeof currentUser.userStatus }
            : {}),
          ...(updated.timeZone !== undefined ? { timeZone: updated.timeZone } : {}),
          ...(updated.lastSeenAt !== undefined ? { lastSeenAt: updated.lastSeenAt } : {}),
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
    onUserChannelUpdated: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
      queryClient.invalidateQueries({ queryKey: queryKeys.userConversations() });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarCategories() });
      queryClient.invalidateQueries({ queryKey: queryKeys.userState() });
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
        queryClient.invalidateQueries({ queryKey: queryKeys.userThreads() });
        queryClient.invalidateQueries({ queryKey: queryKeys.userState() });
      } else if (n.parentType === 'channel') {
        // The backend is the single source of truth for whether to alert: if a
        // top-level channel notification.new arrived, this user should see the
        // channel light up — regardless of kind. Do NOT re-gate on
        // kind === 'mention' here; that silently dropped per-channel "all
        // messages"/keyword alerts, leaving a sound playing with no sidebar
        // badge when the separate message.new path was missed.
        markChannelNotificationUnread(n.parentID);
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
      void resyncMessageCache(queryClient);
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
    },
    enabled: !!user,
  });

  return (
    <AppLayout>
      <MobileChatReadyGate>
        <Outlet />
      </MobileChatReadyGate>
    </AppLayout>
  );
}
