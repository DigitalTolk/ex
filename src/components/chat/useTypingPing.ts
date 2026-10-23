import { useCallback, useRef } from 'react';
import { sendWS } from '@/lib/ws-sender';

const TYPING_PING_INTERVAL_MS = 3000;

// useTypingPing returns the composer's throttled "typing" emit. Other clients
// show "<user> is typing" for 5s after the most recent ping; we re-ping every
// 3s while the user is still composing. We deliberately don't ping on every
// keystroke — that would flood the WebSocket on long messages. Without a
// parent (the inline edit box) nothing is sent: typing while editing an
// existing message is private.
export function useTypingPing(
  parentID: string | undefined,
  parentType: 'channel' | 'conversation' | undefined,
  threadRootID: string | undefined,
) {
  const lastTypingPingRef = useRef(0);
  return useCallback(() => {
    if (!parentID || !parentType) return;
    const now = Date.now();
    if (now - lastTypingPingRef.current < TYPING_PING_INTERVAL_MS) return;
    lastTypingPingRef.current = now;
    const frame: Record<string, string> = {
      type: 'typing',
      parentID,
      parentType,
    };
    if (threadRootID) frame.parentMessageID = threadRootID;
    sendWS(frame);
  }, [parentID, parentType, threadRootID]);
}
