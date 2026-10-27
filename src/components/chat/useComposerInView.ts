import { useEffect, type RefObject } from 'react';
import { keepInView } from '@/lib/keep-in-view';

// useComposerInView keeps the whole phone composer in view while it has focus,
// when it sits in a scroller of its own (a reply box on /threads). Tapping it
// brought only the line being typed on above the keyboard, and the formatting
// toolbar then grew open below that line, under the keyboard.
export function useComposerInView(rootRef: RefObject<HTMLElement | null>, focused: boolean) {
  useEffect(() => {
    if (!focused) return;
    return keepInView(rootRef.current!);
  }, [focused, rootRef]);
}
