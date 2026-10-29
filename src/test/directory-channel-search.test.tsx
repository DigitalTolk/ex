import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, useLocation } from 'react-router-dom';

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

let userChannels: Array<Record<string, unknown>> | undefined = [];
vi.mock('@/hooks/useChannels', () => ({
  useBrowseChannels: () => ({
    data: [
      { id: 'ch-1', name: 'general', slug: 'general', type: 'public', description: 'everyone' },
      { id: 'ch-2', name: 'design', slug: 'design', type: 'public', description: 'pixels' },
      { id: 'ch-3', name: 'random', slug: 'random', type: 'public', description: 'off-topic' },
      // Newest first, as the server lists them: incident rooms ahead of the
      // channel called incident.
      { id: 'ch-4', name: 'inc-1042', slug: 'inc-1042', type: 'public', description: 'Incident: payments down' },
      { id: 'ch-5', name: 'incidents-2025', slug: 'incidents-2025', type: 'public', description: '' },
      { id: 'ch-6', name: 'inc-1041', slug: 'inc-1041', type: 'public', description: 'Incident: login errors' },
      { id: 'ch-7', name: 'incident', slug: 'incident', type: 'public', description: 'Major incidents' },
    ],
    isLoading: false,
  }),
  useUserChannels: () => ({ data: userChannels }),
  useJoinChannel: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useConversations', () => ({
  useOpenDM: () => ({ openDM: vi.fn(), isPending: false }),
  useCreateConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: new Set(), isOnline: () => false, setUserOnline: vi.fn() }),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', email: 'a@x.com', displayName: 'A', systemRole: 'member', status: 'active' },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

import DirectoriesPage from '@/pages/DirectoriesPage';

function Location() {
  return <p data-testid="location">{useLocation().pathname}</p>;
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <DirectoriesPage />
        <Location />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('DirectoriesPage — channel search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userChannels = [];
  });

  it('renders all public channels by default', () => {
    renderPage();
    expect(screen.getByText('general')).toBeInTheDocument();
    expect(screen.getByText('design')).toBeInTheDocument();
    expect(screen.getByText('random')).toBeInTheDocument();
  });

  it('filters channels by name on search', () => {
    renderPage();
    const input = screen.getByLabelText('Search channels');
    fireEvent.change(input, { target: { value: 'des' } });
    expect(screen.getByText('design')).toBeInTheDocument();
    expect(screen.queryByText('general')).toBeNull();
    expect(screen.queryByText('random')).toBeNull();
  });

  it('matches the description text too', () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Search channels'), { target: { value: 'topic' } });
    expect(screen.getByText('random')).toBeInTheDocument();
    expect(screen.queryByText('general')).toBeNull();
  });

  it('lists the channel of that very name first, then names that start with it, then description matches', () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Search channels'), { target: { value: 'incident' } });
    const names = screen.getAllByText(/^inc/).map((el) => el.textContent);
    expect(names).toEqual(['incident', 'incidents-2025', 'inc-1042', 'inc-1041']);
  });

  it('shows no-match copy when nothing matches', () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Search channels'), { target: { value: 'zzz' } });
    expect(screen.getByText('No matching channels')).toBeInTheDocument();
  });

  // The sidebar doesn't list archived channels; their members find them here.
  it('lists your archived channels that match only while searching, after every live result', () => {
    userChannels = [
      { channelID: 'ch-7', channelName: 'incident', channelType: 'public' },
      { channelID: 'ch-old', channelName: 'incident-2019', channelType: 'public', archived: true },
      { channelID: 'ch-old-ops', channelName: 'Ops Incidents', channelType: 'private', archived: true },
      { channelID: 'ch-other', channelName: 'marketing', channelType: 'public', archived: true },
    ];
    renderPage();
    expect(screen.queryByText('incident-2019')).toBeNull();
    expect(screen.queryByText('Archived')).toBeNull();

    fireEvent.change(screen.getByLabelText('Search channels'), { target: { value: 'incident' } });
    const names = screen.getAllByText(/inc/i, { selector: 'p.font-medium' }).map((el) => el.textContent);
    expect(names).toEqual(['incident', 'incidents-2025', 'inc-1042', 'inc-1041', 'incident-2019', 'Ops Incidents']);
    expect(screen.queryByText('marketing')).toBeNull();
    expect(screen.getAllByText('Archived')).toHaveLength(2);

    const archived = screen.getByTestId('directory-archived-ch-old-ops');
    fireEvent.click(within(archived).getByRole('button', { name: 'Open' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/channel/ops-incidents');
  });

  it('shows an archived match alone when no live channel matches', () => {
    userChannels = [{ channelID: 'ch-old', channelName: 'legacy-billing', channelType: 'public', archived: true }];
    renderPage();
    fireEvent.change(screen.getByLabelText('Search channels'), { target: { value: 'legacy' } });
    expect(screen.getByText('legacy-billing')).toBeInTheDocument();
    expect(screen.queryByText('No matching channels')).toBeNull();
  });

  it('searches the live channels while your own are still loading', () => {
    userChannels = undefined;
    renderPage();
    fireEvent.change(screen.getByLabelText('Search channels'), { target: { value: 'des' } });
    expect(screen.getByText('design')).toBeInTheDocument();
    expect(screen.queryByText('Archived')).toBeNull();
  });
});
