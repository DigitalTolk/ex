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
