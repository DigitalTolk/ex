import { useEffect, useRef } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
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
  removeMessageFromCache,
  resyncMessageCache,
  updateMessageInCache,
} from '@/hooks/useMessages';
import { queryKeys } from '@/lib/query-keys';
import {
  parseAttachmentDeleted,
  parseChannelID,
  parseMembersChanged,
  parseMessage,
  parsePresence,
  parseServerVersion,
  parseTyping,
} from '@/lib/ws-schemas';

export default function ChatPage() {
  const { markChannelUnread, markConversationUnread, unhideConversation } = useUnread();
  const { user, logout, patchUser } = useAuth();
  const { setUserOnline } = usePresence();
  const { dispatch: dispatchNotification, setCurrentUserID } = useNotifications();
  const { recordTyping, clearTyping, setSelfUserID } = useTyping();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const reportedTimeZoneRef = useRef('');

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
      if (authorID !== user?.id) {
        markChannelUnread(parentID);
        markConversationUnread(parentID);
      }
      unhideConversation(parentID);
      // Patch the message-list cache directly. invalidateQueries here
      // would walk forward from pages[0] and truncate deep-link page
      // chains (see appendMessageToCache). Thread replies don't touch
      // the main list — the parent's replyCount/lastReplyAt/authors
      // arrive via the message.edited event the backend publishes
      // alongside message.new (driven by IncrementReplyMetadata).
      if (parentMessageID) {
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
    },
    onMessageDeleted: (data: unknown) => {
      const msg = parseMessage(data);
      if (!msg) return;
      const { parentID, parentMessageID, id } = msg;
      removeMessageFromCache(queryClient, parentID, id);
      invalidateThreadBothScopes(queryClient, parentID, parentMessageID || id);
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
    onNotification: (data: unknown) => {
      const n = data as NotificationPayload | undefined;
      if (!n || !n.kind) return;
      dispatchNotification(n);
    },
    onDraftUpdated: () => {
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
      // Refresh non-infinite peripheral lists outright.
      queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
      queryClient.invalidateQueries({ queryKey: queryKeys.userConversations() });
      queryClient.invalidateQueries({ queryKey: queryKeys.userThreads() });
      queryClient.invalidateQueries({ queryKey: queryKeys.drafts() });
      queryClient.invalidateQueries({ queryKey: queryKeys.channelMembers() });
      // Top up tail-mode message caches via a forward fetch so events
      // missed during the disconnect appear without re-triggering v5's
      // walk-forward refetch on the infinite query.
      void resyncMessageCache(queryClient);
    },
    enabled: !!user,
  });

  return (
    <AppLayout>
      <Outlet />
    </AppLayout>
  );
}
