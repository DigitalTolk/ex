import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AddMemberDialog } from '@/components/channels/AddMemberDialog';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// Mock apiFetch
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
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

describe('AddMemberDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders search input when open', () => {
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <AddMemberDialog open onOpenChange={() => {}} channelId="ch1" />
      </Wrapper>,
    );
    expect(screen.getByPlaceholderText('Search by name or email...')).toBeInTheDocument();
  });

  it('debounces search and shows results', async () => {
    const { apiFetch } = await import('@/lib/api');
    const mockFetch = vi.mocked(apiFetch);
    mockFetch.mockResolvedValue([
      { id: 'u1', displayName: 'Alice', email: 'alice@test.com' },
      { id: 'u2', displayName: 'Bob', email: 'bob@test.com' },
    ]);

    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <AddMemberDialog open onOpenChange={() => {}} channelId="ch1" />
      </Wrapper>,
    );

    const input = screen.getByPlaceholderText('Search by name or email...');
    fireEvent.change(input, { target: { value: 'ali' } });

    // Wait for debounce + results
    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });
    expect(screen.getByText('alice@test.com')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('selects user from results', async () => {
    const { apiFetch } = await import('@/lib/api');
    const mockFetch = vi.mocked(apiFetch);
    mockFetch.mockResolvedValue([
      { id: 'u1', displayName: 'Alice', email: 'alice@test.com' },
    ]);

    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <AddMemberDialog open onOpenChange={() => {}} channelId="ch1" />
      </Wrapper>,
    );

    const input = screen.getByPlaceholderText('Search by name or email...');
    fireEvent.change(input, { target: { value: 'ali' } });

    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Alice'));

    // Input should now show the selected user's name
    expect(input).toHaveValue('Alice');
  });

  it('does not search for queries shorter than 2 chars', async () => {
    const { apiFetch } = await import('@/lib/api');
    const mockFetch = vi.mocked(apiFetch);

    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <AddMemberDialog open onOpenChange={() => {}} channelId="ch1" />
      </Wrapper>,
    );

    const input = screen.getByPlaceholderText('Search by name or email...');
    fireEvent.change(input, { target: { value: 'a' } });

    // Wait a bit to ensure no call is made
    await new Promise(r => setTimeout(r, 400));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('submit button is disabled without a selected user', () => {
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <AddMemberDialog open onOpenChange={() => {}} channelId="ch1" />
      </Wrapper>,
    );
    const submitButton = screen.getByRole('button', { name: 'Add member' });
    expect(submitButton).toBeDisabled();
  });
});
