import { useTyping, formatTypingPhrase } from '@/context/TypingContext';
import type { UserMapEntry } from './MessageList';

interface Props {
  parentID?: string;
  userMap?: Record<string, UserMapEntry>;
}

// TypingIndicator is rendered as an overlay at the bottom of the message
// area so flipping its visibility doesn't push messages up/down. Owners
// place it inside a `relative` container that wraps MessageList; the
// indicator absolute-positions to the bottom-left of that wrapper.
export function TypingIndicator({ parentID, userMap }: Props) {
  const { typingByParent } = useTyping();
  if (!parentID) return null;
  const ids = typingByParent[parentID] ?? [];
  if (ids.length === 0) return null;
  const names = ids.map((id) => userMap?.[id]?.displayName ?? id);
  return (
    <div
      data-testid="typing-indicator"
      aria-live="polite"
      className="pointer-events-none absolute inset-x-0 bottom-0 px-4 pt-3 pb-1 text-xs italic text-muted-foreground bg-gradient-to-t from-background via-background/90 to-transparent"
    >
      {formatTypingPhrase(names)}
    </div>
  );
}
