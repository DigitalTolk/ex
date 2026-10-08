import type { UnreadAnchor } from '@/lib/read-position';
import type { Message } from '@/types';

// Which messages advanced the parent's unread counter — the client mirror of
// the server's rule (countsTowardUnread in message_unread.go): a top-level
// message, and in a channel not a system join/leave notice. Deleted messages
// still count; they stay in the list as placeholders.
export function countsTowardUnread(m: Message, parentType: 'channel' | 'conversation'): boolean {
  if (m.parentMessageID) return false;
  return parentType !== 'channel' || !m.system;
}

// resolveUnreadDivider finds the first unread message in `messages`
// (chronological) for an anchor, or null when it isn't among the loaded ones
// (older than the oldest loaded page, or not arrived yet).
export function resolveUnreadDivider(
  anchor: UnreadAnchor,
  messages: Message[],
  parentType: 'channel' | 'conversation',
): string | null {
  switch (anchor.kind) {
    case 'message':
      return messages.some((m) => m.id === anchor.messageID) ? anchor.messageID : null;
    case 'count': {
      let seen = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (!countsTowardUnread(messages[i], parentType)) continue;
        seen++;
        if (seen === anchor.count) return messages[i].id;
      }
      return null;
    }
    case 'after': {
      const at = new Date(anchor.at).getTime();
      const first = messages.find((m) => new Date(m.createdAt).getTime() > at);
      return first ? first.id : null;
    }
  }
}

// unreadFrom counts the counted messages from `messageID` to the end — the
// banner's "N new messages".
export function unreadFrom(messages: Message[], messageID: string, parentType: 'channel' | 'conversation'): number {
  const start = messages.findIndex((m) => m.id === messageID);
  if (start < 0) return 0;
  return messages.slice(start).filter((m) => countsTowardUnread(m, parentType)).length;
}
