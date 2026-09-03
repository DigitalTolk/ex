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

// The active-route styling of the agent-feature nav links (NavLink isActive
// arms) — each link renders bold + marked when its route is current.
describe('Sidebar — agent feature links active state', () => {
  it.each([
    ['/agents', 'Agents'],
    ['/skills', 'Skills'],
    ['/connectors', 'Connectors'],
  ])('marks %s active only on its own route', (path, label) => {
    const view = renderAt(path);
    const active = screen.getByRole('link', { name: label });
    expect(active.className).toContain('font-semibold');
    const others = ['Agents', 'Skills', 'Connectors'].filter((l) => l !== label);
    for (const other of others) {
      expect(screen.getByRole('link', { name: other }).className).not.toContain('font-semibold');
    }
    view.unmount();
  });
});
