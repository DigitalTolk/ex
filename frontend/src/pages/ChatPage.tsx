import { useEffect } from 'react';
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
import { slugify } from '@/lib/format';
import {
  appendMessageToCache,
  bumpThreadReplyMetadata,
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
  const { user, logout } = useAuth();
  const { setUserOnline } = usePresence();
  const { dispatch: dispatchNotification, setCurrentUserID } = useNotifications();
  const { recordTyping, clearTyping, setSelfUserID } = useTyping();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

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
      // up to 6s for the expiry to tick.
      clearTyping(parentID, authorID);
      if (authorID !== user?.id) {
        markChannelUnread(parentID);
        markConversationUnread(parentID);
      }
      unhideConversation(parentID);
      // Patch the message-list cache directly. invalidateQueries here
      // would walk forward from pages[0] and truncate deep-link page
      // chains (see appendMessageToCache).
      if (parentMessageID) {
        // Reply belongs in the thread query, not the main list. Bump
        // the parent's reply metadata so the count + recent-author
        // avatars stay live in the main list.
        bumpThreadReplyMetadata(queryClient, parentID, msg);
      } else {
        appendMessageToCache(queryClient, parentID, msg);
      }
      // Thread queries are non-infinite — invalidation is safe.
      if (parentMessageID) {
        invalidateThreadBothScopes(queryClient, parentID, parentMessageID);
        queryClient.invalidateQueries({ queryKey: queryKeys.userThreads() });
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
    onUserUpdated: () => {
      // Avatar/displayName changed for some user — invalidate user batches and
      // member lists so all open views refresh stale presigned avatar URLs.
      queryClient.invalidateQueries({ queryKey: queryKeys.usersBatch() });
      queryClient.invalidateQueries({ queryKey: queryKeys.channelMembers() });
      queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
      queryClient.invalidateQueries({ queryKey: queryKeys.userConversations() });
      // The Directory page's Members tab fetches users into local
      // useState (not React Query), so cache invalidation isn't enough
      // — broadcast a DOM event the page listens to and refetches on.
      window.dispatchEvent(new CustomEvent('ex:user-updated'));
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
    onServerVersion: (data: unknown) => {
      const evt = parseServerVersion(data);
      if (!evt) return;
      setServerVersion(evt.version);
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
      recordTyping(evt.parentID, evt.userID);
    },
    onReconnect: () => {
      // Refresh non-infinite peripheral lists outright.
      queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
      queryClient.invalidateQueries({ queryKey: queryKeys.userConversations() });
      queryClient.invalidateQueries({ queryKey: queryKeys.userThreads() });
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
