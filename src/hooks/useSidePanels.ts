import { useState, useCallback, useMemo } from 'react';

// Mutually-exclusive side panels (pinned, files, members, thread, …).
// Returns the active panel id (or null) plus stable open/close/toggle
// callbacks. ChannelView and ConversationView used to hand-roll this
// with one boolean per panel — opening any one had to remember to flip
// off every other, and adding a new panel meant editing every callback.
export function useSidePanels<P extends string>() {
  const [active, setActive] = useState<P | null>(null);

  const open = useCallback((panel: P) => setActive(panel), []);
  const close = useCallback(() => setActive(null), []);
  const toggle = useCallback(
    (panel: P) => setActive((cur) => (cur === panel ? null : panel)),
    [],
  );

  return useMemo(
    () => ({
      active,
      open,
      close,
      toggle,
      isActive: (panel: P) => active === panel,
    }),
    [active, open, close, toggle],
  );
}
