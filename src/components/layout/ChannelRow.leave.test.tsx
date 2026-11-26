import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChannelRow } from './ChannelRow';
import type { UserChannel } from '@/types';

// Leaving a channel from its sidebar row's menu, as from the channel's own.

const mockApiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<object>()), apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));

const member: UserChannel = { channelID: 'ch-9', channelName: 'release-train', channelType: 'public', role: 1 };

function Path() {
  return <div data-testid="path">{useLocation().pathname}</div>;
}

function renderRow(channel: UserChannel, active = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/channel/release-train']}>
        <ChannelRow onNavigate={vi.fn()} channel={channel} hasUnread={false} onClose={vi.fn()} active={active} />
        <Path />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function openMenu(channelID: string) {
  fireEvent.mouseDown(screen.getByTestId(`row-menu-${channelID}`), { button: 0 });
}

beforeEach(() => {
  mockApiFetch.mockReset();
  mockApiFetch.mockImplementation((path: string) => Promise.resolve(path === '/api/v1/sidebar/categories' ? [] : undefined));
});

describe('ChannelRow: Leave channel', () => {
  it('leaves the channel from the row menu, and goes home when it was the one on screen', async () => {
    renderRow(member, true);
    openMenu('ch-9');
    fireEvent.click(await screen.findByTestId('row-leave-ch-9'));
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-9/leave', { method: 'POST' }));
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent(/^\/$/));
  });

  it('stays where it is when leaving a channel that is not on screen', async () => {
    renderRow(member, false);
    openMenu('ch-9');
    fireEvent.click(await screen.findByTestId('row-leave-ch-9'));
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-9/leave', { method: 'POST' }));
    expect(screen.getByTestId('path')).toHaveTextContent('/channel/release-train');
  });

  it('offers no way out of ~general', async () => {
    renderRow({ ...member, channelID: 'ch-g', channelName: 'general' });
    openMenu('ch-g');
    expect(await screen.findByText('Move to Channels')).toBeInTheDocument();
    expect(screen.queryByTestId('row-leave-ch-g')).toBeNull();
  });

  it('offers no way out to the channel owner', async () => {
    renderRow({ ...member, channelID: 'ch-o', role: 3 });
    openMenu('ch-o');
    expect(await screen.findByText('Move to Channels')).toBeInTheDocument();
    expect(screen.queryByTestId('row-leave-ch-o')).toBeNull();
  });
});
