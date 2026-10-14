import type { UnreadAnchor } from '@/lib/read-position';
import { isOwnMessage } from '@/lib/message-users';
import type { Message } from '@/types';

// Which messages advanced the parent's unread counter — the client mirror of
// the server's rule (countsTowardUnread in message_unread.go): a top-level
// message, and in a channel not a system join/leave notice. Deleted messages
// still count; they stay in the list as placeholders.
export function countsTowardUnread(m: Message, parentType: 'channel' | 'conversation'): boolean {
  if (m.parentMessageID) return false;
  return parentType !== 'channel' || !m.system;
}

// isNewTo: a reader's own messages are never "new" to them. The server never
// counts them (posting marks the author caught up), so the line, the banner
// and the pill skip them too.
function isNewTo(m: Message, parentType: 'channel' | 'conversation', currentUserID: string | undefined): boolean {
  return countsTowardUnread(m, parentType) && !isOwnMessage(m, currentUserID);
}

// resolveUnreadDivider finds the first unread message in `messages`
// (chronological) for an anchor, or null when it isn't among the loaded ones
// (older than the oldest loaded page, or not arrived yet). A count — the
// server's unread count when the chat opened — counts back over the messages
// that count towards it: other people's. Counting the reader's own posts too
// put the line above a post they made after opening. A thread's time anchor
// likewise skips the reader's own replies: after the seen time was noted, a
// reply of theirs is the first thing newer than it.
export function resolveUnreadDivider(
  anchor: UnreadAnchor,
  messages: Message[],
  parentType: 'channel' | 'conversation',
  currentUserID?: string,
): string | null {
  switch (anchor.kind) {
    case 'message':
      return messages.some((m) => m.id === anchor.messageID) ? anchor.messageID : null;
    case 'count': {
      let seen = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (!isNewTo(messages[i], parentType, currentUserID)) continue;
        seen++;
        if (seen === anchor.count) return messages[i].id;
      }
      return null;
    }
    case 'after': {
      const at = new Date(anchor.at).getTime();
      const first = messages.find((m) => !isOwnMessage(m, currentUserID) && new Date(m.createdAt).getTime() > at);
      return first ? first.id : null;
    }
  }
}

// unreadFrom counts the new messages from `messageID` to the end — the
// banner's and pill's "N new messages" — leaving out the reader's own.
export function unreadFrom(
  messages: Message[],
  messageID: string,
  parentType: 'channel' | 'conversation',
  currentUserID?: string,
): number {
  const start = messages.findIndex((m) => m.id === messageID);
  if (start < 0) return 0;
  return messages.slice(start).filter((m) => isNewTo(m, parentType, currentUserID)).length;
}
