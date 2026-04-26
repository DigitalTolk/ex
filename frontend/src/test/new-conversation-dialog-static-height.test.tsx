import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';

let mockResults: { id: string; email: string; displayName: string }[] = [];
vi.mock('@/hooks/useConversations', () => ({
  useCreateConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useSearchUsers: () => ({ data: mockResults }),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-me', displayName: 'Me', email: 'me@x.com' } }),
}));

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { NewConversationDialog } from '@/components/conversations/NewConversationDialog';

function renderDialog() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <BrowserRouter>
        <NewConversationDialog open onOpenChange={vi.fn()} />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('NewConversationDialog — static height', () => {
  it('reserves a fixed-height results region with the same class regardless of result count', () => {
    mockResults = [];
    const { unmount } = renderDialog();
    const empty = screen.getByTestId('results-region');
    const emptyClass = empty.className;
    expect(emptyClass).toContain('h-72');
    unmount();

    mockResults = Array.from({ length: 12 }, (_, i) => ({
      id: `u-${i}`,
      email: `u${i}@x.com`,
      displayName: `User ${i}`,
    }));
    renderDialog();
    const filled = screen.getByTestId('results-region');
    expect(filled.className).toBe(emptyClass);
  });

  it('shows a placeholder copy when no search has been entered', () => {
    mockResults = [];
    renderDialog();
    expect(
      screen.getByText(/Start typing to search for users/i),
    ).toBeInTheDocument();
  });
});
