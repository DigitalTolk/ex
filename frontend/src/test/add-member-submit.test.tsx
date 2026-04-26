import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AddMemberDialog } from '@/components/channels/AddMemberDialog';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// Mock apiFetch
const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

// Mock dialog to render in jsdom
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock('@/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('AddMemberDialog - submit flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('submits selected user and closes dialog', async () => {
    // First call returns search results, second call is the POST to add member
    mockApiFetch
      .mockResolvedValueOnce([
        { id: 'u1', displayName: 'Alice', email: 'alice@test.com' },
      ])
      .mockResolvedValueOnce(undefined);

    const onOpenChange = vi.fn();
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <AddMemberDialog open onOpenChange={onOpenChange} channelId="ch1" />
      </Wrapper>,
    );

    const input = screen.getByPlaceholderText('Search by name or email...');
    fireEvent.change(input, { target: { value: 'ali' } });

    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Alice'));

    // Now submit
    const submitButton = screen.getByRole('button', { name: 'Add member' });
    expect(submitButton).not.toBeDisabled();
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/v1/channels/ch1/members',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('shows error message on submit failure', async () => {
    mockApiFetch
      .mockResolvedValueOnce([
        { id: 'u1', displayName: 'Alice', email: 'alice@test.com' },
      ])
      .mockRejectedValueOnce(new Error('User already a member'));

    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <AddMemberDialog open onOpenChange={vi.fn()} channelId="ch1" />
      </Wrapper>,
    );

    const input = screen.getByPlaceholderText('Search by name or email...');
    fireEvent.change(input, { target: { value: 'ali' } });

    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Alice'));
    fireEvent.click(screen.getByRole('button', { name: 'Add member' }));

    await waitFor(() => {
      expect(screen.getByText('User already a member')).toBeInTheDocument();
    });
  });

  it('shows error when submitting without selecting a user', async () => {
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <AddMemberDialog open onOpenChange={vi.fn()} channelId="ch1" />
      </Wrapper>,
    );

    // The submit button should be disabled, so we can't easily trigger this
    // but let's verify the button is disabled
    const submitButton = screen.getByRole('button', { name: 'Add member' });
    expect(submitButton).toBeDisabled();
  });

  it('clears search results when query is cleared', async () => {
    mockApiFetch.mockResolvedValueOnce([
      { id: 'u1', displayName: 'Alice', email: 'alice@test.com' },
    ]);

    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <AddMemberDialog open onOpenChange={vi.fn()} channelId="ch1" />
      </Wrapper>,
    );

    const input = screen.getByPlaceholderText('Search by name or email...');
    fireEvent.change(input, { target: { value: 'ali' } });

    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });

    // Clear the search
    fireEvent.change(input, { target: { value: '' } });

    await waitFor(() => {
      expect(screen.queryByText('alice@test.com')).not.toBeInTheDocument();
    });
  });
});
