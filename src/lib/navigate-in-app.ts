// Opens a notification's deep link. Same-origin links are SPA navigations:
// setting window.location.href would reload the document and wipe the loaded
// message history (on a deep-link landing that leaves only the around-window
// plus one page each side), so pushState + popstate hands the route to React
// Router instead. The backend never produces a link to another origin; one is
// followed only when it is plain http(s), and anything else (javascript:,
// data:, a scheme some OS handler owns) is dropped.
export function navigateInApp(href: string): void {
  let url: URL;
  try {
    url = new URL(href, window.location.origin);
  } catch {
    return;
  }
  if (url.origin === window.location.origin) {
    window.history.pushState(null, '', url.pathname + url.search + url.hash);
    window.dispatchEvent(new PopStateEvent('popstate'));
    return;
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') window.location.assign(url.href);
}
