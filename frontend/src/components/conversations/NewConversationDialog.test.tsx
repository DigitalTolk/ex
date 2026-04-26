import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NewConversationDialog } from './NewConversationDialog';

const mockMutate = vi.fn();

vi.mock('@/hooks/useConversations', () => ({
  useSearchUsers: (q: string) => ({
    data: q.length >= 2 ? [
      { id: 'u-10', displayName: 'Charlie Brown', email: 'charlie@test.com' },
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

describe('NewConversationDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders dialog title when open', () => {
    renderDialog(true);
    expect(screen.getByText('New conversation')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    renderDialog(false);
    expect(screen.queryByText('New conversation')).not.toBeInTheDocument();
  });

  it('has a search users input', () => {
    renderDialog(true);
    expect(screen.getByLabelText('Search users')).toBeInTheDocument();
  });

  it('has a cancel button', () => {
    renderDialog(true);
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('shows Start Conversation button initially (disabled)', () => {
    renderDialog(true);
    const btn = screen.getByText('Start Conversation');
    expect(btn).toBeDisabled();
  });

  it('shows search results when query is typed', async () => {
    const user = userEvent.setup();
    renderDialog(true);

    await user.type(screen.getByLabelText('Search users'), 'Ch');

    expect(screen.getByText('Charlie Brown')).toBeInTheDocument();
    expect(screen.getByText('charlie@test.com')).toBeInTheDocument();
  });

  it('adds a user to selected list when clicked from results', async () => {
    const user = userEvent.setup();
    renderDialog(true);

    await user.type(screen.getByLabelText('Search users'), 'Ch');
    await user.click(screen.getByText('Charlie Brown'));

    // Charlie should now appear as a badge
    expect(screen.getByText('Charlie Brown')).toBeInTheDocument();
    // And the start button should be enabled
    expect(screen.getByText('Start Conversation')).toBeEnabled();
  });

  it('calls onOpenChange(false) when cancel is clicked', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDialog(true, onOpenChange);

    await user.click(screen.getByText('Cancel'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
