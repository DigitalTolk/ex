// The workspace mark on the rail is the way home: ~general in its default view
// (the channel list in the sidebar, no thread or side panel open). The mark
// navigates with this state, and the channel view closes its panels when it
// sees it, even when ~general was already the page on screen.
export const HOME_NAV_STATE = { homeView: true } as const;

export function isHomeNav(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as { homeView?: unknown }).homeView === true;
}
