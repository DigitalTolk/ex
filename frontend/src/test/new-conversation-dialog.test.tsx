import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NewConversationDialog } from '@/components/conversations/NewConversationDialog';

const mockMutate = vi.fn();

vi.mock('@/hooks/useConversations', () => ({
  useSearchUsers: (q: string) => ({
    data: q.length >= 2 ? [
      { id: 'u-10', displayName: 'Charlie Brown', email: 'charlie@test.com' },
      { id: 'u-11', displayName: 'Diana Prince', email: 'diana@test.com' },
    ] : [],
  }),
  useCreateConversation: () => ({ mutate: mockMutate, isPending: false }),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', displayName: 'Test', email: 't@t.com', systemRole: 'member', status: 'active' },
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    setAuth: vi.fn(),
  }),
}));

function renderDialog(open = true, onOpenChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <NewConversationDialog open={open} onOpenChange={onOpenChange} />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('NewConversationDialog - group flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows "Create Group" button when multiple users selected', async () => {
    const user = userEvent.setup();
    renderDialog(true);

    // Select first user
    await user.type(screen.getByLabelText('Search users'), 'Ch');
    await user.click(screen.getByText('Charlie Brown'));

    // Search for second user
    await user.type(screen.getByLabelText('Search users'), 'Di');
    await user.click(screen.getByText('Diana Prince'));

    expect(screen.getByText('Create Group')).toBeInTheDocument();
  });

  it('does not show a group name input — names are derived from participants', async () => {
    const user = userEvent.setup();
    renderDialog(true);

    await user.type(screen.getByLabelText('Search users'), 'Ch');
    await user.click(screen.getByText('Charlie Brown'));

    await user.type(screen.getByLabelText('Search users'), 'Di');
    await user.click(screen.getByText('Diana Prince'));

    expect(screen.queryByLabelText(/group name/i)).toBeNull();
    // The Create Group affordance still flips on for 2+ participants.
    expect(screen.getByText('Create Group')).toBeInTheDocument();
  });

  it('allows removing a selected user', async () => {
    const user = userEvent.setup();
    renderDialog(true);

    await user.type(screen.getByLabelText('Search users'), 'Ch');
    await user.click(screen.getByText('Charlie Brown'));

    // Charlie should appear as a badge with remove button
    expect(screen.getByLabelText('Remove Charlie Brown')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Remove Charlie Brown'));

    // Badge should be removed, button should be disabled again
    expect(screen.getByText('Start Conversation')).toBeDisabled();
  });

  it('does not add duplicate user', async () => {
    const user = userEvent.setup();
    renderDialog(true);

    // Select Charlie
    await user.type(screen.getByLabelText('Search users'), 'Ch');
    await user.click(screen.getByText('Charlie Brown'));

    // Try to select Charlie again
    await user.type(screen.getByLabelText('Search users'), 'Ch');

    // Charlie should not appear in results because already selected
    const results = screen.queryAllByText('Charlie Brown');
    // Should have exactly 1 (the badge) - the search result should be filtered out
    expect(results.length).toBe(1);
  });

  it('calls mutate with group type when creating group', async () => {
    const user = userEvent.setup();
    renderDialog(true);

    await user.type(screen.getByLabelText('Search users'), 'Ch');
    await user.click(screen.getByText('Charlie Brown'));

    await user.type(screen.getByLabelText('Search users'), 'Di');
    await user.click(screen.getByText('Diana Prince'));

    await user.click(screen.getByText('Create Group'));

    expect(mockMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'group',
        participantIDs: ['u-10', 'u-11'],
      }),
      expect.anything(),
    );
  });

  it('calls mutate with dm type for single user', async () => {
    const user = userEvent.setup();
    renderDialog(true);

    await user.type(screen.getByLabelText('Search users'), 'Ch');
    await user.click(screen.getByText('Charlie Brown'));

    await user.click(screen.getByText('Start Conversation'));

    expect(mockMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'dm',
        participantIDs: ['u-10'],
      }),
      expect.anything(),
    );
  });

  it('does not call mutate when no users selected', async () => {
    renderDialog(true);

    // Button should be disabled but let's verify create logic
    const btn = screen.getByText('Start Conversation');
    expect(btn).toBeDisabled();
  });
});
