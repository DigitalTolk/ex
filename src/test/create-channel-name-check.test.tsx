import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreateChannelDialog } from '@/components/channels/CreateChannelDialog';

// A name another channel holds shows as taken while it is typed, before
// Create is pressed.

const mockMutate = vi.fn();
vi.mock('@/hooks/useChannels', () => ({
  useCreateChannel: () => ({ mutate: mockMutate, isPending: false }),
}));

const mockApiFetch = vi.fn((url: string) =>
  // An answer without a body reads as free too.
  Promise.resolve(url === '/api/v1/channel-names/sales' ? { available: false } : url === '/api/v1/channel-names/ops' ? undefined : { available: true }),
);
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (url: string) => mockApiFetch(url),
}));

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <CreateChannelDialog open onOpenChange={vi.fn()} />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('CreateChannelDialog name check', () => {
  it('says a taken name is taken before Create is pressed', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText('Name'), 'sales');

    expect(await screen.findByText('~sales already exists')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Channel' })).toBeDisabled();
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('leaves a free name alone', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText('Name'), 'ops');
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/channel-names/ops'));
    expect(screen.queryByText('~ops already exists')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Channel' })).toBeEnabled();
  });
});
