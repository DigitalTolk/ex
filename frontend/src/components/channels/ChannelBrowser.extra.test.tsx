import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChannelBrowser } from './ChannelBrowser';
import type { Channel, UserChannel } from '@/types';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const allChannels: Channel[] = [
  { id: 'ch-1', name: 'general', slug: 'general', type: 'public', createdBy: 'u-1', archived: false, createdAt: '2026-01-01T00:00:00Z' },
  { id: 'ch-2', name: 'random', slug: 'random', type: 'public', createdBy: 'u-1', archived: false, createdAt: '2026-01-01T00:00:00Z' },
];

const userChannels: UserChannel[] = [
  { channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 1 },
];

let browseLoading = false;
let browseData: Channel[] | undefined = allChannels;

const mockJoinMutate = vi.fn(
  (channelId: string, opts?: { onSuccess?: () => void }) => {
    opts?.onSuccess?.();
    return channelId;
  },
);

vi.mock('@/hooks/useChannels', () => ({
  useBrowseChannels: () => ({ data: browseData, isLoading: browseLoading }),
  useUserChannels: () => ({ data: userChannels }),
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

describe('ChannelBrowser - extra coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    browseLoading = false;
    browseData = allChannels;
  });

  it('shows loading skeletons while browse query is loading', () => {
    browseLoading = true;
    browseData = undefined;
    renderBrowser(true);
    // Skeletons are inside the portaled dialog content; query the entire document
    const skeletons = document.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('shows "No channels available" when list is empty', () => {
    browseData = [];
    renderBrowser(true);
    expect(screen.getByText('No channels available')).toBeInTheDocument();
  });

  it('navigates and closes when Join succeeds', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderBrowser(true, onOpenChange);

    await user.click(screen.getByText('Join'));

    expect(mockJoinMutate).toHaveBeenCalledWith('ch-2', expect.anything());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockNavigate).toHaveBeenCalledWith('/channel/ch-2');
  });

  it('navigates to channel and closes when Open is clicked on already-joined', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderBrowser(true, onOpenChange);

    await user.click(screen.getByText('Open'));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockNavigate).toHaveBeenCalledWith('/channel/ch-1');
  });
});
