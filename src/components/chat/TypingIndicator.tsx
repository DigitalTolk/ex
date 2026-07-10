import { formatTypingPhrase } from '@/context/TypingContext';
import { useThreadTypingFor, useTypingFor } from '@/stores/typing';
import type { UserMapEntry } from './MessageList';

interface Props {
  parentID?: string;
  userMap?: Record<string, UserMapEntry>;
}

// TypingIndicator is passed to MessageInput's `aboveInput` slot, which
// renders it as an OVERLAY (absolute, `bottom-full`) floating in the free
// space just above the composer — not in normal flow. That means showing /
// hiding the "<user> is typing" line never pushes the input box or changes
// the composer's height; it just occupies the gap that's already there
// between the last message and the composer. (It used to be an absolute
// overlay anchored to the wrong ancestor — MessageDropZone's bottom, below
// the input — then a normal-flow sibling that reflowed on show/hide; this is
// the overlay done right, anchored to the composer wrapper.)
//
// This component renders ONLY main-list typing (useTypingFor), so a
// reply being composed inside an open ThreadPanel does not show up
// down here in the channel view. Thread typing is rendered separately
// by ThreadTypingIndicator below. Both subscribe per-bucket via the
// typing store, so typing anywhere else in the workspace does not
// re-render this composer overlay.
export function TypingIndicator({ parentID, userMap }: Props) {
  const ids = useTypingFor(parentID ?? '');
  if (!parentID || ids.length === 0) return null;
  const names = ids.map((id) => userMap?.[id]?.displayName ?? id);
  return (
    <div
      data-testid="typing-indicator"
      aria-live="polite"
      className="shrink-0 px-3 pb-0.5 text-xs italic text-muted-foreground"
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
// composer. It reads the (parentID, threadRootID) bucket, so unrelated
// thread typing or main-list typing never bleeds in.
export function ThreadTypingIndicator({ parentID, threadRootID, userMap }: ThreadProps) {
  const ids = useThreadTypingFor(parentID ?? '', threadRootID);
  if (!parentID || !threadRootID || ids.length === 0) return null;
  const names = ids.map((id) => userMap?.[id]?.displayName ?? id);
  return (
    <div
      data-testid="thread-typing-indicator"
      aria-live="polite"
      className="shrink-0 px-3 pb-0.5 text-xs italic text-muted-foreground"
    >
      {formatTypingPhrase(names)}
    </div>
  );
}
