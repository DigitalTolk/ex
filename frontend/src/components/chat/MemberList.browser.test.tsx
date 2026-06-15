import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemberList } from './MemberList';
import { apiFetch } from '@/lib/api';
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
  afterEach(() => cleanup());

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

  it('invokes onClose from the close button', async () => {
    const onClose = vi.fn();
    const screen = await renderWithProviders(
      <MemberList members={[makeMember()]} channelId="ch-1" currentUserId="u-1" currentUserRole={4} onClose={onClose} />,
    );
    await screen.getByRole('button', { name: 'Close member list' }).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('searches for users, flags existing members, and adds a non-member', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
      if (typeof url === 'string' && url.includes('/users?q=')) {
        return [
          // Already a member (memberIds.has) → Check, plus avatarURL branch.
          { id: 'u-1', displayName: 'Alice', email: 'alice@x.test', avatarURL: 'https://x/a.png' },
          // Empty display name → getInitials('??') fallback.
          { id: 'u-0', displayName: '', email: 'ghost@x.test' },
          // New user → Add button.
          { id: 'u-9', displayName: 'Newbie', email: 'new@x.test' },
        ];
      }
      return undefined;
    });
    const screen = await renderWithProviders(
      <MemberList
        members={[makeMember({ userID: 'u-1', displayName: 'Alice' })]}
        channelId="ch-1"
        currentUserId="u-me"
        currentUserRole={4}
      />,
    );
    await screen.getByLabelText('Add member').fill('ne');
    // After the 300ms debounce the results render.
    await expect.element(screen.getByLabelText('Already a member')).toBeVisible();
    const addBtn = screen.getByRole('button', { name: 'Add Newbie' });
    await expect.element(addBtn).toBeVisible();
    await addBtn.click();
    await vi.waitFor(() => {
      const call = vi.mocked(apiFetch).mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('/channels/ch-1/members')
          && (c[1] as { method?: string } | undefined)?.method === 'POST',
      );
      expect(call).toBeDefined();
    });
  });

  it('shows "No users found" when a search returns nothing', async () => {
    vi.mocked(apiFetch).mockResolvedValue([]);
    const screen = await renderWithProviders(
      <MemberList members={[makeMember()]} channelId="ch-1" currentUserId="u-me" currentUserRole={4} />,
    );
    await screen.getByLabelText('Add member').fill('zz');
    await expect.element(screen.getByText('No users found')).toBeVisible();
  });

  it('surfaces an error message when adding a member fails', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => {
      if (typeof url === 'string' && url.includes('/users?q=')) {
        return [{ id: 'u-9', displayName: 'Newbie', email: 'new@x.test' }];
      }
      if ((init as { method?: string } | undefined)?.method === 'POST') {
        throw new Error('already pending invite');
      }
      return undefined;
    });
    const screen = await renderWithProviders(
      <MemberList members={[makeMember()]} channelId="ch-1" currentUserId="u-me" currentUserRole={4} />,
    );
    await screen.getByLabelText('Add member').fill('ne');
    await screen.getByRole('button', { name: 'Add Newbie' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('already pending invite');
  });

  it('falls back to "Unknown" for a member with no display name', async () => {
    const screen = await renderWithProviders(
      <MemberList
        members={[makeMember({ userID: 'u-ghost', displayName: '' })]}
        channelId="ch-1"
        currentUserId="u-me"
      />,
    );
    await expect.element(
      screen.getByTestId('member-name-status-u-ghost'),
    ).toHaveTextContent('Unknown');
  });

  it('falls back to the generic message when adding fails with a non-Error throw', async () => {
    // The catch in handleAdd uses `err instanceof Error ? err.message :
    // 'Failed to add member'`. Throwing a non-Error (a string) exercises
    // the else arm (line 90).
    vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => {
      if (typeof url === 'string' && url.includes('/users?q=')) {
        return [{ id: 'u-9', displayName: 'Newbie', email: 'new@x.test' }];
      }
      if ((init as { method?: string } | undefined)?.method === 'POST') {
        throw 'plain string failure';
      }
      return undefined;
    });
    const screen = await renderWithProviders(
      <MemberList members={[makeMember()]} channelId="ch-1" currentUserId="u-me" currentUserRole={4} />,
    );
    await screen.getByLabelText('Add member').fill('ne');
    await screen.getByRole('button', { name: 'Add Newbie' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('Failed to add member');
  });

  it('no-ops the remove handler when no channelId is set', async () => {
    // An actor with a managing role but NO channelId still renders the
    // remove control for a removable member (canRemoveMember does not
    // depend on channelId). Clicking it hits handleRemove's
    // `if (!channelId) return` guard (line 74) — no DELETE is issued.
    vi.mocked(apiFetch).mockClear();
    const screen = await renderWithProviders(
      <MemberList
        members={[
          makeMember({ userID: 'u-1', displayName: 'Alice', role: 'owner' }),
          makeMember({ userID: 'u-2', displayName: 'Bob', role: 'member' }),
        ]}
        channelId={undefined}
        currentUserId="u-1"
        currentUserRole={5}
      />,
    );
    await screen.getByRole('button', { name: 'Remove Bob' }).click();
    await new Promise((r) => setTimeout(r, 30));
    const deleteCall = vi.mocked(apiFetch).mock.calls.find(
      (c: unknown[]) => (c[1] as { method?: string } | undefined)?.method === 'DELETE',
    );
    expect(deleteCall).toBeUndefined();
  });

  it('removes another member via the DELETE endpoint', async () => {
    vi.mocked(apiFetch).mockClear();
    const screen = await renderWithProviders(
      <MemberList
        members={[
          makeMember({ userID: 'u-1', displayName: 'Alice', role: 'owner' }),
          makeMember({ userID: 'u-2', displayName: 'Bob', role: 'member' }),
        ]}
        channelId="ch-1"
        currentUserId="u-1"
        currentUserRole={5}
      />,
    );
    // An owner can remove a plain member — the remove control is keyed by name.
    await screen.getByRole('button', { name: 'Remove Bob' }).click();
    await vi.waitFor(() => {
      const call = vi.mocked(apiFetch).mock.calls.find(
        (c: unknown[]) => c[0] === '/api/v1/channels/ch-1/members/u-2',
      );
      expect(call).toBeDefined();
      expect((call![1] as { method: string }).method).toBe('DELETE');
    });
  });
});
