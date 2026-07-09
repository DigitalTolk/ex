import { dayKey } from '@/lib/format';
import type { Message } from '@/types';

export type MessageListRow =
  | { kind: 'day'; key: string; date: string }
  | { kind: 'message'; key: string; message: Message; firstInGroup: boolean };

// Consecutive messages from the same author within this window collapse
// into one visual group (Slack/Mattermost use ~5 minutes): only the first
// shows the avatar + name + timestamp header, the rest render compact.
const GROUP_WINDOW_MS = 5 * 60 * 1000;

// isGroupedWithPrevious reports whether `msg` should render as a compact
// continuation of `prev` (same author, close in time) rather than starting
// a fresh group with its own avatar/name/timestamp header. System messages
// never group (they render as standalone centered notices), and distinct
// webhook identities under the shared bot author are kept separate.
export function isGroupedWithPrevious(prev: Message | null | undefined, msg: Message): boolean {
  if (!prev || prev.system || msg.system) return false;
  if (prev.authorID !== msg.authorID) return false;
  if ((prev.webhookUsername ?? '') !== (msg.webhookUsername ?? '')) return false;
  const gap = new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime();
  return gap >= 0 && gap <= GROUP_WINDOW_MS;
}

// Build the flat row list with day dividers, in chronological order.
// Thread replies belong to ThreadPanel; they are skipped here. Lives
// in its own module (rather than inside MessageList.tsx) so it stays
// testable without spinning up Virtuoso — and so the file containing
// the React component only exports components, satisfying React Fast
// Refresh's contract.
//
// Each message row carries `firstInGroup`: false marks a compact
// continuation of the message above it. A day divider always resets
// grouping so the first message under a new day shows its full header.
export function buildMessageListRows(allMessages: Message[]): MessageListRow[] {
  const out: MessageListRow[] = [];
  let lastDate = '';
  let prev: Message | null = null;
  for (const msg of allMessages) {
    if (msg.parentMessageID) continue;
    const d = dayKey(msg.createdAt);
    if (d !== lastDate) {
      lastDate = d;
      out.push({ kind: 'day', key: `day-${d}`, date: msg.createdAt });
      prev = null;
    }
    out.push({ kind: 'message', key: msg.id, message: msg, firstInGroup: !isGroupedWithPrevious(prev, msg) });
    prev = msg;
  }
  return out;
}

// Compute the next Virtuoso state after `rows` updates. Models
// Virtuoso's prepend-items contract: when more items appear at the
// front of the data array, `firstItemIndex` must shift down by the
// prepend count IN THE SAME RENDER. Pulled out as a pure function
// so the transition logic is testable without rendering Virtuoso
// (which jsdom can't lay out).
//
// Detection compares the first MESSAGE id (not first row key) — a
// day divider is stable for the calendar day, so prepending older
// messages on the same day leaves the first row unchanged. The
// first message id changes whenever a prepend lands at least one
// older message, regardless of whether a new divider was inserted.
export interface VirtuosoStateTransition {
  rows: MessageListRow[];
  firstItemIndex: number;
}
function firstMessageId(rows: MessageListRow[]): string | undefined {
  for (const r of rows) {
    if (r.kind === 'message') return r.message.id;
  }
  return undefined;
}
export function nextVirtuosoState(
  prev: VirtuosoStateTransition,
  rows: MessageListRow[],
): VirtuosoStateTransition {
  if (rows === prev.rows) return prev;
  const prevLen = prev.rows.length;
  const newLen = rows.length;
  if (prevLen === 0 || newLen <= prevLen) {
    return { rows, firstItemIndex: prev.firstItemIndex };
  }
  const prevFirstMsg = firstMessageId(prev.rows);
  const newFirstMsg = firstMessageId(rows);
  if (prevFirstMsg === newFirstMsg) {
    // Append-only update: the first message hasn't changed, so the
    // new rows are at the END of the list.
    return { rows, firstItemIndex: prev.firstItemIndex };
  }
  // Prepend: the first message changed AND the list grew.
  return {
    rows,
    firstItemIndex: prev.firstItemIndex - (newLen - prevLen),
  };
}
