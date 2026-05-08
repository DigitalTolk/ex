import { useCallback, useEffect, useRef, useState } from 'react';
import { useSwipeable } from 'react-swipeable';

export const SWIPE_DISMISS_MS = 180;
const MIN_SWIPE = 72;
const MAX_CROSS_AXIS = 48;
const RIGHT_DISMISS_EDGE_PX = 32;

export function useAnimatedSwipeDismiss(direction: 'right' | 'down', onDismiss: () => void) {
  const [dismissing, setDismissing] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const timeoutRef = useRef<number | null>(null);

  const dismissWithAnimation = useCallback(() => {
    if (timeoutRef.current !== null) return;
    setDismissing(true);
    setDragOffset(0);
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      onDismiss();
      setDismissing(false);
    }, SWIPE_DISMISS_MS);
  }, [onDismiss]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    };
  }, []);

  const swipeHandlers = useSwipeable({
    delta: 4,
    trackMouse: false,
    preventScrollOnSwipe: direction === 'down',
    onSwiping: ({ absX, absY, deltaX, deltaY, initial }) => {
      if (timeoutRef.current !== null) return;
      if (direction === 'right') {
        if (initial[0] > RIGHT_DISMISS_EDGE_PX || deltaX <= 0 || absY > MAX_CROSS_AXIS) {
          setDragOffset(0);
          return;
        }
        setDragOffset(deltaX);
        return;
      }
      if (deltaY <= 0 || absX > MAX_CROSS_AXIS) {
        setDragOffset(0);
        return;
      }
      setDragOffset(deltaY);
    },
    onSwipedRight: ({ absY, deltaX, initial }) => {
      if (direction === 'right' && initial[0] <= RIGHT_DISMISS_EDGE_PX && deltaX >= MIN_SWIPE && absY <= MAX_CROSS_AXIS) {
        dismissWithAnimation();
      } else {
        setDragOffset(0);
      }
    },
    onSwipedDown: ({ absX, deltaY }) => {
      if (direction === 'down' && deltaY >= MIN_SWIPE && absX <= MAX_CROSS_AXIS) {
        dismissWithAnimation();
      } else {
        setDragOffset(0);
      }
    },
    onSwiped: () => {
      if (timeoutRef.current === null) setDragOffset(0);
    },
  });

  const axis = direction === 'right' ? 'X' : 'Y';
  const dragStyle = dragOffset > 0 && !dismissing
    ? { transform: `translate${axis}(${Math.round(dragOffset)}px)`, transition: 'none' }
    : undefined;

  return {
    dismissing,
    dragOffset,
    dragStyle,
    swipeHandlers,
  };
}
