import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { Header } from '@/components/layout/Header';
import { MessageList } from './MessageList';
import { MessageInput, type MessageInputHandle } from './MessageInput';
import { MessageDropZone } from './MessageDropZone';
import { MemberList } from './MemberList';
import { ThreadPanel } from './ThreadPanel';
import { PinnedPanel } from './PinnedPanel';
import { FilesPanel } from './FilesPanel';
import { DMIntro, SelfDMIntro, GroupIntro } from './ConversationIntro';
import { TypingIndicator } from './TypingIndicator';
import { useConversation } from '@/hooks/useConversations';
import {
  useConversationMessages,
  useSendConversationMessage,
} from '@/hooks/useMessages';
import { useAuth } from '@/context/AuthContext';
import { useUnread } from '@/context/UnreadContext';
import { usePresence } from '@/context/PresenceContext';
import { useNotifications } from '@/context/NotificationContext';
import { markThreadSeen } from '@/hooks/useThreads';
import { collectMessageUserIDs } from '@/lib/message-users';
import { useSidePanels } from '@/hooks/useSidePanels';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import type { Conversation } from '@/types';
import type { UserMapEntry } from './MessageList';

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
    if (others.length > 0) return others.join(', ');
  }
  return conv.name || 'Direct Message';
}

export function ConversationView() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const { clearConversationUnread, setActiveConversation } = useUnread();
  const { online } = usePresence();
  const { setActiveParent } = useNotifications();
  const { data: conversation } = useConversation(id);
  const {
    data,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    fetchNextPage,
  } = useConversationMessages(id);
  const sendMessage = useSendConversationMessage(id);

  useEffect(() => {
    if (!id) return;
    clearConversationUnread(id);
    setActiveConversation(id);
    setActiveParent(id);
    return () => {
      setActiveConversation(null);
      setActiveParent(null);
    };
  }, [id, clearConversationUnread, setActiveConversation, setActiveParent]);

  const [threadRootID, setThreadRootID] = useState<string | null>(null);
  const inputRef = useRef<MessageInputHandle>(null);
  const panels = useSidePanels<'members' | 'pinned' | 'files'>();

  const openMembers = () => { setThreadRootID(null); panels.open('members'); };
  const closeMembers = panels.close;
  const openThread = (rid: string) => { setThreadRootID(rid); panels.close(); };
  const closeThread = () => setThreadRootID(null);
  const togglePinned = () => { setThreadRootID(null); panels.toggle('pinned'); };
  const toggleFiles = () => { setThreadRootID(null); panels.toggle('files'); };
  const showMembers = panels.isActive('members');
  const showPinned = panels.isActive('pinned');
  const showFiles = panels.isActive('files');

  // Reset thread when the conversation changes; this is a deliberate
  // synchronous reset, not a sync between external state and React.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setThreadRootID(null), [id]);

  // Honor a ?thread=... deep link from the Threads page.
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

  const userIDs = useMemo(() => {
    const ids = new Set<string>();
    conversation?.participantIDs?.forEach((pid) => ids.add(pid));
    for (const page of data?.pages ?? []) {
      for (const id of collectMessageUserIDs(page.items)) ids.add(id);
    }
    return Array.from(ids);
  }, [conversation?.participantIDs, data]);

  const { data: usersData } = useUsersBatch(userIDs);

  const userMap = useMemo(() => {
    const m: Record<string, UserMapEntry> = {};
    if (user) m[user.id] = { displayName: user.displayName, avatarURL: user.avatarURL, online: true };
    if (usersData) {
      for (const u of usersData) {
        m[u.id] = { displayName: u.displayName || 'Unknown', avatarURL: u.avatarURL, online: online.has(u.id) };
      }
    }
    return m;
  }, [user, usersData, online]);

  useDocumentTitle(deriveConversationTitle(conversation, user?.id, userMap));

  if (!id) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        Select a conversation
      </div>
    );
  }

  const title = deriveConversationTitle(conversation, user?.id, userMap) ?? 'Direct Message';
  let dmOtherUserAvatar: string | undefined;
  if (conversation?.type === 'dm') {
    const otherID = conversation.participantIDs?.find((pid) => pid !== user?.id);
    if (otherID) {
      dmOtherUserAvatar = userMap[otherID]?.avatarURL;
    } else if (user) {
      dmOtherUserAvatar = user.avatarURL;
    }
  }

  // Build the appropriate intro variant for the conversation kind. We render
  // *something* once the conversation record loads — the empty-list state
  // alone isn't enough to signal "this is the start" for chats with the
  // user's first message already drafted in.
  let intro = null;
  if (conversation && user) {
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
    <div className="flex flex-1 overflow-hidden">
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header
          title={title}
          showAvatar={conversation?.type === 'dm'}
          avatarURL={conversation?.type === 'dm' ? dmOtherUserAvatar : undefined}
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
            currentUserId={user?.id}
            conversationId={id}
            userMap={userMap}
            onReplyInThread={openThread}
            intro={intro ?? undefined}
          />
          <TypingIndicator parentID={id} userMap={userMap} />
          <MessageInput
            ref={inputRef}
            onSend={sendMessage.mutate}
            disabled={sendMessage.isPending}
            placeholder={`Write to ${title}`}
            focusKey={id}
            typingParentID={id}
            typingParentType="conversation"
          />
        </MessageDropZone>
      </div>
      {threadRootID && (
        <ThreadPanel
          conversationId={id}
          threadRootID={threadRootID}
          onClose={closeThread}
          userMap={userMap}
          currentUserId={user?.id}
        />
      )}
      {showPinned && !threadRootID && (
        <PinnedPanel
          conversationId={id}
          onClose={panels.close}
          userMap={userMap}
          currentUserId={user?.id}
        />
      )}
      {showFiles && !threadRootID && (
        <FilesPanel
          conversationId={id}
          onClose={panels.close}
          userMap={userMap}
        />
      )}
      {showMembers && !threadRootID && conversation?.type === 'group' && (
        <MemberList
          members={memberList}
          userMap={userMap}
          currentUserId={user?.id}
          onClose={closeMembers}
        />
      )}
    </div>
  );
}
