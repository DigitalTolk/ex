import type { Message } from '@/types';
import type { ThreadMeta } from '@/lib/message-users';
import type { UserMapEntry } from './MessageList';

// What MessageList hands each message row (its memoized MessageRow).
export type MessageRowProps = {
  row: { kind: 'message'; key: string; message: Message; firstInGroup: boolean };
  userMap: Record<string, UserMapEntry>;
  userLookup: { get(id: string): UserMapEntry | undefined };
  threadMetaEntry?: ThreadMeta;
  currentUserId?: string;
  channelId?: string;
  channelSlug?: string;
  conversationId?: string;
  onReplyInThread?: (id: string) => void;
  onEditMessage?: (message: Message) => void;
  highlighted?: boolean;
  onContentHeightChange?: () => void;
  quickReactions?: string[];
  readOnly?: boolean;
  threadHasNew?: boolean;
};

// buildMessageListRows makes a fresh row object for every message on every
// list change, so a plain memo re-rendered every mounted row (and its emoji
// pickers) on each send — ~300ms of main-thread time per cache update in dev.
// Compare the row by what it holds; the message object itself keeps its
// identity across cache patches unless it changed.
export function messageRowPropsEqual(prev: MessageRowProps, next: MessageRowProps): boolean {
  if (prev.row !== next.row) {
    if (
      prev.row.key !== next.row.key ||
      prev.row.message !== next.row.message ||
      prev.row.firstInGroup !== next.row.firstInGroup
    ) {
      return false;
    }
  }
  if (prev.threadMetaEntry !== next.threadMetaEntry) {
    const a = prev.threadMetaEntry;
    const b = next.threadMetaEntry;
    if (!a || !b || a.lastReplyAt !== b.lastReplyAt || a.authors.length !== b.authors.length) return false;
    if (a.authors.some((id, i) => id !== b.authors[i])) return false;
  }
  for (const key of Object.keys(next) as (keyof MessageRowProps)[]) {
    if (key === 'row' || key === 'threadMetaEntry') continue;
    if (prev[key] !== next[key]) return false;
  }
  return true;
}
