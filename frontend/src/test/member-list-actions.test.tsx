import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemberList } from '@/components/chat/MemberList';
import type { ChannelMembership } from '@/types';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue(undefined),
}));

function makeMember(overrides: Partial<ChannelMembership> = {}): ChannelMembership {
  return {
    channelID: 'ch-1',
    userID: 'user-1',
    role: 'member',
    displayName: 'Alice Johnson',
    joinedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>{ui}</BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('MemberList - admin actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows Add member button when user is admin', () => {
    const members = [
      makeMember({ userID: 'admin-1', role: 'admin', displayName: 'Admin' }),
      makeMember({ userID: 'user-2', displayName: 'Bob' }),
    ];

    renderWithProviders(
      <MemberList
        members={members}
        channelId="ch-1"
        currentUserId="admin-1"
        currentUserRole={2}
      />,
    );

    expect(screen.getByLabelText('Add member')).toBeInTheDocument();
  });

  it('does not show Add member button for regular members', () => {
    const members = [
      makeMember({ userID: 'user-1', displayName: 'Alice' }),
    ];

    renderWithProviders(
      <MemberList
        members={members}
        channelId="ch-1"
        currentUserId="user-1"
        currentUserRole={1}
      />,
    );

    expect(screen.queryByLabelText('Add member')).not.toBeInTheDocument();
  });

  it('shows remove button for non-owner members when user is admin', () => {
    const members = [
      makeMember({ userID: 'admin-1', role: 2 as unknown as ChannelMembership['role'], displayName: 'Admin' }),
      makeMember({ userID: 'user-2', role: 'member', displayName: 'Bob' }),
    ];

    renderWithProviders(
      <MemberList
        members={members}
        channelId="ch-1"
        currentUserId="admin-1"
        currentUserRole={2}
      />,
    );

    expect(screen.getByLabelText('Remove Bob')).toBeInTheDocument();
  });

  it('does not show remove button for owners', () => {
    const members = [
      makeMember({ userID: 'admin-1', role: 2 as unknown as ChannelMembership['role'], displayName: 'Admin' }),
      makeMember({ userID: 'owner-1', role: 'owner', displayName: 'Owner' }),
    ];

    renderWithProviders(
      <MemberList
        members={members}
        channelId="ch-1"
        currentUserId="admin-1"
        currentUserRole={2}
      />,
    );

    expect(screen.queryByLabelText('Remove Owner')).not.toBeInTheDocument();
  });

  it('calls apiFetch on remove button click', async () => {
    const { apiFetch } = await import('@/lib/api');
    const mockFetch = vi.mocked(apiFetch);

    const members = [
      makeMember({ userID: 'admin-1', role: 2 as unknown as ChannelMembership['role'], displayName: 'Admin' }),
      makeMember({ userID: 'user-2', role: 'member', displayName: 'Bob' }),
    ];

    renderWithProviders(
      <MemberList
        members={members}
        channelId="ch-1"
        currentUserId="admin-1"
        currentUserRole={2}
      />,
    );

    fireEvent.click(screen.getByLabelText('Remove Bob'));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/channels/ch-1/members/user-2',
        { method: 'DELETE' },
      );
    });
  });

  it('renders the inline Add member input by default for admins', () => {
    const members = [
      makeMember({ userID: 'admin-1', role: 'admin', displayName: 'Admin' }),
    ];

    renderWithProviders(
      <MemberList
        members={members}
        channelId="ch-1"
        currentUserId="admin-1"
        currentUserRole={2}
      />,
    );

    expect(screen.getByLabelText('Add member')).toBeInTheDocument();
  });
});
