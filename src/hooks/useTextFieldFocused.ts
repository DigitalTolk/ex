import { useEffect, useState } from 'react';
import { isTextField } from '@/lib/keyboard';

// True while a text field has focus — on a phone, while the keyboard is up.
// The tab bar steps aside then so it doesn't sit between the composer and
// the keyboard. Only listens while enabled (the phone tier), so focus moves
// on a desktop don't re-render the layout.
export function useTextFieldFocused(enabled = true): boolean {
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const update = () => setFocused(isTextField(document.activeElement));
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => {
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
    };
  }, [enabled]);
  return enabled && focused;
}
