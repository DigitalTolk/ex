import { useSyncExternalStore } from 'react';
import { useIsMobile } from './useIsMobile';

// The ex-mobile iOS shell reports whether typing currently comes from a
// hardware keyboard (iPad Magic Keyboard / keyboard folio / Bluetooth) or the
// on-screen keyboard: it keeps window.__EX_HARDWARE_KEYBOARD__ current and
// fires this event on every change.
export const HARDWARE_KEYBOARD_EVENT = 'ex-mobile:hardware-keyboard';

function subscribe(onChange: () => void) {
  window.addEventListener(HARDWARE_KEYBOARD_EVENT, onChange);
  return () => window.removeEventListener(HARDWARE_KEYBOARD_EVENT, onChange);
}

function getSnapshot(): boolean | null {
  return window.__EX_HARDWARE_KEYBOARD__ ?? null;
}

// null = no native report (browsers, the desktop shell, older app builds), so
// callers keep their own width/device default.
export function useHardwareKeyboard(): boolean | null {
  return useSyncExternalStore(subscribe, getSnapshot);
}

// Composer Enter: a hardware keyboard gets desktop semantics (Enter sends,
// Shift+Enter breaks the line) at any width; the on-screen keyboard's return
// key always breaks the line, even on a wide iPad where the layout is the
// desktop one. Without a native report, phones break the line and everything
// else sends.
export function useSubmitOnEnter(): boolean {
  const isMobile = useIsMobile();
  const hardwareKeyboard = useHardwareKeyboard();
  return hardwareKeyboard ?? !isMobile;
}

// Whether a view that just opened (channel composer, picker search, dialog
// field) should focus its text input by itself. Never on phones: the keyboard
// would pop over what just opened. The iPad app keeps the desktop layout but
// follows the keyboard in use: no autofocus while typing would go through the
// on-screen keyboard.
export function useAutoFocusTextInput(): boolean {
  const isMobile = useIsMobile();
  const hardwareKeyboard = useHardwareKeyboard();
  return !isMobile && hardwareKeyboard !== false;
}
