import { useEffect, type RefObject } from 'react';

let lockDepth = 0;
let previousOverflow = '';

function lockDocumentScroll() {
  if (typeof document === 'undefined') return;
  if (lockDepth === 0) {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  lockDepth += 1;
}

function unlockDocumentScroll() {
  if (typeof document === 'undefined') return;
  lockDepth = Math.max(0, lockDepth - 1);
  if (lockDepth > 0) return;
  document.body.style.overflow = previousOverflow;
}

function cleanupFocus(root: HTMLElement | null | undefined) {
  if (typeof document === 'undefined') return;
  const active = document.activeElement;
  if (active instanceof HTMLElement && (!root || root.contains(active))) {
    active.blur();
  }
  document.getSelection()?.removeAllRanges();
}

export function useTransientOverlayCleanup(
  open: boolean,
  {
    rootRef,
    lockScroll = false,
  }: {
    rootRef?: RefObject<HTMLElement | null>;
    lockScroll?: boolean;
  } = {},
) {
  useEffect(() => {
    if (!open) return;
    const root = rootRef?.current;
    if (lockScroll) lockDocumentScroll();
    return () => {
      cleanupFocus(root);
      if (lockScroll) unlockDocumentScroll();
    };
  }, [lockScroll, open, rootRef]);
}
