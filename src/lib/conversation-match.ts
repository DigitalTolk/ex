import type { UserConversation } from '@/types';

// Finding the group messages and DMs you already have with some people.

const words = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);

const people = (c: UserConversation) => c.participantIDs ?? [];

// The most specific first: the fewest people, then the most recent.
function bySize(a: UserConversation, b: UserConversation): number {
  return people(a).length - people(b).length || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
}

// groupsMatching: group messages whose people's names take in every word of
// the query ("ali bob" finds the group with Alice and Bob), each word the
// start of a name.
export function groupsMatching(conversations: UserConversation[], query: string, limit = 5): UserConversation[] {
  const wanted = words(query);
  if (wanted.length === 0) return [];
  return conversations
    .filter((c) => c.type === 'group')
    .filter((c) => {
      const names = words(c.displayName);
      return wanted.every((w) => names.some((n) => n.startsWith(w)));
    })
    .sort(bySize)
    .slice(0, limit);
}

export interface ConversationMatch {
  conversation: UserConversation;
  // Exactly these people (and you): where a new message to them goes.
  exact: boolean;
}

// conversationsWith: the DMs and group messages that include every one of
// `peopleIDs`, the one with exactly them first.
export function conversationsWith(
  conversations: UserConversation[],
  peopleIDs: string[],
  meID: string | undefined,
): ConversationMatch[] {
  if (peopleIDs.length === 0) return [];
  const exactSize = new Set([...peopleIDs, ...(meID ? [meID] : [])]).size;
  return conversations
    .filter((c) => peopleIDs.every((id) => people(c).includes(id)))
    .map((c) => ({ conversation: c, exact: new Set(people(c)).size === exactSize }))
    .sort((a, b) => Number(b.exact) - Number(a.exact) || bySize(a.conversation, b.conversation));
}
