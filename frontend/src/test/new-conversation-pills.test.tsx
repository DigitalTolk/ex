import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/hooks/useConversations', () => ({
  useCreateConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useSearchUsers: () => ({
    data: [{ id: 'u-2', displayName: 'Bob', email: 'bob@x.com' }],
  }),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-1', displayName: 'Me', email: 'me@x.com' } }),
}));

import { NewConversationDialog } from '@/components/conversations/NewConversationDialog';

describe('NewConversationDialog — participant pills', () => {
  it('renders selected participants as 14px (text-sm) pills', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <NewConversationDialog open onOpenChange={vi.fn()} />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getByLabelText('Search users'), {
      target: { value: 'bo' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Bob/ }));

    const pill = screen.getByTestId('participant-pill');
    expect(pill.className).toContain('text-sm');
  });
});
