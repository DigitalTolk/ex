import { useEffect } from 'react';
import { deviceKind } from '@/lib/device';

// On touch devices (phones, and iPads at any width), dragging/scrolling
// anywhere outside the focused field dismisses the on-screen keyboard (the
// native iOS "scroll to dismiss" behaviour, which web views don't do on
// their own). A touch-move that
// stays inside the focused input is left alone so text selection /
// caret placement still works.
export function useDismissKeyboardOnScroll() {
  useEffect(() => {
    if (deviceKind() !== 'touch') return;
    const onTouchMove = (e: TouchEvent) => {
      // Nothing to dismiss while typing on a hardware keyboard (iPad shell
      // report, see useHardwareKeyboard): a finger scroll must keep the focus.
      if (window.__EX_HARDWARE_KEYBOARD__ === true) return;
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return;
      const editable =
        active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable;
      if (!editable) return;
      if (e.target instanceof Node && active.contains(e.target)) return;
      // CodeMirror portals its typeahead (@mention / :emoji:) to document.body,
      // so it is NOT contained by the focused editor — but scrolling that list
      // is part of typing, and blurring here dropped the keyboard AND closed
      // the popup (CM closes tooltips on blur) mid-autocomplete.
      if (e.target instanceof Element && e.target.closest('.cm-tooltip')) return;
      active.blur();
    };
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => document.removeEventListener('touchmove', onTouchMove);
  }, []);
}
