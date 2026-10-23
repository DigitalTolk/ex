import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChannelMembership } from '@/types';
import { usePresenceStore } from '@/stores/presence';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

// Counts each member row's avatar renders, by name.
const avatarRenders = vi.hoisted(() => new Map<string, number>());
vi.mock('@/components/UserAvatar', () => ({
  UserAvatar: ({ displayName, online }: { displayName: string; online?: boolean }) => {
    avatarRenders.set(displayName, (avatarRenders.get(displayName) ?? 0) + 1);
    return <span data-testid={`avatar-${displayName}`} data-online={String(online)} />;
  },
}));

import { MemberList } from './MemberList';

const members: ChannelMembership[] = ['Alice', 'Bob', 'Cara'].map((name, i) => ({
  channelID: 'ch-1',
  userID: `u-${i + 1}`,
  role: i === 0 ? 'owner' : 'member',
  displayName: name,
  joinedAt: '2026-01-01T00:00:00Z',
}));

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <MemberList members={members} channelId="ch-1" currentUserId="u-1" currentUserRole={3} userMap={{}} />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockApiFetch.mockReset();
  mockApiFetch.mockResolvedValue([]);
  avatarRenders.clear();
});

describe('MemberList presence', () => {
  it("re-renders only the row whose member came online or went offline", async () => {
    renderList();
    expect(await screen.findByTestId('avatar-Bob')).toHaveAttribute('data-online', 'false');
    const before = new Map(avatarRenders);

    act(() => usePresenceStore.getState().setUserOnline('u-2', true));
    expect(screen.getByTestId('avatar-Bob')).toHaveAttribute('data-online', 'true');
    expect(avatarRenders.get('Alice')).toBe(before.get('Alice'));
    expect(avatarRenders.get('Cara')).toBe(before.get('Cara'));

    // Someone outside the channel: no member row renders.
    act(() => usePresenceStore.getState().setUserOnline('u-outsider', true));
    expect(avatarRenders.get('Bob')).toBe((before.get('Bob') ?? 0) + 1);
  });
});

describe('MemberList add-member search', () => {
  it('never lets a slow older search overwrite the results of a newer one', async () => {
    let resolveOlder: (users: unknown[]) => void = () => undefined;
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/v1/users?q=al') return new Promise((resolve) => { resolveOlder = resolve; });
      if (path === '/api/v1/users?q=ali') return Promise.resolve([{ id: 'u-ali', displayName: 'Alice Newer', email: 'ali@x.com' }]);
      return Promise.resolve([]);
    });
    renderList();
    const input = screen.getByLabelText('Add member');
    fireEvent.change(input, { target: { value: 'al' } });
    await waitFor(() => expect(mockApiFetch.mock.calls.some(([p]) => p === '/api/v1/users?q=al')).toBe(true));
    fireEvent.change(input, { target: { value: 'ali' } });
    expect(await screen.findByText('Alice Newer')).toBeInTheDocument();

    await act(async () => {
      resolveOlder([{ id: 'u-alan', displayName: 'Alan Older', email: 'alan@x.com' }]);
    });
    expect(screen.queryByText('Alan Older')).toBeNull();
    expect(screen.getByText('Alice Newer')).toBeInTheDocument();
  });

  it('clears the results as soon as the query is too short', async () => {
    mockApiFetch.mockImplementation((path: string) =>
      Promise.resolve(path.startsWith('/api/v1/users?q=') ? [{ id: 'u-9', displayName: 'Nina', email: 'n@x.com' }] : []),
    );
    renderList();
    const input = screen.getByLabelText('Add member');
    fireEvent.change(input, { target: { value: 'ni' } });
    expect(await screen.findByText('Nina')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'n' } });
    expect(screen.queryByText('Nina')).toBeNull();
    expect(screen.queryByText('No users found')).toBeNull();
  });
});
