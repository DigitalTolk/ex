import type { Message } from '@/types';

// collectMessageUserIDs walks a sequence of messages and returns the set of
// every user ID referenced by them: authors, recent thread-reply authors,
// and reactors. Used by ChannelView and ConversationView to size a single
// /users/batch fetch that covers everything the page can render — thread
// action bars and reaction tooltips both read display names through it.
export function collectMessageUserIDs(messages: Iterable<Message>): string[] {
  const ids = new Set<string>();
  for (const msg of messages) {
    ids.add(msg.authorID);
    msg.recentReplyAuthorIDs?.forEach((id) => ids.add(id));
    if (msg.reactions) {
      for (const users of Object.values(msg.reactions)) {
        users.forEach((id) => ids.add(id));
      }
    }
  }
  return Array.from(ids);
}

export interface ThreadMeta {
  lastReplyAt: string;
  authors: string[]; // distinct, most-recent first, capped at 3
}

// deriveThreadMeta builds per-thread metadata (latest reply timestamp +
// the last 3 distinct repliers, newest first) from a flat sequence of
// messages. The backend now writes these fields on every Send, but rooms
// with old data won't have them on the root — deriving from the loaded
// replies in the same page covers that case without a migration.
export function deriveThreadMeta(messages: Iterable<Message>): Map<string, ThreadMeta> {
  const meta = new Map<string, ThreadMeta>();
  for (const m of messages) {
    if (!m.parentMessageID) continue;
    const cur = meta.get(m.parentMessageID);
    const authors = cur ? cur.authors.filter((a) => a !== m.authorID) : [];
    authors.unshift(m.authorID);
    const lastReplyAt = !cur || m.createdAt > cur.lastReplyAt ? m.createdAt : cur.lastReplyAt;
    meta.set(m.parentMessageID, { lastReplyAt, authors: authors.slice(0, 3) });
  }
  return meta;
}
