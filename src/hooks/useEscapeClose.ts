import { useEffect } from 'react';
import { useLatestRef } from '@/hooks/useLatestRef';
import { isTextField } from '@/lib/keyboard';

// useEscapeClose closes a right-hand panel (thread, members, pinned, files,
// tags) on Escape — once everything above it has had the key. A layer that
// closes on Escape marks the event handled (preventDefault): Base UI menus,
// dialogs and tooltips do, and so do the app's own popovers, pickers, the
// lightbox and the drawers. Listening on the window, last in the bubbling
// order, the panel only acts on an Escape nobody took. A text field keeps the
// first Escape — it lets go of the field — and the next one closes the panel.
// Without an onClose (a panel rendered with nothing to close it) the key is
// left alone.
export function useEscapeClose(onClose: (() => void) | undefined): void {
  const onCloseRef = useLatestRef(onClose);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const close = onCloseRef.current;
      if (!close || event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      const active = document.activeElement;
      if (isTextField(active)) {
        (active as HTMLElement).blur();
        return;
      }
      close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCloseRef]);
}
