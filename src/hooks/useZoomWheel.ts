import { useCallback } from 'react';
import { useEventCallback } from '@/hooks/useEventCallback';

// useZoomWheel turns Ctrl/⌘ + wheel over an element — and a trackpad pinch,
// which browsers report as Ctrl + wheel — into a zoom of that element instead
// of the whole app. React registers its wheel listeners as passive, so an
// onWheel prop can't stop the browser's own zoom; this listener can. Returns
// the ref to put on the element.
export function useZoomWheel(onZoomWheel: (event: WheelEvent) => void) {
  const handle = useEventCallback(onZoomWheel);
  return useCallback(
    (el: HTMLElement | null) => {
      if (!el) return;
      const onWheel = (event: WheelEvent) => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        handle(event);
      };
      el.addEventListener('wheel', onWheel, { passive: false });
      return () => el.removeEventListener('wheel', onWheel);
    },
    [handle],
  );
}
