import { useEffect, useRef } from 'react';

// useLatestRef mirrors a value into a ref, kept in sync after every
// render. Useful inside long-lived callbacks (IntersectionObserver,
// WebSocket message handlers) that need to read the latest props/state
// without being recreated when those props/state change.
export function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}
