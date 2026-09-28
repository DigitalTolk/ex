import { formatDayHeading } from '@/lib/format';
import { isOwnMessage } from '@/lib/message-users';
import type { Message } from '@/types';

// Pure rules behind the "New" divider, the unread banner and the new-messages
// pill. Message IDs are ULIDs, so comparing them as strings orders messages
// exactly like the list does — the server's read point (lastReadMsgID) is
// either a real message ID or an ID-space timestamp watermark, and both
// compare the same way.

// isCountedUnread: the messages that can be "new" to the viewer — the same
// set the server's unread seq counts (top-level, non-system), minus the
// viewer's own posts (sending reads the parent for you).
export function isCountedUnread(msg: Message, currentUserId: string | undefined): boolean {
  return !msg.parentMessageID && !msg.system && !isOwnMessage(msg, currentUserId);
}

// newestReadPointId is the message a mark-read should anchor to: the newest
// top-level, non-system message loaded (own posts included — they carry a
// seq too). System notices have no seq to anchor on, so they're skipped.
export function newestReadPointId(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m.parentMessageID && !m.system) return m.id;
  }
  return undefined;
}

export interface UnreadDividerInput {
  // Chronological (oldest first), as rendered.
  messages: Message[];
  currentUserId?: string;
  // The read point to place the divider after. Undefined when the server
  // row predates lastReadMsgID — then fallbackCount (the seq-derived unread
  // count) places it by counting back from the newest message.
  watermark?: string;
  fallbackCount: number;
  // Older pages exist that aren't loaded yet.
  hasOlderPages: boolean;
}

export interface UnreadDivider {
  // First unread message, when one is known.
  id?: string;
  // false = the first unread may be in an older, not-yet-loaded page, so
  // `id` is provisional and must not be frozen yet.
  certain: boolean;
}

export function findUnreadDivider({
  messages,
  currentUserId,
  watermark,
  fallbackCount,
  hasOlderPages,
}: UnreadDividerInput): UnreadDivider {
  const counted = messages.filter((m) => isCountedUnread(m, currentUserId));
  if (watermark !== undefined) {
    const first = counted.find((m) => m.id > watermark);
    if (!first) return { certain: true };
    // The loaded window reaches back to the read point iff some loaded
    // message sits at or before it — then nothing older can be unread.
    const reachesReadPoint = messages.length > 0 && messages[0].id <= watermark;
    return { id: first.id, certain: reachesReadPoint || !hasOlderPages };
  }
  if (fallbackCount <= 0) return { certain: true };
  if (counted.length >= fallbackCount) {
    return { id: counted[counted.length - fallbackCount].id, certain: true };
  }
  return { id: counted[0]?.id, certain: !hasOlderPages };
}

// countUnreadFrom counts the counted messages from the divider onward — the
// banner's "N new messages".
export function countUnreadFrom(messages: Message[], dividerId: string, currentUserId: string | undefined): number {
  let n = 0;
  for (const m of messages) {
    if (m.id >= dividerId && isCountedUnread(m, currentUserId)) n++;
  }
  return n;
}

// countUnreadAfter counts counted messages newer than the local read point —
// the pill's "N new messages" while scrolled up.
export function countUnreadAfter(messages: Message[], readPoint: string | undefined, currentUserId: string | undefined): number {
  if (readPoint === undefined) return 0;
  let n = 0;
  for (const m of messages) {
    if (m.id > readPoint && isCountedUnread(m, currentUserId)) n++;
  }
  return n;
}

// maxId returns the later of two optional message IDs.
export function maxId(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a > b ? a : b;
}

// sinceLabel: " since 3:07 PM" for today, " since Yesterday" / " since Mar 26th"
// for older — the day is the useful part once it isn't today. Empty when the
// first unread isn't loaded (pending).
export function sinceLabel(since: string | undefined, now: Date = new Date()): string {
  if (!since) return '';
  const heading = formatDayHeading(since, now);
  if (heading !== 'Today') return ` since ${heading}`;
  const time = new Date(since).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return ` since ${time}`;
}
