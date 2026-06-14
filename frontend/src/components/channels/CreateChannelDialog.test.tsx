import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreateChannelDialog } from './CreateChannelDialog';

const mockMutate = vi.fn();
let mockIsPending = false;

vi.mock('@/hooks/useChannels', () => ({
  useCreateChannel: () => ({ mutate: mockMutate, isPending: mockIsPending }),
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

describe('CreateChannelDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPending = false;
  });

  it('renders dialog title when open', () => {
    renderDialog(true);
    expect(screen.getByText('Create a channel')).toBeInTheDocument();
  });

  it('does not render dialog content when closed', () => {
    renderDialog(false);
    expect(screen.queryByText('Create a channel')).not.toBeInTheDocument();
  });

  it('has a name input field', () => {
    renderDialog(true);
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
  });

  it('has a description input field', () => {
    renderDialog(true);
    expect(screen.getByLabelText(/Description/)).toBeInTheDocument();
  });

  it('has a private switch', () => {
    renderDialog(true);
    expect(screen.getByRole('switch')).toBeInTheDocument();
    expect(screen.getByText('Make private')).toBeInTheDocument();
  });

  it('has a create button', () => {
    renderDialog(true);
    expect(screen.getByText('Create Channel')).toBeInTheDocument();
  });

  it('has a cancel button', () => {
    renderDialog(true);
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('calls onOpenChange(false) when cancel is clicked', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDialog(true, onOpenChange);

    await user.click(screen.getByText('Cancel'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('calls mutate when form is submitted with a name', async () => {
    const user = userEvent.setup();
    renderDialog(true);

    await user.type(screen.getByLabelText('Name'), 'marketing');
    await user.click(screen.getByText('Create Channel'));

    expect(mockMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'marketing', type: 'public' }),
      expect.anything(),
    );
  });

  it('does not call mutate when name is empty', async () => {
    const user = userEvent.setup();
    renderDialog(true);

    await user.click(screen.getByText('Create Channel'));
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('returns early on a direct form submit with an empty name', () => {
    renderDialog(true);
    fireEvent.submit(document.querySelector('form')!);
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('returns early when the name fails validation', async () => {
    const user = userEvent.setup();
    renderDialog(true);
    // A 200-char name exceeds MAX_CHANNEL_NAME_LEN → nameError is set, so a
    // direct submit short-circuits before calling mutate.
    await user.type(screen.getByLabelText('Name'), 'a'.repeat(200));
    fireEvent.submit(document.querySelector('form')!);
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when onError gets a non-Error', async () => {
    const user = userEvent.setup();
    mockMutate.mockImplementation((_vars, opts) => {
      opts.onError('plain string failure');
    });
    renderDialog(true);
    await user.type(screen.getByLabelText('Name'), 'marketing');
    await user.click(screen.getByText('Create Channel'));
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to create channel');
  });

  it('shows the pending label while the mutation is in flight', () => {
    mockIsPending = true;
    renderDialog(true);
    expect(screen.getByText('Creating...')).toBeInTheDocument();
  });

  it('shows the backend duplicate-name message without raw JSON', async () => {
    const user = userEvent.setup();
    mockMutate.mockImplementation((_vars, opts) => {
      opts.onError(new Error('channel: a channel with this name already exists'));
    });
    renderDialog(true);

    await user.type(screen.getByLabelText('Name'), 'marketing');
    await user.click(screen.getByText('Create Channel'));

    expect(screen.getByRole('alert')).toHaveTextContent('channel: a channel with this name already exists');
    expect(screen.getByRole('alert')).not.toHaveTextContent('{"error"');
  });
});
