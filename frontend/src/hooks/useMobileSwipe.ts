import { useSwipeable, type SwipeEventData } from 'react-swipeable';

const MIN_SWIPE_X = 72;
const MAX_SWIPE_Y = 48;
const MIN_SWIPE_Y = 72;
const MAX_SWIPE_X = 48;

type SwipeDirection = 'right' | 'left' | 'down';

export function useMobileSwipe(
  direction: SwipeDirection,
  onSwipe: (eventData: SwipeEventData) => void,
) {
  return useSwipeable({
    delta: MIN_SWIPE_X,
    trackMouse: false,
    preventScrollOnSwipe: false,
    onSwipedLeft: (eventData) => {
      if (direction === 'left' && eventData.absY <= MAX_SWIPE_Y) onSwipe(eventData);
    },
    onSwipedRight: (eventData) => {
      if (direction === 'right' && eventData.absY <= MAX_SWIPE_Y) onSwipe(eventData);
    },
    onSwipedDown: (eventData) => {
      if (direction === 'down' && eventData.absY >= MIN_SWIPE_Y && eventData.absX <= MAX_SWIPE_X) onSwipe(eventData);
    },
  });
}
