import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChannelBrowser } from './ChannelBrowser';
import type { Channel, UserChannel } from '@/types';

const mockAllChannels: Channel[] = [
  { id: 'ch-1', name: 'general', slug: 'general', type: 'public', createdBy: 'u-1', archived: false, createdAt: '2026-01-01T00:00:00Z' },
  { id: 'ch-2', name: 'random', slug: 'random', type: 'public', createdBy: 'u-1', archived: false, createdAt: '2026-01-01T00:00:00Z', description: 'Fun stuff' },
];

const mockUserChannels: UserChannel[] = [
  { channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 1 },
];

const mockJoinMutate = vi.fn();

// undefined = the user's channel list hasn't loaded yet.
let mockUserChannelsData: UserChannel[] | undefined = mockUserChannels;

vi.mock('@/hooks/useChannels', () => ({
  useBrowseChannels: () => ({ data: mockAllChannels, isLoading: false }),
  useUserChannels: () => ({ data: mockUserChannelsData }),
  useJoinChannel: () => ({ mutate: mockJoinMutate, isPending: false }),
}));

function renderBrowser(open = true, onOpenChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <ChannelBrowser open={open} onOpenChange={onOpenChange} />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('ChannelBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserChannelsData = mockUserChannels;
  });

  it('renders dialog title when open', () => {
    renderBrowser(true);
    expect(screen.getByText('Browse channels')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    renderBrowser(false);
    expect(screen.queryByText('Browse channels')).not.toBeInTheDocument();
  });

  it('shows channel names', () => {
    renderBrowser(true);
    expect(screen.getByText('general')).toBeInTheDocument();
    expect(screen.getByText('random')).toBeInTheDocument();
  });

  it('shows channel description', () => {
    renderBrowser(true);
    expect(screen.getByText('Fun stuff')).toBeInTheDocument();
  });

  it('shows "Open" for already-joined channels', () => {
    renderBrowser(true);
    expect(screen.getByText('Open')).toBeInTheDocument();
  });

  it('shows "Join" for not-yet-joined channels', () => {
    renderBrowser(true);
    expect(screen.getByText('Join')).toBeInTheDocument();
  });

  it('treats every channel as joinable while the user channel list has not loaded', () => {
    // useUserChannels().data is undefined until the query resolves — the
    // joined-set must fall back to empty instead of crashing, so every
    // channel shows "Join" and none claims "Open".
    mockUserChannelsData = undefined;
    renderBrowser(true);
    expect(screen.getAllByText('Join')).toHaveLength(2);
    expect(screen.queryByText('Open')).toBeNull();
  });

  it('calls joinChannel.mutate when Join is clicked', async () => {
    const user = userEvent.setup();
    renderBrowser(true);

    await user.click(screen.getByText('Join'));
    expect(mockJoinMutate).toHaveBeenCalledWith('ch-2', expect.anything());
  });
});
