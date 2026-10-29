import { useEffect, useRef } from 'react';
import { onReturnFromIdle } from '@/lib/user-activity';

// How the user came back: the window came forward ('window'), or they touched
// a window that had stayed in front through an idle spell ('input').
export type ReturnKind = 'window' | 'input';

// The other half of the attention-gated read model (see ChatPage's
// message.new handler): while a parent's route (or a thread) is open but the user is NOT
// looking (window blurred / tab hidden / idle), arriving messages bump the
// unread badge instead of being auto-marked read. This hook completes the
// loop: the moment the user demonstrably RETURNS to the page — the window
// regains OS focus, the tab becomes visible while focused, or their first
// input after an idle spell lands in the focused window — the open parent is
// marked read again (Slack semantics: focusing the app reads the channel
// you're on).
//
// Focus is sufficient evidence HERE, unlike for the activity clock (R1):
// marking the on-screen conversation read when its window comes forward is
// exactly what the user expects, and the alert itself was already delivered
// (popup while away, mobile fallback if truly gone) — read-marking never
// races the delivery contract.
export function useMarkReadOnReturn(id: string | undefined, markRead: (id: string, how: ReturnKind) => void): void {
  // The latest callback, so one that reads render state (a thread's newest
  // reply) never acts on what it saw when the listener was attached.
  const markReadRef = useRef(markRead);
  useEffect(() => {
    markReadRef.current = markRead;
  });
  useEffect(() => {
    if (!id) return;
    const openedID = id;
    function onReturn(how: ReturnKind): void {
      if (document.visibilityState !== 'visible') return;
      if (typeof document.hasFocus === 'function' && !document.hasFocus()) return;
      markReadRef.current(openedID, how);
    }
    const onWindowReturn = () => onReturn('window');
    window.addEventListener('focus', onWindowReturn);
    document.addEventListener('visibilitychange', onWindowReturn);
    const stopInputReturn = onReturnFromIdle(() => onReturn('input'));
    return () => {
      window.removeEventListener('focus', onWindowReturn);
      document.removeEventListener('visibilitychange', onWindowReturn);
      stopInputReturn();
    };
  }, [id]);
}
