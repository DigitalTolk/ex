import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Navigate, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { ConvertToChannelDialog } from '@/components/channels/ConvertToChannelDialog';
import { useQueryClient } from '@tanstack/react-query';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { useFrequentEmojis } from '@/hooks/useEmoji';
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
import { DMIntro, SelfDMIntro, GroupIntro } from './ConversationIntro';
import { TypingIndicator } from './TypingIndicator';
import { AgentActivityIndicator } from './AgentActivityIndicator';
import { AgentApprovalCard } from './AgentApprovalCard';
import { WatcherCatchUpCard } from './WatcherCatchUpCard';
import { useConversation, useUserConversations } from '@/hooks/useConversations';
import { useConversationMessages } from '@/hooks/useMessages';
import { useAuth } from '@/context/AuthContext';
import { useUnread } from '@/context/UnreadContext';
import { markThreadSeen, noteThreadReadPosition } from '@/hooks/useThreads';
import { findLastOwnMessageId } from '@/lib/message-users';
import { useMessagePageUserIDs } from '@/hooks/useMessagePageUserIDs';
import { useSidePanels } from '@/hooks/useSidePanels';
import { useTagState } from '@/context/TagSearchContext';
import { TagSearchPanel } from '@/components/TagSearchPanel';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useDeepLinkAnchor, useListAnchor, forgetDeepLinkInAddress } from '@/hooks/useDeepLinkAnchor';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useIsOnline } from '@/stores/presence';
import { firstName } from '@/lib/format';
import type { Conversation, UserConversation } from '@/types';
import { useEventCallback } from '@/hooks/useEventCallback';
import { useEqualValue } from '@/hooks/useEqualValue';
import { sameUserMap } from '@/lib/user-map-equal';
import type { UserMapEntry } from './MessageList';
import { useParentChat } from '@/hooks/useParentChat';
import { ChannelRole } from '@/lib/roles';

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
  const location = useLocation();
  const [convertOpen, setConvertOpen] = useState(false);
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const { setActiveThread } = useUnread();
  const quickReactions = useFrequentEmojis(6);
  const { data: conversation, error: conversationError, isLoading: conversationLoading } = useConversation(id);
  // The sidebar's name for this chat, shown while the conversation loads.
  // Only that name, not the whole list: any chat's unread change rewrites the
  // list, and subscribing to all of it re-rendered this open chat.
  const selectKnownName = useCallback(
    (rows: UserConversation[]) => rows.find((c) => c.conversationID === id)?.displayName,
    [id],
  );
  const { data: knownName } = useUserConversations({ select: selectKnownName });
  const { mainAnchor, threadAnchor, threadParam, navKey } = useDeepLinkAnchor(id);
  // A link-opened window can be swapped for the newest messages (keeping any
  // open thread) — see the MessageList pill.
  const { listAnchor, showLatest } = useListAnchor(mainAnchor, navKey);
  const {
    data,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    fetchNextPage,
    hasPreviousPage,
    isFetchingPreviousPage,
    fetchPreviousPage,
  } = useConversationMessages(id, listAnchor);
  const isMobile = useIsMobile();
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
  } = useParentChat({ kind: 'conversation', id, userID: user?.id });

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
    if (urlThread) {
      setDismissed({ navKey, thread: urlThread });
      forgetDeepLinkInAddress();
    }
  };
  const openMembers = () => { dismissThread(); closeTag(); panels.open('members'); };
  const closeMembers = panels.close;
  // Stable: it reaches every message row as a prop, and a fresh function per
  // render re-rendered all mounted rows on each list change.
  const openThread = useCallback((rid: string) => {
    setThreadRootID(rid);
    closeTag();
    panels.close();
  }, [closeTag, panels]);
  const closeThread = dismissThread;
  const togglePinned = () => { dismissThread(); closeTag(); panels.toggle('pinned'); };
  const toggleFiles = () => { dismissThread(); closeTag(); panels.toggle('files'); };
  const showMembers = panels.isActive('members');
  const showPinned = panels.isActive('pinned');
  const showFiles = panels.isActive('files');

  // Reset locally-opened thread when the conversation changes.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setThreadRootID(null), [id]);

  // The displayed thread is the local one if set, otherwise the URL-
  // driven one — unless the user has dismissed it.
  const urlThreadActive = !!threadParam && threadParam !== dismissedThreadParam;
  const effectiveThreadRootID = threadRootID ?? (urlThreadActive ? threadParam : null) ?? null;

  // Mark URL-driven threads as seen exactly once per change — noting first
  // where the user had read up to, for the thread's "New messages" line.
  useEffect(() => {
    if (!threadParam || !id) return;
    noteThreadReadPosition(queryClient, threadParam);
    markThreadSeen(threadParam, new Date().toISOString(), { parentID: id, parentType: 'conversation' });
  }, [threadParam, id, queryClient]);

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

  // Walked per page, and only the page an event changed (useMessagePageUserIDs).
  const userIDs = useMessagePageUserIDs(data?.pages, conversation?.participantIDs);

  const { data: usersData } = useUsersBatch(userIDs);

  const lastOwnMessageId = useMemo(
    () => findLastOwnMessageId(data?.pages, user?.id, 'main'),
    [data, user?.id],
  );

  const builtUserMap = useMemo(() => {
    const m: Record<string, UserMapEntry> = {};
    if (user) m[user.id] = { displayName: user.displayName, avatarURL: user.avatarURL, userStatus: user.userStatus };
    if (usersData) {
      for (const u of usersData) {
        m[u.id] = { displayName: u.displayName || 'Unknown', avatarURL: u.avatarURL, userStatus: u.userStatus };
      }
    }
    return m;
  }, [user, usersData]);
  // Rebuilt with the same entries it keeps its identity (see ChannelView).
  const userMap = useEqualValue(builtUserMap, sameUserMap);

  // Per-user presence for the DM partner (header dot + intro card). The
  // hook must run unconditionally, so the partner ID is derived here and
  // the dm-only branches below consume the result.
  const dmPartnerID =
    conversation?.type === 'dm'
      ? conversation.participantIDs?.find((pid) => pid !== user?.id)
      : undefined;
  const partnerOnline = useIsOnline(dmPartnerID);

  const derivedTitle = useMemo(
    () => deriveConversationTitle(conversation, user?.id, userMap),
    [conversation, user?.id, userMap],
  );
  useDocumentTitle(derivedTitle);

  // Stable identities for the (memoized) header.
  const isGroup = conversation?.type === 'group';
  const toggleMembers = useEventCallback(() => (showMembers ? closeMembers() : openMembers()));
  const onPinnedClick = useEventCallback(togglePinned);
  const onFilesClick = useEventCallback(toggleFiles);
  const openConvert = useCallback(() => setConvertOpen(true), []);

  if (!id) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        Select a conversation
      </div>
    );
  }

  // The group became a private channel: it carries on there, at the same
  // message or thread.
  if (conversation?.convertedToChannelID) {
    return <Navigate replace to={`/channel/${conversation.convertedToChannelID}${location.search}${location.hash}`} />;
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

  // derivedTitle is only missing while the conversation loads.
  const title = derivedTitle ?? knownName ?? 'Direct Message';
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
      dmOtherUserOnline = partnerOnline;
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
            online={partnerOnline}
          />
        );
      }
    }
  }

  const memberList = (conversation?.participantIDs ?? []).map((pid) => ({
    userID: pid,
    displayName: userMap[pid]?.displayName ?? 'Unknown',
    channelID: '',
    role: ChannelRole.Member,
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
          onMembersClick={isGroup ? toggleMembers : undefined}
          onPinnedClick={onPinnedClick}
          pinnedActive={showPinned}
          onFilesClick={onFilesClick}
          filesActive={showFiles}
          // Anyone in a group may make it a private channel; guests can't
          // create channels.
          onConvertToChannel={
            isGroup && user?.systemRole !== 'guest' ? openConvert : undefined
          }
        />
        {conversation?.type === 'group' && (
          <ConvertToChannelDialog conversationID={conversation.id} open={convertOpen} onOpenChange={setConvertOpen} />
        )}
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
            anchorMsgId={listAnchor}
            anchorRevision={navKey}
            onAtBottomChange={readSession.onAtBottomChange}
            onMarkAllRead={readSession.markAllRead}
            onJumpToLatest={() => {
              readSession.prepareJumpToLatest();
              showLatest();
            }}
            intro={intro ?? undefined}
          />
          {activeEditingMessage && !editReady ? (
            <div className="border-t p-3 text-sm text-muted-foreground">Loading message editor…</div>
          ) : (
            <MessageInput
              key={activeEditingMessage ? `edit-${activeEditingMessage.id}` : `conversation-${id}`}
              ref={inputRef}
              onSend={activeEditingMessage ? handleEditMessage : handleSendMessage}
              onSchedule={schedule.onSchedule}
              scheduledCount={schedule.scheduledCount}
              onCancel={activeEditingMessage ? () => setEditingMessage(null) : undefined}
              disabled={!!activeEditingMessage && editMessage.isPending}
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
                  <>
                    <AgentApprovalCard parentID={id} userMap={userMap} />
                    <WatcherCatchUpCard parentID={id} parentType="conversation" />
                    <AgentActivityIndicator parentID={id} userMap={userMap} />
                    <TypingIndicator parentID={id} userMap={userMap} />
                  </>
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
