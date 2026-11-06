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

    // The existing admin's row carries the added checkmark.
    expect(screen.getByTestId('member-add-user-admin-1-added')).toHaveAccessibleName('Already added');
  });

  // The picker never offers a deactivated account: it can't be added.
  it('leaves deactivated accounts out of the add-member search', async () => {
    mockApiFetch.mockImplementation((path: string) =>
      Promise.resolve(
        path.startsWith('/api/v1/users?q=')
          ? [
              { id: 'u-2', displayName: 'Bob', email: 'bob@x.com', status: 'active' },
              { id: 'u-gone', displayName: 'Bob Gone', email: 'gone@x.com', status: 'deactivated' },
            ]
          : undefined,
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(
      <MemberList members={[adminMember]} channelId="ch-1" currentUserId="admin-1" currentUserRole={2} />,
    );

    await user.type(screen.getByLabelText('Add member'), 'Bob');

    expect(await screen.findByTestId('member-add-user-u-2')).toBeInTheDocument();
    expect(screen.queryByTestId('member-add-user-u-gone')).not.toBeInTheDocument();
  });

  // A bot posts only where it is a member, so this search finds bots too —
  // shown by their handle, never their undeliverable address.
  it('offers bots when adding someone, by their handle', async () => {
    mockApiFetch.mockImplementation((path: string) =>
      Promise.resolve(
        path.startsWith('/api/v1/users?q=')
          ? [
              { id: 'u-2', displayName: 'Incy Person', email: 'incy@x.com' },
              { id: 'b-1', displayName: 'Incident Bot', email: 'b-1@bots.ex.invalid', isBot: true, username: 'incident-bot' },
              { id: 'b-2', displayName: 'Incident Alerts', email: 'b-2@bots.ex.invalid', isBot: true },
            ]
          : undefined,
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(
      <MemberList members={[adminMember]} channelId="ch-1" currentUserId="admin-1" currentUserRole={1} />,
    );

    await user.type(screen.getByLabelText('Add member'), 'inc');

    expect(await screen.findByTestId('member-add-user-b-1')).toHaveTextContent('@incident-bot');
    expect(mockApiFetch.mock.calls.map(([path]) => path)).toContain('/api/v1/users?q=inc&bots=true');
    expect(screen.getByTestId('member-add-user-u-2')).toHaveTextContent('incy@x.com');
    // Migrated without a handle: just its name.
    expect(screen.getByTestId('member-add-user-b-2')).toHaveTextContent('Incident Alerts');
    expect(screen.getByTestId('member-add-user-b-2')).not.toHaveTextContent('@');
    expect(screen.getByTestId('member-add-user-b-2')).not.toHaveTextContent('bots.ex.invalid');
    expect(screen.getByTestId('member-add-user-b-1')).not.toHaveTextContent('bots.ex.invalid');
  });

  it('labels the bots among the members', () => {
    mockApiFetch.mockResolvedValue(undefined);
    renderWithProviders(
      <MemberList
        members={[adminMember, { channelID: 'ch-1', userID: 'b-1', role: 'member', displayName: 'Incident Bot', joinedAt: '2026-01-01T00:00:00Z' }]}
        userMap={{ 'admin-1': { displayName: 'Admin' }, 'b-1': { displayName: 'Incident Bot', isBot: true } }}
        channelId="ch-1"
        currentUserId="admin-1"
        currentUserRole={2}
      />,
    );
    expect(screen.getByTestId('member-name-status-b-1').parentElement).toHaveTextContent('Incident BotBot');
    expect(screen.getByTestId('member-name-status-admin-1').parentElement).not.toHaveTextContent('Bot');
  });
});
