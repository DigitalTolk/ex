import { useSyncExternalStore } from 'react';

// Whether the tab's history has somewhere to go back or forward to, as the
// browser itself keeps it (the Navigation API), so entries pushed outside the
// router (a notification click) count too. Browsers without the API report
// nothing; their own Back and Forward still work.
function navigationApi(): Navigation | undefined {
  return 'navigation' in window ? window.navigation : undefined;
}

function subscribe(onChange: () => void): () => void {
  const nav = navigationApi();
  nav?.addEventListener('currententrychange', onChange);
  return () => nav?.removeEventListener('currententrychange', onChange);
}

export interface HistoryTraversal {
  supported: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export function useHistoryTraversal(): HistoryTraversal {
  const canGoBack = useSyncExternalStore(subscribe, () => navigationApi()?.canGoBack ?? false);
  const canGoForward = useSyncExternalStore(subscribe, () => navigationApi()?.canGoForward ?? false);
  return { supported: navigationApi() !== undefined, canGoBack, canGoForward };
}
