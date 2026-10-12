import { createContext, useContext, useMemo } from 'react';
import { useEmojiMap } from '@/hooks/useEmoji';
import { useParentWatchers, useSkills, type AgentSubscription } from '@/hooks/useAgents';
import { useConnectors } from '@/hooks/useConnectors';
import { skillPickToken } from '@/lib/picks';

// What every message row needs but none should fetch for itself: the custom
// emoji map, the viewer's watchers on the parent, and the known /pick tokens.
// Each row used to subscribe to these four queries on its own — 90 mounted
// rows meant 360 query observers re-evaluated on every refetch. A list (or a
// thread panel, pinned panel, thread card) subscribes once via
// MessageRowDataProvider and rows read the result from context.
export interface MessageRowData {
  emojiMap: Record<string, string> | undefined;
  watchers: AgentSubscription[] | undefined;
  pickTokens: ReadonlySet<string>;
}

export const MessageRowDataContext = createContext<MessageRowData | null>(null);

export function useMessageRowData(
  parentType: 'channel' | 'conversation',
  parentID: string | undefined,
): MessageRowData {
  const { data: emojiMap } = useEmojiMap();
  const { data: watchers } = useParentWatchers(parentType, parentID);
  const { data: allConnectors } = useConnectors();
  const { data: allSkills } = useSkills();
  const pickTokens = useMemo(() => {
    const t = new Set<string>();
    for (const c of allConnectors ?? []) if (c.installed) t.add(c.slug);
    for (const sk of allSkills ?? []) {
      const tok = skillPickToken(sk.name);
      if (tok) t.add(tok);
    }
    return t;
  }, [allConnectors, allSkills]);
  return useMemo(() => ({ emojiMap, watchers, pickTokens }), [emojiMap, watchers, pickTokens]);
}

// null outside a provider: MessageItem then fetches for itself (standalone
// renders, e.g. tests).
export function useProvidedMessageRowData(): MessageRowData | null {
  return useContext(MessageRowDataContext);
}
