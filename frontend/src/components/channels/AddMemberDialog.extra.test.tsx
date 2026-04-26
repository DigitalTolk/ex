import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

import { AddMemberDialog } from './AddMemberDialog';

function renderDialog(props: Partial<{ open: boolean; channelId: string; onOpenChange: (v: boolean) => void }> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AddMemberDialog
        open={props.open ?? true}
        onOpenChange={props.onOpenChange ?? vi.fn()}
        channelId={props.channelId ?? 'ch-1'}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AddMemberDialog - extra coverage', () => {
  it('clears results silently when search API fails (line 35 catch)', async () => {
    mockApiFetch.mockRejectedValue(new Error('search failed'));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderDialog();

    await user.type(screen.getByPlaceholderText('Search by name or email...'), 'al');
    vi.advanceTimersByTime(500);
    // No results listed (no buttons besides the form submit)
    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/users?q=al');
    });
  });

  it('shows error when submit clicked without selection (lines 44-45)', async () => {
    renderDialog();
    // The submit button is disabled when nothing selected; submit via form to bypass
    const form = screen.getByRole('button', { name: /add member/i }).closest('form');
    fireEvent.submit(form!);
    expect(await screen.findByText(/please select a user/i)).toBeInTheDocument();
  });

  it('successfully adds a member after selecting from results', async () => {
    // First call: search results
    mockApiFetch.mockResolvedValueOnce([
      { id: 'u-99', displayName: 'Alice', email: 'alice@x.com' },
    ]);
    // Second call: add member
    mockApiFetch.mockResolvedValueOnce({});

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange });

    await user.type(screen.getByPlaceholderText('Search by name or email...'), 'al');
    vi.advanceTimersByTime(500);

    const result = await screen.findByText('Alice');
    fireEvent.click(result);

    fireEvent.click(screen.getByRole('button', { name: /add member/i }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/v1/channels/ch-1/members',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('shows error when add-member API fails', async () => {
    mockApiFetch.mockResolvedValueOnce([
      { id: 'u-99', displayName: 'Alice', email: 'alice@x.com' },
    ]);
    mockApiFetch.mockRejectedValueOnce(new Error('forbidden'));

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderDialog();

    await user.type(screen.getByPlaceholderText('Search by name or email...'), 'al');
    vi.advanceTimersByTime(500);
    fireEvent.click(await screen.findByText('Alice'));
    fireEvent.click(screen.getByRole('button', { name: /add member/i }));

    expect(await screen.findByText('forbidden')).toBeInTheDocument();
  });
});
