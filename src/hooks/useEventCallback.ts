import { useCallback, useLayoutEffect, useRef } from 'react';

// useEventCallback returns a function whose identity never changes but which
// always runs the latest `fn`. For event handlers handed to memoized children
// (a composer's Send, a picker's onSelect) that read state changing on every
// keystroke: a plain useCallback over that state is a new function per
// keystroke and re-renders every child it is passed to.
//
// Only for handlers called after render (events, timers) — never call the
// result during render: it runs the `fn` of the last COMMITTED render.
export function useEventCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}
