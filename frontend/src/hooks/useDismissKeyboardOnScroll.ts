import { useEffect } from 'react';
import { useIsMobile } from './useIsMobile';

// On mobile, dragging/scrolling anywhere outside the focused field
// dismisses the on-screen keyboard (the native iOS "scroll to dismiss"
// behaviour, which web views don't do on their own). A touch-move that
// stays inside the focused input is left alone so text selection /
// caret placement still works.
export function useDismissKeyboardOnScroll() {
  const isMobile = useIsMobile();
  useEffect(() => {
    if (!isMobile) return;
    const onTouchMove = (e: TouchEvent) => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return;
      const editable =
        active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable;
      if (!editable) return;
      if (e.target instanceof Node && active.contains(e.target)) return;
      active.blur();
    };
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => document.removeEventListener('touchmove', onTouchMove);
  }, [isMobile]);
}
