import { useTyping, formatTypingPhrase } from '@/context/TypingContext';
import type { UserMapEntry } from './MessageList';

interface Props {
  parentID?: string;
  // Optional userMap to resolve userIDs → display names. Falls back to
  // raw IDs when a name isn't in the map (loading state).
  userMap?: Record<string, UserMapEntry>;
}

export function TypingIndicator({ parentID, userMap }: Props) {
  const { typingByParent } = useTyping();
  if (!parentID) return null;
  const ids = typingByParent[parentID] ?? [];
  if (ids.length === 0) return null;
  const names = ids.map((id) => userMap?.[id]?.displayName ?? id);
  return (
    <p
      data-testid="typing-indicator"
      className="px-4 pb-1 text-xs italic text-muted-foreground"
      aria-live="polite"
    >
      {formatTypingPhrase(names)}
    </p>
  );
}
