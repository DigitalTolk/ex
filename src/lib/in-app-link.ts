// Decision logic for the delegated same-origin link router (see
// components/InAppLinkRouter). Kept as a pure function so the same-origin vs.
// external decision is unit-testable in isolation.

// inAppRouteTarget returns the SPA path (path + search + hash) to navigate to
// in-app for a same-origin app link, or null when the link should keep its
// default browser behaviour:
//   - a different origin (external link → opens in a new tab as today)
//   - a backend route (/api, /auth) that the server, not the SPA router, serves
//   - an unparseable href
export function inAppRouteTarget(href: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return null;
  return url.pathname + url.search + url.hash;
}

// previewsAsLinkCard reports whether a link in a message gets a link preview.
// A link to this app does only when it points at a message (`#msg-…`, drawn as
// the quoted message); a channel, a DM or a page of the app is a link (or a
// ~channel pill), and previewing it showed the app's own page, a card saying
// only "ex". Every other link does.
export function previewsAsLinkCard(href: string, origin: string): boolean {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return true;
  }
  return url.origin !== origin || url.hash.startsWith('#msg-');
}
