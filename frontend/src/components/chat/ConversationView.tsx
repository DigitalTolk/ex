import { useState, useEffect, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { Header } from '@/components/layout/Header';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { MemberList } from './MemberList';
import { ThreadPanel } from './ThreadPanel';
import { PinnedPanel } from './PinnedPanel';
import { DMIntro, SelfDMIntro, GroupIntro } from './ConversationIntro';
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
import type { UserMapEntry } from './MessageList';

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

  const [showMembers, setShowMembers] = useState(false);
  const [threadRootID, setThreadRootID] = useState<string | null>(null);
  const [showPinned, setShowPinned] = useState(false);

  const openMembers = () => { setShowMembers(true); setThreadRootID(null); setShowPinned(false); };
  const closeMembers = () => setShowMembers(false);
  const openThread = (rid: string) => { setThreadRootID(rid); setShowMembers(false); setShowPinned(false); };
  const closeThread = () => setThreadRootID(null);
  const togglePinned = () => {
    setShowPinned((v) => {
      const next = !v;
      if (next) { setThreadRootID(null); setShowMembers(false); }
      return next;
    });
  };

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
    setSearchParams(next, { replace: true });
  }, [threadParam, searchParams, setSearchParams]);

  // Collect all user IDs (participants + authors)
  const userIDs = useMemo(() => {
    const ids = new Set<string>();
    conversation?.participantIDs?.forEach((pid) => ids.add(pid));
    for (const page of data?.pages ?? []) {
      for (const msg of page.items) ids.add(msg.authorID);
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

  if (!id) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        Select a conversation
      </div>
    );
  }

  // Derive title from conversation type and participant names
  let title = conversation?.name || 'Direct Message';
  let dmOtherUserAvatar: string | undefined;

  if (conversation?.type === 'dm') {
    const otherID = conversation.participantIDs?.find((pid) => pid !== user?.id);
    if (otherID) {
      // DM with someone else — use their name once the user batch loads.
      if (userMap[otherID]) {
        title = userMap[otherID].displayName;
        dmOtherUserAvatar = userMap[otherID].avatarURL;
      }
    } else if (user) {
      // Self-DM (notes-to-self) — the only participant is the current
      // user. Show their own display name + avatar instead of the
      // generic "Direct Message" fallback.
      title = user.displayName;
      dmOtherUserAvatar = user.avatarURL;
    }
  } else if (conversation?.type === 'group') {
    const others = (conversation.participantIDs ?? [])
      .filter((pid) => pid !== user?.id)
      .map((pid) => userMap[pid]?.displayName)
      .filter(Boolean) as string[];
    if (others.length > 0) {
      title = others.join(', ');
    } else if (conversation?.name) {
      title = conversation.name;
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
          avatarURL={conversation?.type === 'dm' ? dmOtherUserAvatar : undefined}
          memberCount={conversation?.type === 'group' ? conversation?.participantIDs?.length : undefined}
          onMembersClick={conversation?.type === 'group' ? () => (showMembers ? closeMembers() : openMembers()) : undefined}
          onPinnedClick={togglePinned}
          pinnedActive={showPinned}
        />
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
        <MessageInput
          onSend={sendMessage.mutate}
          disabled={sendMessage.isPending}
          placeholder={`Write to ${title}`}
          focusKey={id}
        />
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
          onClose={() => setShowPinned(false)}
          userMap={userMap}
          currentUserId={user?.id}
        />
      )}
      {showMembers && !threadRootID && !showPinned && conversation?.type === 'group' && (
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
