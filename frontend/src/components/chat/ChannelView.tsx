import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Header } from '@/components/layout/Header';
import { MessageList } from './MessageList';
import { MessageInput, type MessageInputHandle } from './MessageInput';
import { MessageDropZone } from './MessageDropZone';
import { MemberList } from './MemberList';
import { ThreadPanel } from './ThreadPanel';
import { PinnedPanel } from './PinnedPanel';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { ResourceErrorPage } from '@/pages/ResourceErrorPage';
import { FilesPanel } from './FilesPanel';
import { ChannelIntro } from './ConversationIntro';
import { TypingIndicator } from './TypingIndicator';
import { useChannelBySlug, useChannelMembers, useMuteChannel, useUserChannels } from '@/hooks/useChannels';
import {
  useChannelMessages,
  useSendChannelMessage,
} from '@/hooks/useMessages';
import { useAuth } from '@/context/AuthContext';
import { useUnread } from '@/context/UnreadContext';
import { usePresence } from '@/context/PresenceContext';
import { useNotifications } from '@/context/NotificationContext';
import { canEditChannel, canArchiveChannel, canLeaveChannel, roleNumber } from '@/lib/roles';
import { markThreadSeen } from '@/hooks/useThreads';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { collectMessageUserIDs, findLastOwnMessageId } from '@/lib/message-users';
import { useSidePanels } from '@/hooks/useSidePanels';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useDeepLinkAnchor } from '@/hooks/useDeepLinkAnchor';
import { useTagState } from '@/context/TagSearchContext';
import { TagSearchPanel } from '@/components/TagSearchPanel';
import type { UserMapEntry } from './MessageList';

function errorStatus(err: unknown): number | null {
  return typeof err === 'object' && err !== null && 'status' in err
    ? Number((err as { status?: unknown }).status)
    : null;
}

export function ChannelView() {
  const { id: slug } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { clearChannelUnread, setActiveChannel } = useUnread();
  const { setActiveParent } = useNotifications();
  const { online } = usePresence();
  const inputRef = useRef<MessageInputHandle>(null);
  const [threadRootID, setThreadRootID] = useState<string | null>(null);
  // Tracks a URL-driven thread the user has explicitly dismissed in
  // this view. Closing a thread that came from ?thread= used to
  // strip the URL — but that flips location.key (navKey), which
  // re-fires the deep-link anchor effect AND collides with the panel-
  // removal reflow, dragging the reader to the live tail. Keeping
  // the URL untouched and using a local override keeps everything
  // stable. The dismissal is keyed to navKey so it auto-expires the
  // moment the user navigates anywhere (back/forward, sidebar click,
  // /threads click, …) — no useEffect/setState needed for that.
  const [dismissed, setDismissed] = useState<{ navKey?: string; thread: string } | null>(null);
  const panels = useSidePanels<'members' | 'pinned' | 'files'>();
  // Tag panel takes the same right-rail slot as thread/pinned/files.
  // Opening any of those closes a tag, and opening a tag closes them.
  const { activeTag, closeTag } = useTagState();
  const { data: channel, error: channelError, isLoading: channelLoading } = useChannelBySlug(slug);
  const { data: members } = useChannelMembers(channel?.id);
  useDocumentTitle(channel ? `~${channel.name}` : null);
  const { mainAnchor, threadAnchor, threadParam, navKey } = useDeepLinkAnchor(channel?.id);

  const dismissedThreadParam =
    dismissed && dismissed.navKey === navKey ? dismissed.thread : null;
  const dismissThread = () => {
    setThreadRootID(null);
    const urlThread = searchParams.get('thread');
    if (urlThread) setDismissed({ navKey, thread: urlThread });
  };
  const openMembers = () => { dismissThread(); closeTag(); panels.open('members'); };
  const closeMembers = panels.close;
  const openThread = (id: string) => {
    setThreadRootID(id);
    closeTag();
    panels.close();
  };
  const closeThread = dismissThread;
  const togglePinned = () => { dismissThread(); closeTag(); panels.toggle('pinned'); };
  const toggleFiles = () => { dismissThread(); closeTag(); panels.toggle('files'); };
  const showMembers = panels.isActive('members');
  const showPinned = panels.isActive('pinned');
  const showFiles = panels.isActive('files');
  const {
    data,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    fetchNextPage,
    fetchPreviousPage,
    hasPreviousPage,
    isFetchingPreviousPage,
  } = useChannelMessages(channel?.id, mainAnchor);
  const sendMessage = useSendChannelMessage(channel?.id);
  useEffect(() => {
    if (!channel?.id) return;
    clearChannelUnread(channel.id);
    setActiveChannel(channel.id);
    setActiveParent(channel.id);
    return () => {
      setActiveChannel(null);
      setActiveParent(null);
    };
  }, [channel?.id, clearChannelUnread, setActiveChannel, setActiveParent]);

  // Reset locally-opened thread when the channel changes; deliberate
  // synchronous reset. URL-driven thread state (?thread=…) doesn't need
  // resetting here — it's pulled fresh from the new URL on every render.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setThreadRootID(null), [channel?.id]);

  // Local "open thread via UI button" state. The URL ?thread= param
  // is the source of truth for deep-linked threads (so back/forward
  // and reload keep working); local state is only used when the user
  // manually opens a thread by clicking "Reply in thread" on a
  // message. The displayed thread is the local one if set, otherwise
  // the URL-driven one — unless the user has dismissed it.
  const urlThreadActive = !!threadParam && threadParam !== dismissedThreadParam;
  const effectiveThreadRootID = threadRootID ?? (urlThreadActive ? threadParam : null) ?? null;

  // Mark URL-driven threads as seen exactly once per change.
  useEffect(() => {
    if (threadParam) markThreadSeen(threadParam);
  }, [threadParam]);

  // Opening a thread (via URL navigation, e.g. clicking a pinned
  // thread reply) must dismiss any other side panel — the local
  // openThread() helper does this, but URL-driven threads bypass it.
  useEffect(() => {
    if (effectiveThreadRootID) panels.close();
  }, [effectiveThreadRootID, panels]);

  // If the current user is no longer a member of the open channel (e.g.
  // they were just removed by an admin), boot them back to the placeholder
  // home view. We only react once members has loaded to avoid a spurious
  // redirect on first mount before the query resolves.
  useEffect(() => {
    if (!channel?.id || !user?.id || !members) return;
    if (members.length === 0) return;
    const stillMember = members.some((m) => m.userID === user.id);
    if (!stillMember) navigate('/', { replace: true });
  }, [channel?.id, user?.id, members, navigate]);

  const userIDs = useMemo(() => {
    const ids = new Set<string>();
    members?.forEach((m) => ids.add(m.userID));
    for (const page of data?.pages ?? []) {
      for (const id of collectMessageUserIDs(page.items)) ids.add(id);
    }
    return Array.from(ids);
  }, [members, data]);

  const { data: usersData } = useUsersBatch(userIDs);

  const lastOwnMessageId = useMemo(
    () => findLastOwnMessageId(data?.pages, user?.id, 'main'),
    [data, user?.id],
  );

  const userMap = useMemo(() => {
    const m: Record<string, UserMapEntry> = {};
    if (members) {
      for (const mem of members) {
        m[mem.userID] = { displayName: mem.displayName || 'Unknown', online: online.has(mem.userID) };
      }
    }
    if (usersData) {
      for (const u of usersData) {
        m[u.id] = { displayName: u.displayName || 'Unknown', avatarURL: u.avatarURL, online: online.has(u.id) };
      }
    }
    return m;
  }, [members, usersData, online]);

  const currentUserRole = members?.find(m => m.userID === user?.id)?.role;
  const canEdit = canEditChannel(currentUserRole);
  const canArchive = canArchiveChannel(currentUserRole);
  const canLeave = canLeaveChannel(currentUserRole, channel?.slug);

  const { data: userChannels } = useUserChannels();
  const muted = !!userChannels?.find((uc) => uc.channelID === channel?.id)?.muted;
  const muteChannel = useMuteChannel();
  function handleToggleMute() {
    if (!channel?.id) return;
    muteChannel.mutate({ channelId: channel.id, muted: !muted });
  }

  async function handleArchive() {
    if (!channel?.id) return;
    await apiFetch(`/api/v1/channels/${channel.id}`, { method: 'DELETE' });
    queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
    navigate('/');
  }

  async function handleLeave() {
    if (!channel?.id) return;
    await apiFetch(`/api/v1/channels/${channel.id}/leave`, { method: 'POST' });
    queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
    navigate('/');
  }

  async function handleDescriptionSave(desc: string) {
    if (!channel?.id) return;
    await apiFetch(`/api/v1/channels/${channel.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ description: desc }),
    });
    queryClient.invalidateQueries({ queryKey: queryKeys.channelBySlug(slug) });
  }

  if (!slug) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        Select a channel to start chatting
      </div>
    );
  }

  const channelErrorStatus = errorStatus(channelError);
  if (channelErrorStatus === 404) {
    return <NotFoundPage resource="channel" />;
  }
  if (channelErrorStatus === 403) {
    return <ResourceErrorPage resource="channel" status={403} />;
  }
  if (channelError || (!channelLoading && !channel)) {
    return <ResourceErrorPage resource="channel" status={500} />;
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header
          channel={channel}
          memberCount={members?.length}
          onMembersClick={() => (showMembers ? closeMembers() : openMembers())}
          channelId={channel?.id}
          canEdit={canEdit}
          onDescriptionSave={handleDescriptionSave}
          canArchive={canArchive}
          onArchive={handleArchive}
          canLeave={canLeave}
          onLeave={handleLeave}
          muted={muted}
          onToggleMute={handleToggleMute}
          onPinnedClick={togglePinned}
          pinnedActive={showPinned}
          onFilesClick={toggleFiles}
          filesActive={showFiles}
        />
        <MessageDropZone onFiles={(files) => void inputRef.current?.uploadFiles(files)}>
          <MessageList
            pages={data?.pages ?? []}
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            isLoading={isLoading}
            fetchNextPage={fetchNextPage}
            hasPreviousPage={hasPreviousPage}
            isFetchingPreviousPage={isFetchingPreviousPage}
            fetchPreviousPage={fetchPreviousPage}
            currentUserId={user?.id}
            channelId={channel?.id}
            channelSlug={channel?.slug}
            userMap={userMap}
            onReplyInThread={openThread}
            anchorMsgId={mainAnchor}
            anchorRevision={navKey}
            intro={
              channel ? (
                <ChannelIntro
                  channel={channel}
                  creatorName={userMap[channel.createdBy]?.displayName}
                />
              ) : undefined
            }
          />
          <TypingIndicator parentID={channel?.id} userMap={userMap} />
          <MessageInput
            ref={inputRef}
            onSend={sendMessage.mutate}
            disabled={sendMessage.isPending}
            placeholder={`Write to ~${channel?.name ?? '...'}`}
            focusKey={channel?.id}
            typingParentID={channel?.id}
            typingParentType="channel"
            lastOwnMessageId={lastOwnMessageId}
          />
        </MessageDropZone>
      </div>
      {activeTag ? (
        <TagSearchPanel />
      ) : effectiveThreadRootID ? (
        <ThreadPanel
          channelId={channel?.id}
          threadRootID={effectiveThreadRootID}
          onClose={closeThread}
          userMap={userMap}
          currentUserId={user?.id}
          anchorMsgId={
            effectiveThreadRootID === threadParam ? threadAnchor : undefined
          }
          anchorRevision={navKey}
        />
      ) : showPinned ? (
        <PinnedPanel
          channelId={channel?.id}
          channelSlug={channel?.slug}
          onClose={panels.close}
          userMap={userMap}
          currentUserId={user?.id}
          onReplyInThread={openThread}
        />
      ) : showFiles ? (
        <FilesPanel
          channelId={channel?.id}
          onClose={panels.close}
          userMap={userMap}
          postedIn={channel ? `~${channel.name}` : undefined}
        />
      ) : showMembers && members ? (
        <MemberList
          members={members}
          channelId={channel?.id}
          currentUserId={user?.id}
          currentUserRole={roleNumber(currentUserRole)}
          userMap={userMap}
          onClose={closeMembers}
        />
      ) : null}
    </div>
  );
}
