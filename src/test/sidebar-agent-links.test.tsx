import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from '@/components/layout/Sidebar';

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'u-1',
      email: 'a@b.c',
      displayName: 'Alice',
      systemRole: 'member',
      status: 'active',
    },
    isAuthenticated: true,
    isLoading: false,
    logout: vi.fn(),
  }),
}));

vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({
    unreadChannels: new Set<string>(),
    unreadChannelNotifications: new Set(),
    unreadConversations: new Set<string>(),
    hiddenConversations: new Set<string>(),
    hideConversation: vi.fn(),
  }),
}));

vi.mock('@/hooks/useChannels', () => ({
  useUserChannels: () => ({ data: [] }),
  useCreateChannel: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useConversations', () => ({
  useOpenDM: () => ({ openDM: vi.fn(), isPending: false }),
  useUserConversations: () => ({ data: [] }),
  useCreateConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useSearchUsers: () => ({ data: [] }),
}));

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  getAccessToken: () => null,
  ApiError: class extends Error { status = 0; },
}));

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Sidebar onClose={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// The three agent-feature pages share ONE sidebar entry ("Agents"); it lights up
// on every hub route and only there, and the old per-page links are gone.
describe('Sidebar — Agents hub entry', () => {
  it.each([['/agents'], ['/skills'], ['/connectors'], ['/connectors/cliffhub']])(
    'marks the Agents entry active on %s',
    (path) => {
      const view = renderAt(path);
      const ai = screen.getByRole('link', { name: 'Agents' });
      expect(ai.className).toContain('font-semibold');
      expect(ai).toHaveAttribute('aria-current', 'page');
      expect(ai).toHaveAttribute('href', '/agents');
      for (const gone of ['Skills', 'Connectors']) {
        expect(screen.queryByRole('link', { name: gone })).not.toBeInTheDocument();
      }
      view.unmount();
    },
  );

  it('is not active elsewhere', () => {
    renderAt('/activity');
    const ai = screen.getByRole('link', { name: 'Agents' });
    expect(ai.className).not.toContain('font-semibold');
    expect(ai).not.toHaveAttribute('aria-current');
  });
});
