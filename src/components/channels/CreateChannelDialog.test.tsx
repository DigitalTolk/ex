import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
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

  it('says the name is taken under the name field when the server answers 409', async () => {
    const user = userEvent.setup();
    mockMutate.mockImplementation((_vars, opts) => {
      opts.onError(new ApiError(409, 'channel: a channel with this name already exists: service: already exists'));
    });
    renderDialog(true);

    const name = screen.getByLabelText('Name');
    await user.type(name, 'Marketing');
    await user.click(screen.getByText('Create Channel'));

    expect(screen.getByTestId('channel-name-help')).toHaveTextContent('~marketing already exists');
    expect(screen.getByRole('alert')).toBe(screen.getByTestId('channel-name-help'));
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('channel-submit-error')).not.toHaveTextContent('channel:');
    expect(screen.getByRole('button', { name: 'Create Channel' })).toBeDisabled();

    // Another name clears it; going back to the taken one brings it back.
    await user.type(name, '-2');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Create Channel' })).toBeEnabled();
    await user.type(name, '{Backspace}{Backspace}');
    expect(screen.getByRole('alert')).toHaveTextContent('~marketing already exists');
  });

  it('shows any other server refusal in the bottom slot', async () => {
    const user = userEvent.setup();
    mockMutate.mockImplementation((_vars, opts) => {
      opts.onError(new ApiError(403, 'channel: guests cannot create channels'));
    });
    renderDialog(true);

    await user.type(screen.getByLabelText('Name'), 'marketing');
    await user.click(screen.getByText('Create Channel'));

    expect(screen.getByRole('alert')).toBe(screen.getByTestId('channel-submit-error'));
    expect(screen.getByRole('alert')).toHaveTextContent('channel: guests cannot create channels');
    expect(screen.getByTestId('channel-name-help')).not.toHaveTextContent('already exists');
  });

  it('turns a typed title into the channel name as it is typed', async () => {
    const user = userEvent.setup();
    renderDialog(true);

    const name = screen.getByLabelText('Name') as HTMLInputElement;
    await user.type(name, 'Marketing ');
    expect(name.value).toBe('marketing-');
    await user.type(name, 'Team & Sales!');
    expect(name.value).toBe('marketing-team-and-sales-');
    expect(screen.getByTestId('channel-name-counter')).toHaveTextContent('24/32');
    expect(screen.queryByRole('alert')).toBeNull();

    await user.click(screen.getByText('Create Channel'));
    expect(mockMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'marketing-team-and-sales' }),
      expect.anything(),
    );
    expect(name.value).toBe('marketing-team-and-sales');
  });

  it('drops the trailing hyphen when the field is left', async () => {
    const user = userEvent.setup();
    renderDialog(true);

    const name = screen.getByLabelText('Name') as HTMLInputElement;
    await user.type(name, 'design ');
    expect(name.value).toBe('design-');
    await user.tab();
    expect(name.value).toBe('design');
  });

  it('cannot create a channel from text that has no channel name in it', async () => {
    const user = userEvent.setup();
    renderDialog(true);

    const name = screen.getByLabelText('Name') as HTMLInputElement;
    await user.type(name, '!? ');
    expect(name.value).toBe('');
    expect(screen.getByRole('button', { name: 'Create Channel' })).toBeDisabled();
  });

  it('does not submit while the description is over its limit', async () => {
    const user = userEvent.setup();
    renderDialog(true);

    await user.type(screen.getByLabelText('Name'), 'general');
    await user.click(screen.getByLabelText(/Description/));
    await user.paste('a'.repeat(256));
    fireEvent.submit(document.querySelector('form')!);
    expect(mockMutate).not.toHaveBeenCalled();
  });
});
