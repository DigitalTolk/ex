import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

const HIGHLIGHT_CLASSES = ['ring-2', 'ring-amber-400', 'rounded-md'];
const HIGHLIGHT_MS = 2200;

// Watches the URL hash for the `#msg-{id}` form produced by the message
// "Copy link" action. When seen, scrolls the matching element into view
// and applies a brief highlight class.
export function useMessageDeepLinkHighlight(deps: unknown[]) {
  const { hash } = useLocation();

  useEffect(() => {
    if (!hash || !hash.startsWith('#msg-')) return;
    let timeout: number | undefined;
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(hash.slice(1));
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add(...HIGHLIGHT_CLASSES);
      timeout = window.setTimeout(() => {
        el.classList.remove(...HIGHLIGHT_CLASSES);
      }, HIGHLIGHT_MS);
    });
    return () => {
      cancelAnimationFrame(raf);
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, ...deps]);
}
