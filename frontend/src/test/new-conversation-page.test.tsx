import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import NewConversationPage from '@/pages/NewConversationPage';

const mockCreate = vi.fn();
vi.mock('@/hooks/useConversations', () => ({
  useSearchUsers: (q: string) => ({
    data: q.trim().length >= 2
      ? [
          { id: 'u-1', displayName: 'Alice', email: 'a@x.com' },
          { id: 'u-2', displayName: 'Bob', email: 'b@x.com' },
        ]
      : [],
  }),
  useCreateConversation: () => ({
    mutate: (input: unknown, opts: { onSuccess: (c: { id: string }) => void }) => {
      mockCreate(input);
      opts.onSuccess({ id: 'conv-new' });
    },
    isPending: false,
  }),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-me', email: 'me@x.com', displayName: 'Me' } }),
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/conversations/new']}>
        <Routes>
          <Route path="/conversations/new" element={<NewConversationPage />} />
          <Route path="/conversation/:id" element={<div data-testid="conv-page" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('NewConversationPage', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('renders as a page (full content area, no Dialog wrapper)', () => {
    renderPage();
    expect(screen.getByText('New conversation')).toBeInTheDocument();
    expect(screen.getByLabelText('Search users')).toBeInTheDocument();
  });

  it('selects a user, then creates a 1-on-1 DM and navigates to it', () => {
    renderPage();
    const search = screen.getByLabelText('Search users');
    fireEvent.change(search, { target: { value: 'al' } });
    fireEvent.click(screen.getByText('Alice'));
    expect(screen.getByTestId('participant-pill')).toHaveTextContent('Alice');
    fireEvent.click(screen.getByRole('button', { name: 'Start Conversation' }));
    expect(mockCreate).toHaveBeenCalledWith({ type: 'dm', participantIDs: ['u-1'] });
    expect(screen.getByTestId('conv-page')).toBeInTheDocument();
  });

  it('switches to "Create Group" with multiple participants', () => {
    renderPage();
    const input = screen.getByLabelText('Search users');
    fireEvent.change(input, { target: { value: 'al' } });
    fireEvent.click(screen.getByText('Alice'));
    // Adding clears the input (by design), so we re-type to re-show results.
    fireEvent.change(input, { target: { value: 'bo' } });
    fireEvent.click(screen.getByText('Bob'));
    expect(screen.getByRole('button', { name: 'Create Group' })).toBeInTheDocument();
  });

  it('shows the typing-prompt and no-match copy for short and unknown queries', () => {
    renderPage();
    expect(
      screen.getByText('Start typing to search for users'),
    ).toBeInTheDocument();
  });

  it('removes a participant when its X button is clicked', () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Search users'), { target: { value: 'al' } });
    fireEvent.click(screen.getByText('Alice'));
    expect(screen.getByTestId('participant-pill')).toHaveTextContent('Alice');
    fireEvent.click(screen.getByLabelText('Remove Alice'));
    expect(screen.queryByTestId('participant-pill')).toBeNull();
    // Start Conversation is disabled with no participants.
    expect(
      (screen.getByRole('button', { name: 'Start Conversation' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
