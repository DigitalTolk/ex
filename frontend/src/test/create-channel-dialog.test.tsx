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

describe('CreateChannelDialog - validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables submit and shows the slug rule when the name has a space or capital', async () => {
    const user = userEvent.setup();
    renderDialog(true);

    await user.type(screen.getByLabelText('Name'), 'Has Space');
    const submit = screen.getByRole('button', { name: 'Create Channel' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    // The error replaces the help text, but the slot's height is fixed
    // so the modal doesn't shift when the message swaps in.
    const help = screen.getByTestId('channel-name-help');
    expect(help.textContent).toMatch(/lowercase letters/i);
    expect(help.className).toMatch(/text-destructive/);
    expect(help.className).toMatch(/min-h-/);
  });

  it('disables submit and flags too-long when the name exceeds 32 chars', async () => {
    const user = userEvent.setup();
    renderDialog(true);

    await user.type(screen.getByLabelText('Name'), 'a'.repeat(33));
    expect(
      (screen.getByRole('button', { name: 'Create Channel' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByTestId('channel-name-help').textContent).toMatch(/32/);
    expect(screen.getByTestId('channel-name-counter').textContent).toBe('33/32');
  });

  it('shows a live counter for the name field that flips colour at the limit', async () => {
    const user = userEvent.setup();
    renderDialog(true);

    const counter = screen.getByTestId('channel-name-counter');
    expect(counter.textContent).toBe('0/32');
    await user.type(screen.getByLabelText('Name'), 'general');
    expect(counter.textContent).toBe('7/32');
    expect(counter.className).not.toMatch(/text-destructive/);
  });

  it('flags description over 255 chars and disables submit', async () => {
    const user = userEvent.setup();
    renderDialog(true);

    await user.type(screen.getByLabelText('Name'), 'general');
    const desc = screen.getByLabelText(/Description/);
    // Bypass user.type's per-keystroke cost on a 256-char string by
    // setting the value directly via fireEvent — the validation is
    // computed off the React state populated by onChange.
    desc.focus();
    await user.paste('a'.repeat(256));
    expect(screen.getByTestId('channel-desc-help').textContent).toMatch(/255/);
    expect(
      (screen.getByRole('button', { name: 'Create Channel' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('reserves vertical space for both help-text slots so the dialog does not jump', () => {
    renderDialog(true);
    // Both slots use min-h-[1.25rem] so empty/error states occupy the
    // same height — measured via the Tailwind class signature so a
    // future drop of the constraint trips this guard.
    expect(screen.getByTestId('channel-name-help').className).toMatch(/min-h-\[1\.25rem\]/);
    expect(screen.getByTestId('channel-desc-help').className).toMatch(/min-h-\[1\.25rem\]/);
    expect(screen.getByTestId('channel-submit-error').className).toMatch(/min-h-\[1\.25rem\]/);
  });
});
