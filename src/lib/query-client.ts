import { QueryClient } from '@tanstack/react-query';

// The app-wide React Query client, extracted so non-component modules (e.g.
// AuthContext's session-invalidation handler) can clear it directly without
// needing a QueryClientProvider ancestor.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

// For queries the WebSocket keeps current: ChatPage's handlers patch them in
// place or invalidate them when the server says they changed, and
// refreshAfterGap refetches them after a reconnect or a lost replay cursor.
// Their data never goes stale on a timer, so neither a window refocus nor a
// newly mounted observer refetches them — that only re-requested what the
// socket had already delivered. Poll-based queries keep the defaults.
export const wsLiveQueryOptions = {
  staleTime: Infinity,
  refetchOnWindowFocus: false,
} as const;
