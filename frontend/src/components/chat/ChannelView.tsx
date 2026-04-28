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
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { collectMessageUserIDs } from '@/lib/message-users';
import { useSidePanels } from '@/hooks/useSidePanels';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import type { UserMapEntry } from './MessageList';

export function ChannelView() {
  const { id: slug } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { clearChannelUnread, setActiveChannel } = useUnread();
  const { setActiveParent } = useNotifications();
  const { online } = usePresence();
  const inputRef = useRef<MessageInputHandle>(null);
  const [threadRootID, setThreadRootID] = useState<string | null>(null);
  const panels = useSidePanels<'members' | 'pinned' | 'files'>();

  const openMembers = () => { setThreadRootID(null); panels.open('members'); };
  const closeMembers = panels.close;
  const openThread = (id: string) => { setThreadRootID(id); panels.close(); };
  const closeThread = () => setThreadRootID(null);
  const togglePinned = () => { setThreadRootID(null); panels.toggle('pinned'); };
  const toggleFiles = () => { setThreadRootID(null); panels.toggle('files'); };
  const showMembers = panels.isActive('members');
  const showPinned = panels.isActive('pinned');
  const showFiles = panels.isActive('files');
  const { data: channel } = useChannelBySlug(slug);
  const { data: members } = useChannelMembers(channel?.id);
  useDocumentTitle(channel ? `~${channel.name}` : null);
  const {
    data,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    fetchNextPage,
    refetch,
  } = useChannelMessages(channel?.id);
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

  // Reset thread when the channel changes; deliberate synchronous reset.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setThreadRootID(null), [channel?.id]);

  // Honor a ?thread=... deep link from the Threads page. We pull the param
  // once and clear it immediately so back/forward and tab switches don't keep
  // re-opening it. The hash (e.g. #msg-<id> for the deep-link highlight)
  // must survive — setSearchParams replaces only the search portion.
  const threadParam = searchParams.get('thread');
  useEffect(() => {
    if (!threadParam) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setThreadRootID(threadParam);
    markThreadSeen(threadParam);
    const next = new URLSearchParams(searchParams);
    next.delete('thread');
    setSearchParams(next, { replace: true, preventScrollReset: true });
  }, [threadParam, searchParams, setSearchParams]);

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
    queryClient.invalidateQueries({ queryKey: ['userChannels'] });
    navigate('/');
  }

  async function handleLeave() {
    if (!channel?.id) return;
    await apiFetch(`/api/v1/channels/${channel.id}/leave`, { method: 'POST' });
    queryClient.invalidateQueries({ queryKey: ['userChannels'] });
    navigate('/');
  }

  async function handleDescriptionSave(desc: string) {
    if (!channel?.id) return;
    await apiFetch(`/api/v1/channels/${channel.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ description: desc }),
    });
    queryClient.invalidateQueries({ queryKey: ['channelBySlug', slug] });
  }

  if (!slug) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        Select a channel to start chatting
      </div>
    );
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
            refetch={refetch}
            currentUserId={user?.id}
            channelId={channel?.id}
            channelSlug={channel?.slug}
            userMap={userMap}
            onReplyInThread={openThread}
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
          />
        </MessageDropZone>
      </div>
      {threadRootID && (
        <ThreadPanel
          channelId={channel?.id}
          threadRootID={threadRootID}
          onClose={closeThread}
          userMap={userMap}
          currentUserId={user?.id}
        />
      )}
      {showPinned && !threadRootID && (
        <PinnedPanel
          channelId={channel?.id}
          channelSlug={channel?.slug}
          onClose={panels.close}
          userMap={userMap}
          currentUserId={user?.id}
        />
      )}
      {showFiles && !threadRootID && (
        <FilesPanel
          channelId={channel?.id}
          onClose={panels.close}
          userMap={userMap}
          postedIn={channel ? `~${channel.name}` : undefined}
        />
      )}
      {showMembers && !threadRootID && members && (
        <MemberList
          members={members}
          channelId={channel?.id}
          currentUserId={user?.id}
          currentUserRole={roleNumber(currentUserRole)}
          userMap={userMap}
          onClose={closeMembers}
        />
      )}
    </div>
  );
}
