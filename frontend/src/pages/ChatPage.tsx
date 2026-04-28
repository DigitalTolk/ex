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
      const msg = data as Record<string, unknown> | undefined;
      const parentID = msg?.parentID as string | undefined;
      const parentMessageID = msg?.parentMessageID as string | undefined;
      const authorID = msg?.authorID as string | undefined;
      if (!parentID) return;
      // The author has finished typing the moment their message lands;
      // drop them from the indicator immediately rather than waiting
      // up to 6s for the expiry to tick.
      if (authorID) clearTyping(parentID, authorID);
      // Only mark as unread if the message is from someone else
      if (authorID !== user?.id) {
        markChannelUnread(parentID);
        markConversationUnread(parentID);
      }
      // Un-hide conversation if it was hidden (new message should resurface it)
      unhideConversation(parentID);
      // Invalidate message queries so open views refresh
      queryClient.invalidateQueries({ queryKey: ['channelMessages', parentID] });
      queryClient.invalidateQueries({ queryKey: ['conversationMessages', parentID] });
      // If this is a thread reply, refresh the open ThreadPanel for everyone
      // and bump the cross-parent threads list so the sidebar's unread dot
      // reflects the new activity.
      if (parentMessageID) {
        const path = `channels/${parentID}`;
        const altPath = `conversations/${parentID}`;
        queryClient.invalidateQueries({ queryKey: ['thread', path, parentMessageID] });
        queryClient.invalidateQueries({ queryKey: ['thread', altPath, parentMessageID] });
        queryClient.invalidateQueries({ queryKey: ['userThreads'] });
      }
    },
    onMessageEdited: (data: unknown) => {
      const msg = data as Record<string, unknown> | undefined;
      const parentID = msg?.parentID as string | undefined;
      const parentMessageID = msg?.parentMessageID as string | undefined;
      const id = msg?.id as string | undefined;
      if (!parentID) return;
      queryClient.invalidateQueries({ queryKey: ['channelMessages', parentID] });
      queryClient.invalidateQueries({ queryKey: ['conversationMessages', parentID] });
      // Edits inside a thread (or to a thread root) must refresh open thread panels too.
      const threadRoot = parentMessageID || id;
      if (threadRoot) {
        queryClient.invalidateQueries({ queryKey: ['thread', `channels/${parentID}`, threadRoot] });
        queryClient.invalidateQueries({ queryKey: ['thread', `conversations/${parentID}`, threadRoot] });
      }
    },
    onMessageDeleted: (data: unknown) => {
      const msg = data as Record<string, unknown> | undefined;
      const parentID = msg?.parentID as string | undefined;
      const parentMessageID = msg?.parentMessageID as string | undefined;
      const id = msg?.id as string | undefined;
      if (!parentID) return;
      queryClient.invalidateQueries({ queryKey: ['channelMessages', parentID] });
      queryClient.invalidateQueries({ queryKey: ['conversationMessages', parentID] });
      const threadRoot = parentMessageID || id;
      if (threadRoot) {
        queryClient.invalidateQueries({ queryKey: ['thread', `channels/${parentID}`, threadRoot] });
        queryClient.invalidateQueries({ queryKey: ['thread', `conversations/${parentID}`, threadRoot] });
      }
      // /threads page reads body + replyCount via the userThreads list;
      // a deletion can change either, so refresh the list too.
      queryClient.invalidateQueries({ queryKey: ['userThreads'] });
    },
    onMembersChanged: (data: unknown) => {
      const evt = data as Record<string, unknown> | undefined;
      const channelID = evt?.channelID as string | undefined;
      if (!channelID) return;
      queryClient.invalidateQueries({ queryKey: ['channelMembers', channelID] });
      queryClient.invalidateQueries({ queryKey: ['userChannels'] });
      // Membership changes always post a "X was added/removed" system
      // message. Invalidate the message list here too so the system
      // line shows up even if the separate message.new event is dropped
      // (WS reconnect race, transient disconnect, etc.).
      queryClient.invalidateQueries({ queryKey: ['channelMessages', channelID] });
      queryClient.invalidateQueries({ queryKey: ['conversationMessages', channelID] });
    },
    onConversationNew: () => {
      // Refresh conversation list in sidebar
      queryClient.invalidateQueries({ queryKey: ['userConversations'] });
    },
    onChannelArchived: (data: unknown) => {
      const evt = data as Record<string, unknown> | undefined;
      const channelID = evt?.channelID as string | undefined;
      if (!channelID) return;
      // Look up the slug from the cached userChannels list before
      // invalidating so we can match the URL (which uses slug, not ID).
      const userChannels = queryClient.getQueryData<{ channelID: string; channelName: string }[]>(['userChannels']);
      const open = userChannels?.find((c) => c.channelID === channelID);
      queryClient.invalidateQueries({ queryKey: ['userChannels'] });
      queryClient.invalidateQueries({ queryKey: ['browseChannels'] });
      if (open && window.location.pathname.endsWith(`/channel/${slugify(open.channelName)}`)) {
        navigate('/', { replace: true });
      }
    },
    onChannelRemoved: (data: unknown) => {
      const evt = data as Record<string, unknown> | undefined;
      const channelID = evt?.channelID as string | undefined;
      if (!channelID) return;
      const userChannels = queryClient.getQueryData<{ channelID: string; channelName: string }[]>(['userChannels']);
      const open = userChannels?.find((c) => c.channelID === channelID);
      queryClient.invalidateQueries({ queryKey: ['userChannels'] });
      queryClient.invalidateQueries({ queryKey: ['channelMembers', channelID] });
      // The directory's BrowsePublic results are guest-scoped (only joined
      // channels), so a kicked-out guest must refetch to drop the channel
      // they no longer belong to from the listing.
      queryClient.invalidateQueries({ queryKey: ['browseChannels'] });
      if (open && window.location.pathname.endsWith(`/channel/${slugify(open.channelName)}`)) {
        navigate('/', { replace: true });
      }
    },
    onChannelUpdated: (data: unknown) => {
      const evt = data as Record<string, unknown> | undefined;
      const channelID = evt?.channelID as string | undefined;
      if (!channelID) return;
      queryClient.invalidateQueries({ queryKey: ['channelBySlug'] });
      queryClient.invalidateQueries({ queryKey: ['userChannels'] });
    },
    onChannelNew: () => {
      queryClient.invalidateQueries({ queryKey: ['browseChannels'] });
      queryClient.invalidateQueries({ queryKey: ['userChannels'] });
    },
    onPresenceChanged: (data: unknown) => {
      const evt = data as { userID?: string; online?: boolean } | undefined;
      if (!evt?.userID) return;
      setUserOnline(evt.userID, !!evt.online);
    },
    onEmojiAdded: () => {
      queryClient.invalidateQueries({ queryKey: ['emojis'] });
    },
    onEmojiRemoved: () => {
      queryClient.invalidateQueries({ queryKey: ['emojis'] });
    },
    onUserUpdated: () => {
      // Avatar/displayName changed for some user — invalidate user batches and
      // member lists so all open views refresh stale presigned avatar URLs.
      queryClient.invalidateQueries({ queryKey: ['users-batch'] });
      queryClient.invalidateQueries({ queryKey: ['channelMembers'] });
      queryClient.invalidateQueries({ queryKey: ['userChannels'] });
      queryClient.invalidateQueries({ queryKey: ['userConversations'] });
      // The Directory page's Members tab fetches users into local
      // useState (not React Query), so cache invalidation isn't enough
      // — broadcast a DOM event the page listens to and refetches on.
      window.dispatchEvent(new CustomEvent('ex:user-updated'));
    },
    onAttachmentDeleted: (data: unknown) => {
      const evt = data as { id?: string } | undefined;
      if (!evt?.id) return;
      queryClient.invalidateQueries({ queryKey: ['attachment', evt.id] });
    },
    onChannelMuted: () => {
      // Either tab toggled mute — refetch the user's channel list so the
      // sidebar bell-slash indicator stays in sync across browser tabs.
      queryClient.invalidateQueries({ queryKey: ['userChannels'] });
    },
    onNotification: (data: unknown) => {
      const n = data as NotificationPayload | undefined;
      if (!n || !n.kind) return;
      dispatchNotification(n);
    },
    onServerVersion: (data: unknown) => {
      const v = (data as { version?: string } | undefined)?.version;
      if (v) setServerVersion(v);
    },
    onForceLogout: () => {
      // Server tells us this session must end (admin disabled the account
      // mid-session). Wipe local auth state and bounce to /login so the
      // user sees the same screen they'd hit after a normal logout —
      // refresh tokens were already wiped server-side.
      void logout().finally(() => navigate('/login', { replace: true }));
    },
    onTyping: (data: unknown) => {
      const evt = data as { userID?: string; parentID?: string } | undefined;
      if (!evt?.parentID || !evt.userID) return;
      recordTyping(evt.parentID, evt.userID);
    },
    enabled: !!user,
  });

  return (
    <AppLayout>
      <Outlet />
    </AppLayout>
  );
}
