import { useMemo } from 'react';
import { collectMessageUserIDs } from '@/lib/message-users';
import type { Message } from '@/types';

// The user ids a page of loaded messages names (authors, thread repliers,
// reactors), remembered per page. Every cache patch (an arrival, an edit, a
// reaction) replaces the items array of the page it touches and keeps the
// others, so on each event only that page is walked again — not every message
// and reaction of every loaded page, as the views used to.
const pageUserIDs = new WeakMap<readonly Message[], readonly string[]>();

function idsOfPage(items: readonly Message[]): readonly string[] {
  let ids = pageUserIDs.get(items);
  if (!ids) {
    ids = collectMessageUserIDs(items);
    pageUserIDs.set(items, ids);
  }
  return ids;
}

// useMessagePageUserIDs: everyone the loaded pages name, plus `extra` (the
// channel's members, a conversation's participants).
export function useMessagePageUserIDs(
  pages: readonly { items: Message[] }[] | undefined,
  extra: readonly string[] | undefined,
): string[] {
  return useMemo(() => {
    const ids = new Set(extra);
    for (const page of pages ?? []) {
      for (const id of idsOfPage(page.items)) ids.add(id);
    }
    return Array.from(ids);
  }, [pages, extra]);
}
