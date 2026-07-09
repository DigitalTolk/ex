import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { inAppRouteTarget } from '@/lib/in-app-link';

// Delegated click handler: same-origin permalinks (rendered as
// `target="_blank"` anchors in message markdown, unfurl cards, rich
// attachments, etc.) navigate via the SPA router instead of opening a new tab
// / leaving the Electron desktop wrapper. The handler runs before the browser
// performs the anchor's default action, so preventDefault() cancels the
// new-tab open and the route change happens in place — the #msg-… fragment is
// preserved and the existing deep-link machinery scrolls to it.
//
// Left untouched (default behaviour preserved):
//   - external-origin links (open in a new tab with their existing rel)
//   - modified / non-primary clicks (Cmd/Ctrl/Shift/Alt, middle-click) so
//     "open in new tab" still works for users who explicitly ask for it
//   - `download` links
export function InAppLinkRouter() {
  const navigate = useNavigate();
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      const anchor = (e.target as Element | null)?.closest?.('a');
      if (!anchor || anchor.hasAttribute('download') || !anchor.getAttribute('href')) return;
      // `anchor.href` is the fully-resolved absolute URL (relative/hash hrefs
      // resolved against the current page), so the origin check is reliable.
      const target = inAppRouteTarget(anchor.href, window.location.origin);
      if (target == null) return; // external / backend route → leave the default
      e.preventDefault();
      navigate(target);
    }
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [navigate]);
  return null;
}
