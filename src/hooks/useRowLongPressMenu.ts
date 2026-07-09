import { useState } from 'react';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useLongPress } from '@/hooks/useLongPress';

// The mobile sidebar-row menu wiring shared by ChannelRow and
// ConversationRow: rows hide their kebab on touch (pointer-events-none +
// opacity-0), so a long-press opens the controlled dropdown instead, and
// the click a touch release fires right after must not navigate the row.
// Keeping the state + gesture + click-suppression in ONE hook keeps the
// two row types behaviorally identical — this wiring used to live as
// copy-paste in each row and drifting was a matter of time.
export function useRowLongPressMenu() {
  const isMobile = useIsMobile();
  const [menuOpen, setMenuOpen] = useState(false);
  const { handlers, shouldSuppressClick } = useLongPress({
    enabled: isMobile,
    onLongPress: () => setMenuOpen(true),
  });
  return {
    menuOpen,
    setMenuOpen,
    // Spread onto the row wrapper so a touch hold anywhere on it opens the menu.
    rowHandlers: handlers,
    // One-shot: read in the row link's onClick; true → preventDefault +
    // stopPropagation and skip navigation (the long-press already opened the menu).
    suppressNavClick: shouldSuppressClick,
  };
}
