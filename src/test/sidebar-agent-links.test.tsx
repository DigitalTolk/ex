import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
  useUserLookup: () => ({ data: [] }),
}));

const isMobileRef = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => isMobileRef.value }));

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  getAccessToken: () => null,
  ApiError: class extends Error { status = 0; },
}));

function renderAt(path: string, onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Sidebar onClose={onClose} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// The AI hub's one entry lives on the desktop icon rail (SidebarRail tests
// cover it lighting up on every hub route). The channel list itself carries
// no page links on desktop; on a phone, which has no rail, "Agents & tools"
// is the last of the pages that lead the list, right under Drafts.
describe('Sidebar and the Agents hub entry', () => {
  afterEach(() => {
    isMobileRef.value = false;
  });

  it.each([['/agents'], ['/skills'], ['/connectors/cliffhub'], ['/activity']])('has no Agents link in the desktop list on %s', (path) => {
    renderAt(path);
    for (const gone of ['Agents', 'Skills', 'Connectors', 'Drafts', 'Threads']) {
      expect(screen.queryByRole('link', { name: gone })).not.toBeInTheDocument();
    }
  });

  it('lists Agents & tools under Drafts on a phone, and leaves the list for it', () => {
    isMobileRef.value = true;
    const onClose = vi.fn();
    renderAt('/activity', onClose);
    const pages = screen.getAllByRole('link').map((l) => l.textContent?.trim());
    expect(pages.slice(0, 4)).toEqual(['Threads', 'Directory', 'Drafts', 'Agents & tools']);
    const agents = screen.getByRole('link', { name: 'Agents & tools' });
    expect(agents).toHaveAttribute('href', '/agents');
    expect(agents).not.toHaveAttribute('aria-current');
    fireEvent.click(agents);
    expect(onClose).toHaveBeenCalled();
  });

  it.each([['/agents'], ['/skills'], ['/connectors/cliffhub']])('lights Agents & tools on a phone at %s', (path) => {
    isMobileRef.value = true;
    renderAt(path);
    expect(screen.getByRole('link', { name: 'Agents & tools' }).className).toContain('font-semibold');
  });
});
