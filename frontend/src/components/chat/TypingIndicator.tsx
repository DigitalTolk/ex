import { useTyping, formatTypingPhrase, threadTypingKey } from '@/context/TypingContext';
import type { UserMapEntry } from './MessageList';

interface Props {
  parentID?: string;
  userMap?: Record<string, UserMapEntry>;
}

// TypingIndicator renders inline between MessageList and MessageInput.
// It used to be absolute-positioned to "overlay" the bottom of the
// messages — but that anchored it to MessageDropZone's bottom (which
// extends past the input) and tucked it under the input. Owners now
// just drop it as a normal-flow sibling of MessageList; appearing /
// disappearing causes a tiny height shift, same as Slack/Discord do.
//
// This component renders ONLY main-list typing (typingByParent), so a
// reply being composed inside an open ThreadPanel does not show up
// down here in the channel view. Thread typing is rendered separately
// by ThreadTypingIndicator below.
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
      className="shrink-0 px-4 py-1 text-xs italic text-muted-foreground"
    >
      {formatTypingPhrase(names)}
    </div>
  );
}

interface ThreadProps {
  parentID?: string;
  threadRootID: string;
  userMap?: Record<string, UserMapEntry>;
}

// ThreadTypingIndicator renders typing happening inside a thread reply
// composer. It reads from typingByThread, keyed by (parentID, threadRootID),
// so unrelated thread typing or main-list typing never bleeds in.
export function ThreadTypingIndicator({ parentID, threadRootID, userMap }: ThreadProps) {
  const { typingByThread } = useTyping();
  if (!parentID || !threadRootID) return null;
  const ids = typingByThread[threadTypingKey(parentID, threadRootID)] ?? [];
  if (ids.length === 0) return null;
  const names = ids.map((id) => userMap?.[id]?.displayName ?? id);
  return (
    <div
      data-testid="thread-typing-indicator"
      aria-live="polite"
      className="shrink-0 px-4 py-1 text-xs italic text-muted-foreground"
    >
      {formatTypingPhrase(names)}
    </div>
  );
}
