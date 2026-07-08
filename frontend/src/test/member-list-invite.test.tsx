import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemberList } from '@/components/chat/MemberList';
import type { ChannelMembership } from '@/types';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>{ui}</BrowserRouter>
    </QueryClientProvider>,
  );
}

const adminMember: ChannelMembership = {
  channelID: 'ch-1',
  userID: 'admin-1',
  role: 'admin',
  displayName: 'Admin',
  joinedAt: '2026-01-01T00:00:00Z',
};

describe('MemberList - inline invite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the inline Add member input by default for admins', () => {
    renderWithProviders(
      <MemberList
        members={[adminMember]}
        channelId="ch-1"
        currentUserId="admin-1"
        currentUserRole={2}
      />,
    );
    expect(screen.getByLabelText('Add member')).toBeInTheDocument();
  });

  it('renders the Add member input for regular members (anyone can invite)', () => {
    renderWithProviders(
      <MemberList
        members={[adminMember]}
        channelId="ch-1"
        currentUserId="admin-1"
        currentUserRole={1}
      />,
    );
    expect(screen.queryByLabelText('Add member')).not.toBeNull();
  });

  it('does not render the Add member input without a channel context', () => {
    renderWithProviders(<MemberList members={[adminMember]} currentUserId="admin-1" currentUserRole={1} />);
    expect(screen.queryByLabelText('Add member')).toBeNull();
  });

  it('searches users and adds them via inline UI', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.startsWith('/api/v1/users?q=')) {
        return Promise.resolve([
          { id: 'u-2', displayName: 'Bob', email: 'bob@x.com' },
          { id: 'admin-1', displayName: 'Admin', email: 'admin@x.com' },
        ]);
      }
      return Promise.resolve(undefined);
    });

    const user = userEvent.setup();
    renderWithProviders(
      <MemberList
        members={[adminMember]}
        channelId="ch-1"
        currentUserId="admin-1"
        currentUserRole={2}
      />,
    );

    const search = screen.getByLabelText('Add member');
    await user.type(search, 'Bob');

    await waitFor(() => {
      expect(screen.getByText('Bob')).toBeInTheDocument();
    });

    // Bob is not a member → his row is clickable and adds him (the whole
    // canonical people-row is the control now, matching every other picker).
    fireEvent.click(screen.getByTestId('member-add-user-u-2'));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/v1/channels/ch-1/members',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ userID: 'u-2', role: 'member' }),
        }),
      );
    });

    // The existing admin's row carries the standard Added badge.
    expect(screen.getByTestId('member-add-user-admin-1-added')).toHaveTextContent('Added');
  });
});
