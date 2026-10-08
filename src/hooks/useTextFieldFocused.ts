import { useEffect, useState } from 'react';

// True while a text field has focus — on a phone, while the keyboard is up.
// The tab bar steps aside then so it doesn't sit between the composer and
// the keyboard.
export function useTextFieldFocused(): boolean {
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    const update = () => {
      const el = document.activeElement;
      setFocused(el instanceof HTMLElement && el.matches('input, textarea, select, [contenteditable="true"], [role="textbox"]'));
    };
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => {
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
    };
  }, []);
  return focused;
}
