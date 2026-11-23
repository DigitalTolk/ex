import { useMemo } from 'react';
import { useAllUsers, useUserConversations } from '@/hooks/useConversations';
import { useUserChannels } from '@/hooks/useChannels';
import { dateRange, parseSearchModifiers, resolveFromPerson, resolveInPlace, type DateModifier } from '@/lib/search-modifiers';

export interface SearchModifiers {
  // The words to search for, without the modifiers.
  text: string;
  // The person (user ID) from: names and the chat (parent ID) in: names.
  fromID?: string;
  inID?: string;
  // The span on:/before:/after: leave, as instants (ISO).
  after?: string;
  before?: string;
  // The date modifiers as typed, for the page's chips.
  dates: { key: DateModifier; value: string }[];
  // A modifier waiting on the people or chats it names to load.
  pending: boolean;
  // A modifier that names no one or nothing ("from:nobody"), as typed.
  unmatched?: string;
}

// useSearchModifiers reads a typed search ("datadog from:Günter in:~ops on:today")
// into its words and the filters its modifiers name (see search-modifiers).
// The people and chat lists it resolves against are ones the app already
// keeps; nothing is fetched for a search without modifiers.
export function useSearchModifiers(q: string): SearchModifiers {
  const parsed = useMemo(() => parseSearchModifiers(q), [q]);
  const { data: people, isLoading: peopleLoading } = useAllUsers();
  const { data: channels, isLoading: channelsLoading } = useUserChannels();
  const { data: conversations, isLoading: conversationsLoading } = useUserConversations();
  return useMemo(() => {
    const dates = (['on', 'after', 'before'] as const)
      .filter((key) => parsed[key] !== undefined)
      .map((key) => ({ key, value: parsed[key]! }));
    const out: SearchModifiers = { text: parsed.text, pending: false, dates };
    if (parsed.from !== undefined) {
      if (peopleLoading) out.pending = true;
      else {
        const person = resolveFromPerson(parsed.from, people ?? []);
        if (person) out.fromID = person.id;
        else out.unmatched = `from:${parsed.from}`;
      }
    }
    if (parsed.in !== undefined) {
      if (channelsLoading || conversationsLoading) out.pending = true;
      else {
        const places = [
          ...(channels ?? []).map((c) => ({ id: c.channelID, name: c.channelName })),
          ...(conversations ?? []).map((c) => ({ id: c.conversationID, name: c.displayName })),
        ];
        const place = resolveInPlace(parsed.in, places);
        if (place) out.inID = place.id;
        else out.unmatched ??= `in:${parsed.in}`;
      }
    }
    // Days are the reader's own: today's start is midnight here, and the
    // instants only change when the day does, so the search stays cached.
    const range = dateRange(parsed);
    if (range.after) out.after = range.after.toISOString();
    if (range.before) out.before = range.before.toISOString();
    if (range.invalid) out.unmatched ??= range.invalid;
    return out;
  }, [parsed, people, peopleLoading, channels, channelsLoading, conversations, conversationsLoading]);
}
