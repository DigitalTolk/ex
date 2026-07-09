import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { useFrequentEmojis } from '@/hooks/useEmoji';
import { Header } from '@/components/layout/Header';
import { MessageList } from './MessageList';
import { MessageInput, type MessageInputHandle, type MessageInputValue } from './MessageInput';
import { MessageDropZone } from './MessageDropZone';
import { MemberList } from './MemberList';
import { ThreadPanel } from './ThreadPanel';
import { PinnedPanel } from './PinnedPanel';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { ResourceErrorPage } from '@/pages/ResourceErrorPage';
import { FilesPanel } from './FilesPanel';
import { DMIntro, SelfDMIntro, GroupIntro } from './ConversationIntro';
import { TypingIndicator } from './TypingIndicator';
import { useConversation } from '@/hooks/useConversations';
import {
  useConversationMessages,
  useEditMessage,
  useSendConversationMessage,
} from '@/hooks/useMessages';
import { useAuth } from '@/context/AuthContext';
import { useUnread } from '@/context/UnreadContext';
import { usePresence } from '@/context/PresenceContext';
import { useNotifications } from '@/context/NotificationContext';
import { markThreadSeen } from '@/hooks/useThreads';
import { collectMessageUserIDs, findLastOwnMessageId } from '@/lib/message-users';
import { useSidePanels } from '@/hooks/useSidePanels';
import { useTagState } from '@/context/TagSearchContext';
import { TagSearchPanel } from '@/components/TagSearchPanel';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useDeepLinkAnchor } from '@/hooks/useDeepLinkAnchor';
import { useIsMobile } from '@/hooks/useIsMobile';
import {
  useDraftAttachmentChips,
  useDraftForScope,
  useSaveDraft,
} from '@/hooks/useDrafts';
import { useAttachmentsBatch } from '@/hooks/useAttachments';
import { firstName } from '@/lib/format';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { clearConversationUnreadInCache } from '@/lib/unread-cache';
import type { Conversation, Message } from '@/types';
import type { UserMapEntry } from './MessageList';
import type { DraftAttachment } from './AttachmentChip';

function errorStatus(err: unknown): number | null {
  return typeof err === 'object' && err !== null && 'status' in err
    ? Number((err as { status?: unknown }).status)
    : null;
}

// Resolves a human-readable label for the conversation header, document
// title, and intro card. Returns null when the conversation isn't
// loaded yet so the document title falls through to the bare app name
// instead of a flash of "Direct Message".
function deriveConversationTitle(
  conv: Conversation | undefined,
  selfID: string | undefined,
  userMap: Record<string, UserMapEntry>,
): string | null {
  if (!conv) return null;
  if (conv.type === 'dm') {
    const otherID = conv.participantIDs?.find((pid) => pid !== selfID);
    if (otherID) return userMap[otherID]?.displayName ?? conv.name ?? 'Direct Message';
    return userMap[selfID ?? '']?.displayName ?? conv.name ?? 'Direct Message';
  }
  if (conv.type === 'group') {
    const others = (conv.participantIDs ?? [])
      .filter((pid) => pid !== selfID)
      .map((pid) => userMap[pid]?.displayName)
      .filter(Boolean) as string[];
    // First names only — a comma-joined list of full names doesn't
    // scale past two or three members. Custom group names (set via
    // conv.name) bypass this branch entirely and stay unchanged.
    if (others.length > 0) return others.map(firstName).join(', ');
  }
  return conv.name || 'Direct Message';
}

export function ConversationView() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const { setActiveConversation, setActiveThread } = useUnread();
  const { online } = usePresence();
  const quickReactions = useFrequentEmojis(3);
  const { setActiveParent } = useNotifications();
  const { data: conversation, error: conversationError, isLoading: conversationLoading } = useConversation(id);
  const { mainAnchor, threadAnchor, threadParam, navKey } = useDeepLinkAnchor(id);
  const {
    data,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    fetchNextPage,
    hasPreviousPage,
    isFetchingPreviousPage,
    fetchPreviousPage,
  } = useConversationMessages(id, mainAnchor);
  const sendMessage = useSendConversationMessage(id);
  const draftScope = useMemo(
    () => ({ parentID: id, parentType: 'conversation' as const }),
    [id],
  );
  const { data: draft } = useDraftForScope(draftScope);
  const draftAttachments = useDraftAttachmentChips(draft?.attachmentIDs);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const isMobile = useIsMobile();
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
      ? { parentID: id, parentType: 'conversation', messageID: activeEditingMessage.id }
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
  const saveDraft = useSaveDraft();
  const saveDraftMutate = saveDraft.mutate;
  const handleDraftChange = useCallback(
    (value: MessageInputValue, options?: { notify?: boolean; keepalive?: boolean }) => {
      /* istanbul ignore next -- the composer (this callback's only caller) is rendered only after the `if (!id)` early-return, so the guard can never fire; defensive. */
      if (!id) return;
      saveDraftMutate({
        parentID: id,
        parentType: 'conversation',
        body: value.body,
        attachmentIDs: value.attachmentIDs,
        // Keystroke saves persist silently; the focus-loss flush (notify)
        // is what surfaces the draft in the sidebar.
        silent: !options?.notify,
        keepalive: options?.keepalive,
      });
    },
    [id, saveDraftMutate],
  );
  const handleSendMessage = useCallback(
    (value: { body: string; attachmentIDs: string[] }) => {
      // Draft lifecycle (condemn at mutate, cache patch-out on success,
      // rollback on error) is owned by useSendMessage.
      sendMessage.mutate(value);
    },
    [sendMessage],
  );
  const handleEditMessage = useCallback(
    (value: { body: string; attachmentIDs: string[] }) => {
      /* istanbul ignore next -- handleEditMessage is only wired as the composer's onSend while activeEditingMessage (hence editingMessage) is set, so it is never invoked with a null editingMessage. */
      if (!editingMessage) return;
      const currentAttachmentIDs = editingMessage.attachmentIDs ?? [];
      const same =
        value.body === editingMessage.body &&
        value.attachmentIDs.length === currentAttachmentIDs.length &&
        value.attachmentIDs.every((attID, idx) => attID === currentAttachmentIDs[idx]);
      if (same || (!value.body.trim() && value.attachmentIDs.length === 0)) {
        setEditingMessage(null);
        return;
      }
      editMessage.mutate(
        {
          messageId: editingMessage.id,
          body: value.body,
          attachmentIDs: value.attachmentIDs,
          conversationId: id,
        },
        { onSuccess: () => setEditingMessage(null) },
      );
    },
    [editMessage, editingMessage, id],
  );

  useEffect(() => {
    if (!id) return;
    // Drop the badge instantly in the list cache, then persist the read so it
    // stays cleared on a reload (the refetch confirms the server count is 0).
    clearConversationUnreadInCache(queryClient, id);
    setActiveConversation(id);
    setActiveParent(id);
    void apiFetch<void>(`/api/v1/conversations/${id}/read`, { method: 'PUT' })
      .catch(() => undefined)
      .finally(() => {
        queryClient.invalidateQueries({ queryKey: queryKeys.userConversations() });
      });
    return () => {
      setActiveConversation(null);
      setActiveParent(null);
    };
  }, [id, setActiveConversation, setActiveParent, queryClient]);

  const [threadRootID, setThreadRootID] = useState<string | null>(null);
  const inputRef = useRef<MessageInputHandle>(null);
  const panels = useSidePanels<'members' | 'pinned' | 'files'>();
  const { activeTag, closeTag } = useTagState();

  // Tracks a URL-driven thread the user has dismissed. See
  // ChannelView for the full rationale — stripping the URL on close
  // collides with the deep-link anchor effect and yanks scroll.
  // The dismissal is keyed to the navKey so it auto-expires when
  // the user navigates anywhere.
  const [dismissed, setDismissed] = useState<{ navKey?: string; thread: string } | null>(null);
  const dismissedThreadParam =
    dismissed && dismissed.navKey === navKey ? dismissed.thread : null;
  const dismissThread = () => {
    setThreadRootID(null);
    const urlThread = searchParams.get('thread');
    if (urlThread) setDismissed({ navKey, thread: urlThread });
  };
  const openMembers = () => { dismissThread(); closeTag(); panels.open('members'); };
  const closeMembers = panels.close;
  const openThread = (rid: string) => {
    setThreadRootID(rid);
    closeTag();
    panels.close();
  };
  const closeThread = dismissThread;
  const togglePinned = () => { dismissThread(); closeTag(); panels.toggle('pinned'); };
  const toggleFiles = () => { dismissThread(); closeTag(); panels.toggle('files'); };
  const showMembers = panels.isActive('members');
  const showPinned = panels.isActive('pinned');
  const showFiles = panels.isActive('files');

  // Reset locally-opened thread when the conversation changes.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setThreadRootID(null), [id]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setEditingMessage(null), [id]);

  // The displayed thread is the local one if set, otherwise the URL-
  // driven one — unless the user has dismissed it.
  const urlThreadActive = !!threadParam && threadParam !== dismissedThreadParam;
  const effectiveThreadRootID = threadRootID ?? (urlThreadActive ? threadParam : null) ?? null;

  // Mark URL-driven threads as seen exactly once per change.
  useEffect(() => {
    if (threadParam && id) markThreadSeen(threadParam, new Date().toISOString(), { parentID: id, parentType: 'conversation' });
  }, [threadParam, id]);

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

  const userIDs = useMemo(() => {
    const ids = new Set<string>();
    conversation?.participantIDs?.forEach((pid) => ids.add(pid));
    for (const page of data?.pages ?? []) {
      for (const id of collectMessageUserIDs(page.items)) ids.add(id);
    }
    return Array.from(ids);
  }, [conversation?.participantIDs, data]);

  const { data: usersData } = useUsersBatch(userIDs);

  const lastOwnMessageId = useMemo(
    () => findLastOwnMessageId(data?.pages, user?.id, 'main'),
    [data, user?.id],
  );

  const userMap = useMemo(() => {
    const m: Record<string, UserMapEntry> = {};
    if (user) m[user.id] = { displayName: user.displayName, avatarURL: user.avatarURL, userStatus: user.userStatus, online: true };
    if (usersData) {
      for (const u of usersData) {
        m[u.id] = { displayName: u.displayName || 'Unknown', avatarURL: u.avatarURL, userStatus: u.userStatus, online: online.has(u.id) };
      }
    }
    return m;
  }, [user, usersData, online]);

  const derivedTitle = useMemo(
    () => deriveConversationTitle(conversation, user?.id, userMap),
    [conversation, user?.id, userMap],
  );
  useDocumentTitle(derivedTitle);

  if (!id) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        Select a conversation
      </div>
    );
  }

  const conversationErrorStatus = errorStatus(conversationError);
  if (conversationErrorStatus === 404) {
    return <NotFoundPage resource="conversation" />;
  }
  if (conversationErrorStatus === 403) {
    return <ResourceErrorPage resource="conversation" status={403} />;
  }
  if (conversationError || (!conversationLoading && !conversation)) {
    return <ResourceErrorPage resource="conversation" status={500} />;
  }

  const title = derivedTitle ?? 'Direct Message';
  let dmOtherUserID: string | undefined;
  let dmOtherUserAvatar: string | undefined;
  let dmOtherUserStatus = user?.userStatus;
  let dmOtherUserOnline: boolean | undefined;
  if (conversation?.type === 'dm') {
    const otherID = conversation.participantIDs?.find((pid) => pid !== user?.id);
    if (otherID) {
      dmOtherUserID = otherID;
      dmOtherUserAvatar = userMap[otherID]?.avatarURL;
      dmOtherUserStatus = userMap[otherID]?.userStatus;
      dmOtherUserOnline = userMap[otherID]?.online;
    } else if (user) {
      dmOtherUserID = user.id;
      dmOtherUserAvatar = user.avatarURL;
      dmOtherUserStatus = user.userStatus;
      dmOtherUserOnline = true;
    }
  }

  // Build the appropriate intro variant for the conversation kind.
  // Gate it behind "the conversation has at least one message" so a
  // brand-new DM/group doesn't render the intro until the first
  // message is sent — the participants haven't been notified yet
  // and an intro card would imply the conversation already exists.
  // Public/private channels handle this differently: they render
  // the intro immediately on empty list (see ChannelView).
  const hasMessages = (data?.pages ?? []).some((p) => p.items.length > 0);
  let intro = null;
  if (conversation && user && hasMessages) {
    if (conversation.type === 'group') {
      const participants = (conversation.participantIDs ?? [])
        .filter((pid) => pid !== user.id)
        .map((pid) => ({
          id: pid,
          displayName: userMap[pid]?.displayName ?? 'Unknown',
          avatarURL: userMap[pid]?.avatarURL,
        }));
      intro = <GroupIntro participants={participants} />;
    } else {
      const otherID = conversation.participantIDs?.find((pid) => pid !== user.id);
      if (!otherID) {
        intro = (
          <SelfDMIntro
            selfDisplayName={user.displayName}
            selfAvatarURL={user.avatarURL}
          />
        );
      } else {
        const other = userMap[otherID];
        intro = (
          <DMIntro
            otherDisplayName={other?.displayName ?? 'Unknown'}
            otherAvatarURL={other?.avatarURL}
            online={other?.online}
          />
        );
      }
    }
  }

  const memberList = (conversation?.participantIDs ?? []).map((pid) => ({
    userID: pid,
    displayName: userMap[pid]?.displayName ?? 'Unknown',
    channelID: '',
    role: 'member' as const,
    joinedAt: '',
  }));

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Header
          title={title}
          showAvatar={conversation?.type === 'dm'}
          avatarURL={conversation?.type === 'dm' ? dmOtherUserAvatar : undefined}
          avatarOnline={conversation?.type === 'dm' ? dmOtherUserOnline : undefined}
          userStatus={conversation?.type === 'dm' ? dmOtherUserStatus : undefined}
          userId={conversation?.type === 'dm' ? dmOtherUserID : undefined}
          currentUserId={user?.id}
          memberCount={conversation?.type === 'group' ? conversation?.participantIDs?.length : undefined}
          onMembersClick={conversation?.type === 'group' ? () => (showMembers ? closeMembers() : openMembers()) : undefined}
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
            conversationId={id}
            userMap={userMap}
            quickReactions={quickReactions}
            onReplyInThread={openThread}
            onEditMessage={isMobile ? setEditingMessage : undefined}
            anchorMsgId={mainAnchor}
            anchorRevision={navKey}
            intro={intro ?? undefined}
          />
          {activeEditingMessage && !editReady ? (
            <div className="border-t p-3 text-sm text-muted-foreground">Loading message editor…</div>
          ) : (
            <MessageInput
              key={activeEditingMessage ? `edit-${activeEditingMessage.id}` : `conversation-${id}`}
              ref={inputRef}
              onSend={activeEditingMessage ? handleEditMessage : handleSendMessage}
              onCancel={activeEditingMessage ? () => setEditingMessage(null) : undefined}
              disabled={activeEditingMessage ? editMessage.isPending : sendMessage.isPending}
              placeholder={activeEditingMessage ? 'Edit message...' : `Write to ${title}`}
              focusKey={activeEditingMessage ? `edit-${activeEditingMessage.id}` : id}
              initialBody={activeEditingMessage?.body ?? draft?.body ?? ''}
              initialDrafts={activeEditingMessage ? editDraftAttachments : draftAttachments}
              onDraftChange={activeEditingMessage ? undefined : handleDraftChange}
              cancelOnOutsidePointer={!!activeEditingMessage}
              submitLabel={activeEditingMessage ? 'Save' : undefined}
              typingParentID={activeEditingMessage ? undefined : id}
              typingParentType={activeEditingMessage ? undefined : 'conversation'}
              lastOwnMessageId={activeEditingMessage ? undefined : lastOwnMessageId}
              aboveInput={
                activeEditingMessage ? undefined : (
                  <TypingIndicator parentID={id} userMap={userMap} />
                )
              }
            />
          )}
        </MessageDropZone>
      </div>
      {effectiveThreadRootID ? (
        <ThreadPanel
          conversationId={id}
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
          conversationId={id}
          onClose={panels.close}
          userMap={userMap}
          currentUserId={user?.id}
          onReplyInThread={openThread}
        />
      ) : showFiles ? (
        <FilesPanel
          conversationId={id}
          onClose={panels.close}
          userMap={userMap}
          postedIn={title}
        />
      ) : showMembers && conversation?.type === 'group' ? (
        <MemberList
          members={memberList}
          userMap={userMap}
          currentUserId={user?.id}
          onClose={closeMembers}
        />
      ) : null}
    </div>
  );
}
