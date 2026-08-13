// The read/bump decision for an arriving top-level message, extracted from
// ChatPage's WS switchboard so the rule is a pure, table-testable function
// instead of nested conditionals inside an event handler. This is the rule
// that produced the ghost-DM bug (an open route auto-marking messages read
// while nobody was looking) — it earns its own module and its own tests.
//
// The authoritative behaviour spec is CLAUDE.md's user-perspective truth
// table; message-arrival.test.ts mirrors it row by row.

export type ParentKind = 'channel' | 'conversation' | null;

// resolveParentKind decides which list a message's parent belongs to. The
// payload's own parentType always wins; a legacy payload without one falls
// back to the caches, channel first. Neither cache knowing the parent means
// we must NOT guess (bumping a badge on the wrong list is worse than doing
// nothing — the durable server count still self-heals on the next fetch).
export function resolveParentKind(
  parentType: string | undefined,
  cachedChannel: boolean,
  cachedConversation: boolean,
): ParentKind {
  if (parentType === 'channel') return 'channel';
  if (parentType === 'conversation') return 'conversation';
  if (cachedChannel) return 'channel';
  if (cachedConversation) return 'conversation';
  return null;
}

export type ArrivalAction = 'mark-read' | 'bump-unread' | 'ignore';

export interface ArrivalContext {
  // The recipient authored it (webhook posts are NOT "own" — the bot wrote
  // them; isOwnMessage() resolves that before this is called).
  isOwnAuthor: boolean;
  // A reply into a thread — thread unread is owned by the Threads nav, never
  // by the parent's badge.
  isThreadReply: boolean;
  // A system event (join/leave) — not "new activity".
  isSystem: boolean;
  // The parent's route is open in this tab.
  viewingParent: boolean;
  // The user is demonstrably LOOKING at the page: visible + focused + fresh
  // input (the suppression tier). An open route alone is never enough —
  // marking read without this was the ghost-DM bug.
  attentive: boolean;
}

// classifyParentArrival: what an arriving top-level message does to its
// parent's unread state.
//   mark-read   — the user is watching it happen: persist the read.
//   bump-unread — real new activity the user hasn't seen: badge it.
//   ignore      — not parent-level activity at all.
export function classifyParentArrival(ctx: ArrivalContext): ArrivalAction {
  if (ctx.isOwnAuthor || ctx.isThreadReply || ctx.isSystem) return 'ignore';
  return ctx.viewingParent && ctx.attentive ? 'mark-read' : 'bump-unread';
}
