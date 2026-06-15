import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AddMemberDialog } from './AddMemberDialog';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>,
  );
}

describe('AddMemberDialog', () => {
  beforeEach(() => apiFetchMock.mockReset());

  it('renders form when open', () => {
    renderWithProviders(
      <AddMemberDialog open={true} onOpenChange={() => {}} channelId="ch-1" />,
    );

    expect(screen.getByRole('heading', { name: 'Add member' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add member' })).toBeInTheDocument();
  });

  it('shows search input', () => {
    renderWithProviders(
      <AddMemberDialog open={true} onOpenChange={() => {}} channelId="ch-1" />,
    );

    expect(screen.getByPlaceholderText('Search by name or email...')).toBeInTheDocument();
  });

  it('requires selecting a user before submitting', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <AddMemberDialog open={true} onOpenChange={() => {}} channelId="ch-1" />,
    );
    // The form requires a selectedUser; submitting without one surfaces a hint.
    const input = screen.getByPlaceholderText('Search by name or email...');
    await user.type(input, 'bo');
    // (the native `required` attr blocks a click-submit, so submit the form)
    fireEvent.submit(document.querySelector('form')!);
    expect(await screen.findByText('Please select a user from the search results')).toBeInTheDocument();
  });

  it('shows a generic error when the add request rejects with a non-Error', async () => {
    const user = userEvent.setup();
    apiFetchMock.mockImplementation((_url: string, opts?: { method?: string }) => {
      // The POST to add the member rejects with a non-Error value;
      // the debounced search (no options) resolves with one match.
      if (opts?.method === 'POST') return Promise.reject('boom-string');
      return Promise.resolve([{ id: 'u-9', displayName: 'Bob', email: 'bob@x.com' }]);
    });
    renderWithProviders(
      <AddMemberDialog open={true} onOpenChange={() => {}} channelId="ch-1" />,
    );
    await user.type(screen.getByPlaceholderText('Search by name or email...'), 'bob');
    // Debounced search resolves → result button appears → select it.
    await user.click(await screen.findByText('Bob'));
    await user.click(screen.getByRole('button', { name: 'Add member' }));
    expect(await screen.findByText('Failed to add member')).toBeInTheDocument();
  });
});
