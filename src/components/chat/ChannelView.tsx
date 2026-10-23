import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Header } from '@/components/layout/Header';
import { NotificationPreferencesDialog } from '@/components/channels/NotificationPreferencesDialog';
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
import { AgentActivityIndicator } from './AgentActivityIndicator';
import { AgentApprovalCard } from './AgentApprovalCard';
import { WatcherCatchUpCard } from './WatcherCatchUpCard';
import {
  useArchiveChannel,
  useChannelBySlug,
  useChannelMembers,
  useLeaveChannel,
  useMuteChannel,
  useUnarchiveChannel,
  useUpdateChannelDescription,
  useUserChannels,
} from '@/hooks/useChannels';
import { useChannelMessages } from '@/hooks/useMessages';
import { useAuth } from '@/context/AuthContext';
import { useUnread } from '@/context/UnreadContext';
import { canEditChannel, canArchiveChannel, canUnarchiveChannel, canLeaveChannel, roleNumber } from '@/lib/roles';
import { ArchivedChannelNotice } from '@/components/chat/ArchivedChannelNotice';
import { markThreadSeen, noteThreadReadPosition } from '@/hooks/useThreads';
import { slugify } from '@/lib/format';
import { NonMemberInvitePrompt } from './NonMemberInvitePrompt';
import { useNonMemberInvite } from '@/hooks/useNonMemberInvite';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { useFrequentEmojis } from '@/hooks/useEmoji';
import { findLastOwnMessageId } from '@/lib/message-users';
import { useMessagePageUserIDs } from '@/hooks/useMessagePageUserIDs';
import { useSidePanels } from '@/hooks/useSidePanels';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useDeepLinkAnchor, useListAnchor, forgetDeepLinkInAddress } from '@/hooks/useDeepLinkAnchor';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useTagState } from '@/context/TagSearchContext';
import { TagSearchPanel } from '@/components/TagSearchPanel';
import type { UserMapEntry } from './MessageList';
import { useParentChat } from '@/hooks/useParentChat';

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
  const { setActiveThread } = useUnread();
  const quickReactions = useFrequentEmojis(6);
  const inputRef = useRef<MessageInputHandle>(null);
  const isMobile = useIsMobile();
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
  // The sidebar already knows the channels you're in by name, so while the
  // channel itself is looked up its messages start loading too, and its name
  // can stand in the header.
  const { data: userChannels } = useUserChannels();
  const knownChannel = useMemo(
    () => userChannels?.find((c) => slug === slugify(c.channelName) || slug === c.channelID),
    [userChannels, slug],
  );
  const { data: members } = useChannelMembers(channel?.id);
  useDocumentTitle(channel ? `~${channel.name}` : null);
  const { mainAnchor, threadAnchor, threadParam, navKey } = useDeepLinkAnchor(channel?.id);
  // A link-opened window can be swapped for the newest messages (keeping any
  // open thread) — see the MessageList pill.
  const { listAnchor, showLatest } = useListAnchor(mainAnchor, navKey);

  const dismissedThreadParam =
    dismissed && dismissed.navKey === navKey ? dismissed.thread : null;
  const dismissThread = () => {
    setThreadRootID(null);
    const urlThread = searchParams.get('thread');
    if (urlThread) {
      setDismissed({ navKey, thread: urlThread });
      forgetDeepLinkInAddress();
    }
  };
  const openMembers = () => { dismissThread(); closeTag(); panels.open('members'); };
  const closeMembers = panels.close;
  // Stable: it reaches every message row as a prop, and a fresh function per
  // render re-rendered all mounted rows on each list change.
  const openThread = useCallback((id: string) => {
    setThreadRootID(id);
    closeTag();
    panels.close();
  }, [closeTag, panels]);
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
  } = useChannelMessages(channel?.id ?? knownChannel?.channelID, listAnchor);
  // After sending a message that @mentions people not in the channel, offer to
  // invite them in one click (see NonMemberInvitePrompt).
  const { pendingInvites, checkMentions, clearInvites } = useNonMemberInvite(channel?.id, user?.id);
  // Surface an invite prompt for any mentioned non-members (supersedes a
  // previous prompt; empty result clears it).
  const inviteMentioned = useCallback((value: { body: string }) => checkMentions(value.body), [checkMentions]);
  // The composer, the read session and the active parent (see useParentChat).
  const {
    schedule,
    draft,
    draftAttachments,
    editing: { setEditingMessage, activeEditingMessage, editDraftAttachments, editReady },
    editMessage,
    handleDraftChange,
    handleSendMessage,
    handleEditMessage,
    readSession,
  } = useParentChat({ kind: 'channel', id: channel?.id, userID: user?.id, beforeSend: inviteMentioned });

  // Reset locally-opened thread when the channel changes; deliberate
  // synchronous reset. URL-driven thread state (?thread=…) doesn't need
  // resetting here — it's pulled fresh from the new URL on every render.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setThreadRootID(null), [channel?.id]);
  useEffect(() => clearInvites(), [channel?.id, clearInvites]);

  // Local "open thread via UI button" state. The URL ?thread= param
  // is the source of truth for deep-linked threads (so back/forward
  // and reload keep working); local state is only used when the user
  // manually opens a thread by clicking "Reply in thread" on a
  // message. The displayed thread is the local one if set, otherwise
  // the URL-driven one — unless the user has dismissed it.
  const urlThreadActive = !!threadParam && threadParam !== dismissedThreadParam;
  const effectiveThreadRootID = threadRootID ?? (urlThreadActive ? threadParam : null) ?? null;

  // Mark URL-driven threads as seen exactly once per change — noting first
  // where the user had read up to, for the thread's "New messages" line.
  useEffect(() => {
    if (!threadParam || !channel?.id) return;
    noteThreadReadPosition(queryClient, threadParam);
    markThreadSeen(threadParam, new Date().toISOString(), { parentID: channel.id, parentType: 'channel' });
  }, [threadParam, channel?.id, queryClient]);

  // Opening a thread (via URL navigation, e.g. clicking a pinned
  // thread reply) must dismiss any other side panel — the local
  // openThread() helper does this, but URL-driven threads bypass it.
  useEffect(() => {
    if (effectiveThreadRootID) panels.close();
  }, [effectiveThreadRootID, panels]);

  // Register the open thread (URL- or locally-driven) as the active thread
  // so a reply arriving while it's on screen is marked seen instead of
  // lighting up the Threads nav.
  useEffect(() => {
    setActiveThread(effectiveThreadRootID);
    return () => setActiveThread(null);
  }, [effectiveThreadRootID, setActiveThread]);

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

  // Walked per page, and only the page an event changed (useMessagePageUserIDs).
  const memberUserIDs = useMemo(() => members?.map((m) => m.userID), [members]);
  const userIDs = useMessagePageUserIDs(data?.pages, memberUserIDs);

  const { data: usersData } = useUsersBatch(userIDs);

  const lastOwnMessageId = useMemo(
    () => findLastOwnMessageId(data?.pages, user?.id, 'main'),
    [data, user?.id],
  );

  const userMap = useMemo(() => {
    const m: Record<string, UserMapEntry> = {};
    if (members) {
      for (const mem of members) {
        m[mem.userID] = { displayName: mem.displayName || 'Unknown' };
      }
    }
    if (usersData) {
      for (const u of usersData) {
        m[u.id] = { displayName: u.displayName || 'Unknown', avatarURL: u.avatarURL, userStatus: u.userStatus };
      }
    }
    return m;
  }, [members, usersData]);

  const currentUserRole = members?.find(m => m.userID === user?.id)?.role;
  // An archived channel is read-only: no editing, posting or new members.
  const archived = !!channel?.archived;
  const canEdit = canEditChannel(currentUserRole) && !archived;
  const canArchive = canArchiveChannel(currentUserRole, user?.systemRole);
  const canUnarchive = canUnarchiveChannel(currentUserRole, user?.systemRole);
  const canLeave = canLeaveChannel(currentUserRole, channel?.slug);

  const muted = !!userChannels?.find((uc) => uc.channelID === channel?.id)?.muted;
  const muteChannel = useMuteChannel();
  const [notifPrefsOpen, setNotifPrefsOpen] = useState(false);
  function handleToggleMute() {
    /* istanbul ignore next -- only wired to the header menu, which renders only when `channel` is loaded, so the `channel == null` optional-chain arm is unreachable; defensive. */
    if (!channel?.id) return;
    muteChannel.mutate({ channelId: channel.id, muted: !muted });
  }

  const archiveChannel = useArchiveChannel();
  const unarchiveChannel = useUnarchiveChannel();
  const leaveChannel = useLeaveChannel();
  const updateDescription = useUpdateChannelDescription();

  function handleArchive() {
    /* istanbul ignore next -- only wired to the header menu, which renders only when `channel` is loaded, so the `channel == null` optional-chain arm is unreachable; defensive. */
    if (!channel?.id) return;
    // Stay on the channel: it turns read-only in place.
    archiveChannel.run(channel.id);
  }

  function handleUnarchive() {
    /* istanbul ignore next -- only wired to the header menu and the archived notice, which render only when `channel` is loaded, so the `channel == null` optional-chain arm is unreachable; defensive. */
    if (!channel?.id) return;
    unarchiveChannel.run(channel.id);
  }

  function handleLeave() {
    /* istanbul ignore next -- only wired to the header menu, which renders only when `channel` is loaded, so the `channel == null` optional-chain arm is unreachable; defensive. */
    if (!channel?.id) return;
    leaveChannel.run(channel.id, { onSuccess: () => navigate('/') });
  }

  function handleDescriptionSave(desc: string) {
    /* istanbul ignore next -- only wired to the header menu, which renders only when `channel` is loaded, so the `channel == null` optional-chain arm is unreachable; defensive. */
    if (!channel?.id) return;
    updateDescription.run({ channelId: channel.id, description: desc });
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

  // Past the guards above, `channel` is loaded (any error/absent state has
  // already returned). The `: undefined` arm is therefore unreachable here;
  // it stays only as a type-narrowing default for the optional FilesPanel prop.
  /* istanbul ignore next -- channel is guaranteed loaded past the error guards above, so the `: undefined` arm is unreachable; defensive. */
  const filesPostedIn = channel ? `~${channel.name}` : undefined;

  /* istanbul ignore next -- channel is guaranteed loaded past the error guards above, so the `: null` arm is unreachable; mirrors filesPostedIn. */
  const notifPrefsDialog = channel ? (
    <NotificationPreferencesDialog
      open={notifPrefsOpen}
      onOpenChange={setNotifPrefsOpen}
      channelId={channel.id}
      channelName={channel.name}
    />
  ) : null;

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Header
          channel={channel}
          loadingChannel={channelLoading ? { name: knownChannel?.channelName, type: knownChannel?.channelType } : undefined}
          memberCount={members?.length}
          onMembersClick={() => (showMembers ? closeMembers() : openMembers())}
          channelId={channel?.id}
          canEdit={canEdit}
          onDescriptionSave={handleDescriptionSave}
          canArchive={canArchive}
          onArchive={handleArchive}
          canUnarchive={canUnarchive}
          onUnarchive={handleUnarchive}
          canLeave={canLeave}
          onLeave={handleLeave}
          muted={muted}
          onToggleMute={handleToggleMute}
          onNotificationPrefsClick={() => setNotifPrefsOpen(true)}
          onPinnedClick={togglePinned}
          pinnedActive={showPinned}
          onFilesClick={toggleFiles}
          filesActive={showFiles}
        />
        <MessageDropZone onFiles={(files) => void inputRef.current?.uploadFiles(files)} disabled={archived}>
          <MessageList
            pages={data?.pages ?? []}
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            isLoading={isLoading || channelLoading}
            fetchNextPage={fetchNextPage}
            hasPreviousPage={hasPreviousPage}
            isFetchingPreviousPage={isFetchingPreviousPage}
            fetchPreviousPage={fetchPreviousPage}
            currentUserId={user?.id}
            channelId={channel?.id}
            channelSlug={channel?.slug}
            userMap={userMap}
            quickReactions={quickReactions}
            readOnly={archived}
            onReplyInThread={openThread}
            onEditMessage={isMobile ? setEditingMessage : undefined}
            anchorMsgId={listAnchor}
            anchorRevision={navKey}
            onAtBottomChange={readSession.onAtBottomChange}
            onMarkAllRead={readSession.markAllRead}
            onJumpToLatest={() => {
              readSession.prepareJumpToLatest();
              showLatest();
            }}
            intro={
              channel ? (
                <ChannelIntro
                  channel={channel}
                  creatorName={userMap[channel.createdBy]?.displayName}
                />
              ) : undefined
            }
          />
          {channel && !archived && !activeEditingMessage && pendingInvites.length > 0 && (
            <NonMemberInvitePrompt
              channelId={channel.id}
              channelName={channel.slug}
              users={pendingInvites}
              onDismiss={clearInvites}
            />
          )}
          {archived ? (
            <ArchivedChannelNotice onUnarchive={canUnarchive ? handleUnarchive : undefined} unarchiving={unarchiveChannel.isPending} />
          ) : activeEditingMessage && !editReady ? (
            <div className="border-t p-3 text-sm text-muted-foreground">Loading message editor…</div>
          ) : (
            <MessageInput
              key={activeEditingMessage ? `edit-${activeEditingMessage.id}` : `channel-${channel?.id ?? 'loading'}`}
              ref={inputRef}
              onSend={activeEditingMessage ? handleEditMessage : handleSendMessage}
              onSchedule={schedule.onSchedule}
              scheduledCount={schedule.scheduledCount}
              onCancel={activeEditingMessage ? () => setEditingMessage(null) : undefined}
              disabled={!!activeEditingMessage && editMessage.isPending}
              placeholder={activeEditingMessage ? 'Edit message...' : `Write to ~${channel?.name ?? knownChannel?.channelName ?? '...'}`}
              focusKey={activeEditingMessage ? `edit-${activeEditingMessage.id}` : channel?.id}
              initialBody={activeEditingMessage?.body ?? draft?.body ?? ''}
              initialDrafts={activeEditingMessage ? editDraftAttachments : draftAttachments}
              onDraftChange={activeEditingMessage ? undefined : handleDraftChange}
              cancelOnOutsidePointer={!!activeEditingMessage}
              submitLabel={activeEditingMessage ? 'Save' : undefined}
              typingParentID={activeEditingMessage ? undefined : channel?.id}
              typingParentType={activeEditingMessage ? undefined : 'channel'}
              lastOwnMessageId={activeEditingMessage ? undefined : lastOwnMessageId}
              aboveInput={
                activeEditingMessage ? undefined : (
                  <>
                    <AgentApprovalCard parentID={channel?.id} userMap={userMap} />
                    <WatcherCatchUpCard parentID={channel?.id} parentType="channel" />
                    <AgentActivityIndicator parentID={channel?.id} userMap={userMap} />
                    <TypingIndicator parentID={channel?.id} userMap={userMap} />
                  </>
                )
              }
            />
          )}
        </MessageDropZone>
      </div>
      {effectiveThreadRootID ? (
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
          readOnly={archived}
        />
      ) : activeTag ? (
        <TagSearchPanel />
      ) : showPinned ? (
        <PinnedPanel
          channelId={channel?.id}
          channelSlug={channel?.slug}
          onClose={panels.close}
          userMap={userMap}
          currentUserId={user?.id}
          onReplyInThread={openThread}
          readOnly={archived}
        />
      ) : showFiles ? (
        <FilesPanel
          channelId={channel?.id}
          onClose={panels.close}
          userMap={userMap}
          postedIn={filesPostedIn}
        />
      ) : showMembers && members ? (
        <MemberList
          members={members}
          channelId={channel?.id}
          channelSlug={channel?.slug}
          currentUserId={user?.id}
          currentUserRole={roleNumber(currentUserRole)}
          userMap={userMap}
          onClose={closeMembers}
          readOnly={archived}
        />
      ) : null}
      {notifPrefsDialog}
    </div>
  );
}
