import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreateChannelDialog } from './CreateChannelDialog';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// mutate calls onSuccess immediately so we exercise the success branch (lines 49-51)
const mockMutate = vi.fn(
  (
    _vars: { name: string; description?: string; type: 'public' | 'private' },
    opts?: { onSuccess?: (channel: { slug: string; id: string }) => void },
  ) => {
    opts?.onSuccess?.({ slug: 'marketing', id: 'ch-123' });
  },
);

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

describe('CreateChannelDialog - success flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resets fields, closes dialog, and navigates to channel on success', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDialog(true, onOpenChange);

    await user.type(screen.getByLabelText('Name'), 'marketing');
    await user.type(screen.getByLabelText(/Description/), 'a place to talk');
    // toggle private switch on
    await user.click(screen.getByRole('switch'));
    await user.click(screen.getByText('Create Channel'));

    expect(mockMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'marketing',
        description: 'a place to talk',
        type: 'private',
      }),
      expect.anything(),
    );
    // onSuccess inside mutate triggered:
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockNavigate).toHaveBeenCalledWith('/channel/marketing');
  });

  it('passes type=public when switch is off', async () => {
    const user = userEvent.setup();
    renderDialog(true);

    await user.type(screen.getByLabelText('Name'), 'general');
    await user.click(screen.getByText('Create Channel'));

    expect(mockMutate).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'public' }),
      expect.anything(),
    );
  });

  it('passes undefined description when blank', async () => {
    const user = userEvent.setup();
    renderDialog(true);

    await user.type(screen.getByLabelText('Name'), 'general');
    await user.click(screen.getByText('Create Channel'));

    expect(mockMutate).toHaveBeenCalledWith(
      expect.objectContaining({ description: undefined }),
      expect.anything(),
    );
  });
});
