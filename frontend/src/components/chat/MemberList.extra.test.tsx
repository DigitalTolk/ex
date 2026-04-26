import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChannelMembership } from '@/types';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

import { MemberList } from './MemberList';

function renderList(props: Partial<Parameters<typeof MemberList>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const members: ChannelMembership[] = props.members ?? [
    { channelID: 'ch-1', userID: 'u-1', role: 'owner', displayName: 'Alice', joinedAt: '2026-01-01T00:00:00Z' },
    { channelID: 'ch-1', userID: 'u-2', role: 'member', displayName: 'Bob', joinedAt: '2026-01-01T00:00:00Z' },
  ];
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <MemberList
          members={members}
          channelId="ch-1"
          currentUserId="u-1"
          currentUserRole={3}
          userMap={{}}
          {...props}
        />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MemberList - invite & remove', () => {
  it('admin types in inline Add member input and search results appear', async () => {
    mockApiFetch.mockResolvedValueOnce([
      { id: 'u-99', displayName: 'New One', email: 'new@x.com' },
    ]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderList();

    const input = screen.getByLabelText('Add member');
    await user.type(input, 'new');
    vi.advanceTimersByTime(500);

    await waitFor(() => {
      expect(screen.getByText('New One')).toBeInTheDocument();
    });
  });

  it('clears results silently if search fails', async () => {
    mockApiFetch.mockRejectedValueOnce(new Error('search failed'));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderList();

    await user.type(screen.getByLabelText('Add member'), 'fa');
    vi.advanceTimersByTime(500);

    await waitFor(() => {
      expect(screen.getByText('No users found')).toBeInTheDocument();
    });
  });

  it('shows error when handleAdd API fails', async () => {
    mockApiFetch.mockResolvedValueOnce([
      { id: 'u-99', displayName: 'New One', email: 'new@x.com' },
    ]);
    mockApiFetch.mockRejectedValueOnce(new Error('add failed'));

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderList();

    await user.type(screen.getByLabelText('Add member'), 'new');
    vi.advanceTimersByTime(500);

    await screen.findByText('New One');
    fireEvent.click(screen.getByRole('button', { name: /Add New One/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('add failed');
  });

  it('handleRemove calls DELETE API for the target member', async () => {
    mockApiFetch.mockResolvedValue({});
    renderList();
    fireEvent.click(screen.getByLabelText('Remove Bob'));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/v1/channels/ch-1/members/u-2',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  it('shows Check icon for already-member when searching', async () => {
    mockApiFetch.mockResolvedValueOnce([
      { id: 'u-2', displayName: 'Bob', email: 'bob@x.com' },
    ]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderList();

    await user.type(screen.getByLabelText('Add member'), 'bo');
    vi.advanceTimersByTime(500);

    expect(await screen.findByLabelText('Already a member')).toBeInTheDocument();
  });

  it('inline invite input is always visible for admins', () => {
    renderList();
    expect(screen.getByLabelText('Add member')).toBeInTheDocument();
  });
});
