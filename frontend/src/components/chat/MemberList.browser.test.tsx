import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemberList } from './MemberList';
import type { ChannelMembership } from '@/types';

// Browser-side coverage for the channel members rail. The dom-side
// test exercises swipe gestures and search; this file mounts the
// component in a real browser to catch what dom tests miss —
// runtime errors from real CSS, real layout, real querySelector
// dynamics. Specifically: a 0% browser-coverage component is one
// the MessageList-style regression we just shipped (chat goes
// black on a malformed render) would never have been caught in.

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue([]),
  setAccessToken: vi.fn(),
  getAccessToken: vi.fn(() => null),
  clearAccessToken: vi.fn(),
  refreshAccessToken: vi.fn().mockResolvedValue(null),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
}));

function makeMember(overrides: Partial<ChannelMembership> = {}): ChannelMembership {
  return {
    channelID: 'ch-1',
    userID: 'u-1',
    role: 'member',
    displayName: 'Alice',
    joinedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>{ui}</BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('MemberList browser behaviour', () => {
  it('renders the member roster with avatars + display names', async () => {
    const screen = await renderWithProviders(
      <MemberList
        members={[
          makeMember({ userID: 'u-1', displayName: 'Alice' }),
          makeMember({ userID: 'u-2', displayName: 'Bob' }),
        ]}
        channelId="ch-1"
        currentUserId="u-1"
        currentUserRole={4}
      />,
    );
    await expect.element(screen.getByText('Alice')).toBeVisible();
    await expect.element(screen.getByText('Bob')).toBeVisible();
  });

  it('renders the role badge for owner / admin entries', async () => {
    const screen = await renderWithProviders(
      <MemberList
        members={[
          makeMember({ userID: 'u-1', displayName: 'Alice', role: 'owner' }),
          makeMember({ userID: 'u-2', displayName: 'Bob', role: 'admin' }),
        ]}
        channelId="ch-1"
        currentUserId="u-1"
        currentUserRole={5}
      />,
    );
    await expect.element(screen.getByText('Owner')).toBeVisible();
    await expect.element(screen.getByText('Admin')).toBeVisible();
  });

  it('shows the add-people search input when the viewer can manage members', async () => {
    await renderWithProviders(
      <MemberList
        members={[makeMember()]}
        channelId="ch-1"
        currentUserId="u-1"
        // ChannelRole.Admin can manage members
        currentUserRole={4}
      />,
    );
    const input = document.querySelector('input[placeholder*="Add a member"]');
    expect(input).not.toBeNull();
  });

  it('hides the management UI when the viewer is a plain member', async () => {
    await renderWithProviders(
      <MemberList
        members={[makeMember()]}
        channelId="ch-1"
        currentUserId="u-1"
        currentUserRole={1}
      />,
    );
    // No search input → cannot escalate. data-testid is stable across
    // mobile/desktop variants.
    const input = document.querySelector('input[type="text"]');
    expect(input).toBeNull();
  });

  it('renders without crashing when no userMap entries are provided', async () => {
    await renderWithProviders(
      <MemberList
        members={[makeMember({ userID: 'u-x', displayName: 'X-Member' })]}
        channelId="ch-1"
        currentUserId="u-1"
      />,
    );
    // X-Member is unique enough not to collide with anything else.
    const node = Array.from(document.querySelectorAll('span'))
      .find((el) => el.textContent === 'X-Member');
    expect(node).toBeDefined();
  });
});
