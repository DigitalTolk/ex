import { useRef, type PointerEvent } from 'react';

const MIN_SWIPE_X = 72;
const MAX_SWIPE_Y = 48;

type SwipeDirection = 'right' | 'left';

export function useMobileSwipe(
  direction: SwipeDirection,
  onSwipe: () => void,
) {
  const startRef = useRef<{ x: number; y: number } | null>(null);

  function onPointerDown(event: PointerEvent<HTMLElement>) {
    if (event.pointerType === 'mouse') return;
    startRef.current = { x: event.clientX, y: event.clientY };
  }

  function onPointerUp(event: PointerEvent<HTMLElement>) {
    const start = startRef.current;
    startRef.current = null;
    if (!start || event.pointerType === 'mouse') return;
    const dx = event.clientX - start.x;
    const dy = Math.abs(event.clientY - start.y);
    if (dy > MAX_SWIPE_Y) return;
    if (direction === 'right' && dx >= MIN_SWIPE_X) onSwipe();
    if (direction === 'left' && dx <= -MIN_SWIPE_X) onSwipe();
  }

  function onPointerCancel() {
    startRef.current = null;
  }

  return {
    onPointerDown,
    onPointerUp,
    onPointerCancel,
  };
}
