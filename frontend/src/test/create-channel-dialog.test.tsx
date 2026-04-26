import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreateChannelDialog } from '@/components/channels/CreateChannelDialog';

const mockMutate = vi.fn();

vi.mock('@/hooks/useChannels', () => ({
  useCreateChannel: () => ({ mutate: mockMutate, isPending: false }),
}));

function renderDialog(open = true, onOpenChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <CreateChannelDialog open={open} onOpenChange={onOpenChange} />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('CreateChannelDialog - private toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates private channel when switch is toggled', async () => {
    const user = userEvent.setup();
    renderDialog(true);

    await user.type(screen.getByLabelText('Name'), 'secret-room');
    await user.click(screen.getByRole('switch'));
    await user.click(screen.getByText('Create Channel'));

    expect(mockMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'secret-room', type: 'private' }),
      expect.anything(),
    );
  });

  it('sends description when provided', async () => {
    const user = userEvent.setup();
    renderDialog(true);

    await user.type(screen.getByLabelText('Name'), 'dev');
    await user.type(screen.getByLabelText(/Description/), 'Dev talk');
    await user.click(screen.getByText('Create Channel'));

    expect(mockMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'dev',
        description: 'Dev talk',
        type: 'public',
      }),
      expect.anything(),
    );
  });
});
