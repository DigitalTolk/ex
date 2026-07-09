import { useEffect } from 'react';

const KEYBOARD_VAR = '--ex-keyboard-background';
const FIELD_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]';

// ex-mobile paints the strip between a focused field and the OS keyboard by
// probing `--ex-keyboard-background` from a fixed root location, NOT from the
// focused element. The per-surface CSS overrides (dialog, sidebar, popover
// sheet, …) only set the variable on those surfaces, so on their own they
// never reach the probe — the strip always showed the chat-background default.
//
// This hook closes that gap: whenever a text field gains focus it reads the
// surface-correct value the CSS overrides resolved on that field (the
// registered `<color>` custom property inherits, so getComputedStyle returns
// the concrete colour) and hoists it onto the document root. On blur it drops
// the override so the root default (chat background) applies again.
export function useKeyboardSurfaceColor() {
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => {
      const el = document.activeElement;
      if (el instanceof Element && el.matches(FIELD_SELECTOR)) {
        const color = getComputedStyle(el).getPropertyValue(KEYBOARD_VAR).trim();
        if (color) {
          root.style.setProperty(KEYBOARD_VAR, color);
          return;
        }
      }
      root.style.removeProperty(KEYBOARD_VAR);
    };
    document.addEventListener('focusin', sync);
    document.addEventListener('focusout', sync);
    return () => {
      document.removeEventListener('focusin', sync);
      document.removeEventListener('focusout', sync);
      root.style.removeProperty(KEYBOARD_VAR);
    };
  }, []);
}
