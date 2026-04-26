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

  it('does not render the Add member input for non-admins', () => {
    renderWithProviders(
      <MemberList
        members={[adminMember]}
        channelId="ch-1"
        currentUserId="admin-1"
        currentUserRole={1}
      />,
    );
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

    // Bob is not a member -> Add button visible
    const addBtn = screen.getByLabelText('Add Bob');
    fireEvent.click(addBtn);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/v1/channels/ch-1/members',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ userID: 'u-2', role: 'member' }),
        }),
      );
    });

    // Existing admin shows "Already a member" indicator
    expect(screen.getByLabelText('Already a member')).toBeInTheDocument();
  });
});
