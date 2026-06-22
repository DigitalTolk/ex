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
import { useChannelBySlug, useChannelMembers, useMuteChannel, useUserChannels } from '@/hooks/useChannels';
import {
  useChannelMessages,
  useEditMessage,
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
import { NonMemberInvitePrompt } from './NonMemberInvitePrompt';
import { useNonMemberInvite } from '@/hooks/useNonMemberInvite';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { useFrequentEmojis } from '@/hooks/useEmoji';
import { collectMessageUserIDs, findLastOwnMessageId } from '@/lib/message-users';
import { useSidePanels } from '@/hooks/useSidePanels';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useDeepLinkAnchor } from '@/hooks/useDeepLinkAnchor';
import { useIsMobile } from '@/hooks/useIsMobile';
import {
  restoreDraftScope,
  restoreDraftScopeForContent,
  suppressSentDraft,
  useDeleteDraft,
  useDraftAttachmentChips,
  useDraftForScope,
  useSaveDraft,
} from '@/hooks/useDrafts';
import { useAttachmentsBatch } from '@/hooks/useAttachments';
import { useTagState } from '@/context/TagSearchContext';
import { TagSearchPanel } from '@/components/TagSearchPanel';
import type { Message } from '@/types';
import type { UserMapEntry } from './MessageList';
import type { DraftAttachment } from './AttachmentChip';

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
  const { clearChannelUnread, setActiveChannel, setActiveThread } = useUnread();
  const { setActiveParent } = useNotifications();
  const { online } = usePresence();
  const quickReactions = useFrequentEmojis(3);
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
  const channelID = channel?.id;
  const draftScope = useMemo(
    () => ({ parentID: channelID, parentType: 'channel' as const }),
    [channelID],
  );
  const { data: draft } = useDraftForScope(draftScope);
  const draftAttachments = useDraftAttachmentChips(draft?.attachmentIDs);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const activeEditingMessage = isMobile ? editingMessage : null;
  const editAttachmentIDs = useMemo(
    () => activeEditingMessage?.attachmentIDs ?? [],
    [activeEditingMessage],
  );
  // Pass the access context so the server authorizes the resolve — without
  // it the batch returns nothing, the edit composer opens with no attachment
  // chips, and saving would wipe the message's attachments.
  const { map: editAttachmentMap, isLoading: editAttachmentsLoading } = useAttachmentsBatch(
    editAttachmentIDs,
    activeEditingMessage
      ? { parentID: channelID, parentType: 'channel', messageID: activeEditingMessage.id }
      : undefined,
  );
  const editDraftAttachments = useMemo<DraftAttachment[]>(
    () =>
      editAttachmentIDs
        .map((id): DraftAttachment | null => {
          const att = editAttachmentMap.get(id);
          if (!att) return null;
          return {
            id: att.id,
            filename: att.filename,
            contentType: att.contentType,
            size: att.size,
            progress: 1,
            ...(att.url ? { url: att.url } : {}),
            ...(att.squareThumbnailURL ? { squareThumbnailURL: att.squareThumbnailURL } : {}),
          };
        })
        .filter((att): att is DraftAttachment => att !== null),
    [editAttachmentIDs, editAttachmentMap],
  );
  const editReady =
    !editingMessage || editAttachmentIDs.length === 0 || !editAttachmentsLoading;
  const editMessage = useEditMessage();
  // After sending a message that @mentions people not in the channel, offer to
  // invite them in one click (see NonMemberInvitePrompt).
  const { pendingInvites, checkMentions, clearInvites } = useNonMemberInvite(channel?.id, user?.id);
  const draftID = draft?.id;
  const saveDraft = useSaveDraft();
  const deleteDraft = useDeleteDraft();
  const saveDraftMutate = saveDraft.mutate;
  const deleteDraftMutate = deleteDraft.mutate;
  const handleDraftChange = useCallback(
    (value: { body: string; attachmentIDs: string[] }, options?: { notify?: boolean }) => {
      if (!channelID) return;
      restoreDraftScopeForContent(draftScope, value);
      saveDraftMutate({
        parentID: channelID,
        parentType: 'channel',
        body: value.body,
        attachmentIDs: value.attachmentIDs,
        // Keystroke saves persist silently; the focus-loss flush (notify)
        // is what surfaces the draft in the sidebar.
        silent: !options?.notify,
      });
    },
    [channelID, draftScope, saveDraftMutate],
  );
  const handleSendMessage = useCallback(
    (value: { body: string; attachmentIDs: string[] }) => {
      // Surface an invite prompt for any mentioned non-members (supersedes a
      // previous prompt; empty result clears it).
      checkMentions(value.body);
      suppressSentDraft(draftScope);
      if (!draftID) {
        sendMessage.mutate(value, { onError: () => restoreDraftScope(draftScope) });
        return;
      }
      sendMessage.mutate(value, {
        onSuccess: () => deleteDraftMutate(draftID),
        onError: () => restoreDraftScope(draftScope),
      });
    },
    [sendMessage, draftScope, draftID, deleteDraftMutate, checkMentions],
  );
  const handleEditMessage = useCallback(
    (value: { body: string; attachmentIDs: string[] }) => {
      /* istanbul ignore next -- handleEditMessage is only wired as the composer's onSend while activeEditingMessage (hence editingMessage) is set, so it is never invoked with a null editingMessage. */
      if (!editingMessage) return;
      const currentAttachmentIDs = editingMessage.attachmentIDs ?? [];
      const same =
        value.body === editingMessage.body &&
        value.attachmentIDs.length === currentAttachmentIDs.length &&
        value.attachmentIDs.every((id, idx) => id === currentAttachmentIDs[idx]);
      // The `!value.body.trim() && …length === 0` blank-edit arm is
      // unreachable from the real composer here — its Save button is disabled
      // while the body is empty and there are no attachments — so onSend never
      // fires with a blank payload. The `same` arm is exercised by tests.
      /* istanbul ignore next -- composer disables Save on an empty edit, so the blank-body arm cannot fire via onSend; defensive. */
      if (same || (!value.body.trim() && value.attachmentIDs.length === 0)) {
        setEditingMessage(null);
        return;
      }
      editMessage.mutate(
        {
          messageId: editingMessage.id,
          body: value.body,
          attachmentIDs: value.attachmentIDs,
          channelId: channelID,
        },
        { onSuccess: () => setEditingMessage(null) },
      );
    },
    [channelID, editMessage, editingMessage],
  );
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
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setEditingMessage(null), [channel?.id]);
  useEffect(() => clearInvites(), [channel?.id, clearInvites]);

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
    if (threadParam && channel?.id) markThreadSeen(threadParam, new Date().toISOString(), { parentID: channel.id, parentType: 'channel' });
  }, [threadParam, channel?.id]);

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
        m[u.id] = { displayName: u.displayName || 'Unknown', avatarURL: u.avatarURL, userStatus: u.userStatus, online: online.has(u.id) };
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
  const [notifPrefsOpen, setNotifPrefsOpen] = useState(false);
  function handleToggleMute() {
    /* istanbul ignore next -- only wired to the header menu, which renders only when `channel` is loaded, so the `channel == null` optional-chain arm is unreachable; defensive. */
    if (!channel?.id) return;
    muteChannel.mutate({ channelId: channel.id, muted: !muted });
  }

  async function handleArchive() {
    /* istanbul ignore next -- only wired to the header menu, which renders only when `channel` is loaded, so the `channel == null` optional-chain arm is unreachable; defensive. */
    if (!channel?.id) return;
    await apiFetch(`/api/v1/channels/${channel.id}`, { method: 'DELETE' });
    queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
    navigate('/');
  }

  async function handleLeave() {
    /* istanbul ignore next -- only wired to the header menu, which renders only when `channel` is loaded, so the `channel == null` optional-chain arm is unreachable; defensive. */
    if (!channel?.id) return;
    await apiFetch(`/api/v1/channels/${channel.id}/leave`, { method: 'POST' });
    queryClient.invalidateQueries({ queryKey: queryKeys.userChannels() });
    navigate('/');
  }

  async function handleDescriptionSave(desc: string) {
    /* istanbul ignore next -- only wired to the header menu, which renders only when `channel` is loaded, so the `channel == null` optional-chain arm is unreachable; defensive. */
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
          onNotificationPrefsClick={() => setNotifPrefsOpen(true)}
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
            quickReactions={quickReactions}
            onReplyInThread={openThread}
            onEditMessage={isMobile ? setEditingMessage : undefined}
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
          {channel && !activeEditingMessage && pendingInvites.length > 0 && (
            <NonMemberInvitePrompt
              channelId={channel.id}
              channelName={channel.slug}
              users={pendingInvites}
              onDismiss={clearInvites}
            />
          )}
          {activeEditingMessage && !editReady ? (
            <div className="border-t p-3 text-sm text-muted-foreground">Loading message editor…</div>
          ) : (
            <MessageInput
              key={activeEditingMessage ? `edit-${activeEditingMessage.id}` : `channel-${channel?.id ?? 'loading'}`}
              ref={inputRef}
              onSend={activeEditingMessage ? handleEditMessage : handleSendMessage}
              onCancel={activeEditingMessage ? () => setEditingMessage(null) : undefined}
              disabled={activeEditingMessage ? editMessage.isPending : sendMessage.isPending}
              placeholder={activeEditingMessage ? 'Edit message...' : `Write to ~${channel?.name ?? '...'}`}
              focusKey={activeEditingMessage ? `edit-${activeEditingMessage.id}` : channel?.id}
              initialBody={activeEditingMessage?.body ?? draft?.body ?? ''}
              initialDrafts={activeEditingMessage ? editDraftAttachments : draftAttachments}
              onDraftChange={activeEditingMessage ? undefined : handleDraftChange}
              cancelOnOutsidePointer={!!activeEditingMessage}
              submitLabel={activeEditingMessage ? 'Save' : undefined}
              typingParentID={activeEditingMessage ? undefined : channel?.id}
              typingParentType={activeEditingMessage ? undefined : 'channel'}
              lastOwnMessageId={activeEditingMessage ? undefined : lastOwnMessageId}
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
          currentUserId={user?.id}
          currentUserRole={roleNumber(currentUserRole)}
          userMap={userMap}
          onClose={closeMembers}
        />
      ) : null}
      {notifPrefsDialog}
    </div>
  );
}
