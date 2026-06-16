import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NonMemberInvitePrompt } from './NonMemberInvitePrompt';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));

function renderPrompt(props: Partial<React.ComponentProps<typeof NonMemberInvitePrompt>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onDismiss = props.onDismiss ?? vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <NonMemberInvitePrompt
        channelId="ch-1"
        channelName="incidents"
        users={[{ id: 'u-jeff', displayName: 'Jeff Bozo' }]}
        onDismiss={onDismiss}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onDismiss };
}

beforeEach(() => {
  mockApiFetch.mockReset();
  mockApiFetch.mockResolvedValue(undefined);
});

describe('NonMemberInvitePrompt', () => {
  it('names a single non-member and adds them on click', async () => {
    const { onDismiss } = renderPrompt();
    expect(screen.getByText('Jeff Bozo')).toBeInTheDocument();
    expect(screen.getByText(/isn't in ~incidents/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add to channel' }));
    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/v1/channels/ch-1/members',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ userID: 'u-jeff', role: 'member' }) }),
      ),
    );
    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
  });

  it('adds multiple mentioned non-members at once', async () => {
    const { onDismiss } = renderPrompt({
      users: [
        { id: 'u-a', displayName: 'Alice' },
        { id: 'u-b', displayName: 'Bob' },
      ],
    });
    expect(screen.getByText(/aren't in ~incidents/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add all (2)' }));
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
  });

  it('shows an error and keeps the prompt open when adding fails', async () => {
    mockApiFetch.mockRejectedValueOnce(new Error('nope'));
    const { onDismiss } = renderPrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Add to channel' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('nope'));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('dismisses without adding', () => {
    const { onDismiss } = renderPrompt();
    fireEvent.click(screen.getByLabelText('Dismiss invite suggestion'));
    expect(onDismiss).toHaveBeenCalled();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('renders nothing when there are no mentioned non-members', () => {
    renderPrompt({ users: [] });
    expect(screen.queryByTestId('non-member-invite')).toBeNull();
  });

  it('renders nothing for a conversation (no channelId)', () => {
    renderPrompt({ channelId: undefined });
    expect(screen.queryByTestId('non-member-invite')).toBeNull();
  });
});
