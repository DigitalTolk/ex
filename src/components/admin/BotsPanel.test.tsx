import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BotsPanel } from './BotsPanel';
import type { Bot, BotToken } from '@/hooks/useBots';

// The bot admin panel. Its job is credential handling (a token's plaintext is
// shown exactly once), the internal/external/system distinction, and making a
// failed action visible — a silent failure here reads as "the button is broken".

const mocks = vi.hoisted(() => ({
  useBots: vi.fn(),
  useBotTokens: vi.fn(),
  createBot: vi.fn(),
  deleteBot: vi.fn(),
  setWebhook: vi.fn(),
  createToken: vi.fn(),
  revokeToken: vi.fn(),
  state: {
    createBot: { isPending: false, isError: false, error: null as unknown },
    deleteBot: { isPending: false, isError: false, error: null as unknown },
    setWebhook: { isPending: false, isError: false, error: null as unknown },
    createToken: { isPending: false },
    revokeToken: { isError: false, error: null as unknown },
  },
}));

vi.mock('@/hooks/useBots', () => ({
  useBots: mocks.useBots,
  useBotTokens: mocks.useBotTokens,
  useCreateBot: () => ({ mutate: mocks.createBot, ...mocks.state.createBot }),
  useDeleteBot: () => ({ mutate: mocks.deleteBot, ...mocks.state.deleteBot }),
  useSetBotWebhook: () => ({ mutate: mocks.setWebhook, ...mocks.state.setWebhook }),
  useCreateBotToken: () => ({ mutate: mocks.createToken, ...mocks.state.createToken }),
  useRevokeBotToken: () => ({ mutate: mocks.revokeToken, ...mocks.state.revokeToken }),
}));

vi.mock('@/lib/clipboard', () => ({ copyToClipboard: vi.fn().mockResolvedValue(undefined) }));

function makeBot(over: Partial<Bot> = {}): Bot {
  return {
    user_id: 'bot_1',
    name: 'Helper',
    created_by: 'u-adm',
    create_at: '2026-01-01T00:00:00Z',
    update_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function makeToken(over: Partial<BotToken> = {}): BotToken {
  return {
    token_id: 'tid-1',
    bot_user_id: 'bot_1',
    label: 'production',
    create_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

// expand opens a bot's row so its detail panel renders.
function expand(name: string) {
  fireEvent.click(screen.getByText(name).closest('button')!);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.createBot = { isPending: false, isError: false, error: null };
  mocks.state.deleteBot = { isPending: false, isError: false, error: null };
  mocks.state.setWebhook = { isPending: false, isError: false, error: null };
  mocks.state.createToken = { isPending: false };
  mocks.state.revokeToken = { isError: false, error: null };
  mocks.useBots.mockReturnValue({ data: [] });
  mocks.useBotTokens.mockReturnValue({ data: [] });
});

describe('BotsPanel', () => {
  it('shows an empty state', () => {
    render(<BotsPanel />);
    expect(screen.getByText('No bots yet.')).toBeInTheDocument();
  });

  it('creates a bot and clears the form', async () => {
    mocks.createBot.mockImplementation((_input, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
    render(<BotsPanel />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Jira bot  ' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: ' files tickets ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create bot' }));

    // Trimmed on the way out — a name is a display value, not free-form input.
    expect(mocks.createBot.mock.calls[0][0]).toEqual({ name: 'Jira bot', description: 'files tickets' });
    await waitFor(() => expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(''));
  });

  it('disables create without a name and surfaces a create failure', () => {
    mocks.state.createBot = { isPending: false, isError: true, error: new Error('name is taken') };
    render(<BotsPanel />);
    expect(screen.getByRole('button', { name: 'Create bot' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('name is taken');
  });

  it('shows a pending create', () => {
    mocks.state.createBot = { isPending: true, isError: false, error: null };
    render(<BotsPanel />);
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled();
  });

  it('labels bots internal, external, or system', () => {
    mocks.useBots.mockReturnValue({
      data: [
        makeBot({ user_id: 'bot_int', name: 'Internal' }),
        makeBot({ user_id: 'bot_ext', name: 'External', callback_url: 'https://bot.example.com/hook' }),
        makeBot({ user_id: 'bot_cliffy', name: 'Cliffy', created_by: 'system' }),
      ],
    });
    render(<BotsPanel />);
    expect(screen.getByText('internal')).toBeInTheDocument();
    expect(screen.getByText('external')).toBeInTheDocument();
    expect(screen.getByText('system')).toBeInTheDocument();
    expect(screen.getByText('bot_int')).toBeInTheDocument();
  });

  it('shows built-in bots read-only', () => {
    // A system bot is wired in code — an admin didn't add it and shouldn't be
    // able to delete or reconfigure it here.
    mocks.useBots.mockReturnValue({ data: [makeBot({ name: 'Cliffy', created_by: 'system' })] });
    render(<BotsPanel />);
    expand('Cliffy');
    expect(screen.getByText(/built-in bot managed by ex/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete bot/ })).toBeNull();
    expect(screen.queryByLabelText('Callback URL')).toBeNull();
  });

  it('reveals an issued token exactly once', () => {
    mocks.useBots.mockReturnValue({ data: [makeBot()] });
    mocks.createToken.mockImplementation((_label, opts?: { onSuccess?: (t: unknown) => void }) =>
      opts?.onSuccess?.({ ...makeToken(), token: 'exbot_the_secret' }),
    );
    render(<BotsPanel />);
    expand('Helper');

    fireEvent.change(screen.getByPlaceholderText('Label (e.g. production)'), { target: { value: ' prod ' } });
    fireEvent.click(screen.getByRole('button', { name: /Issue token/ }));

    expect(mocks.createToken).toHaveBeenCalledWith('prod', expect.anything());
    // Shown once, with a copy affordance, because it is unrecoverable afterwards.
    expect(screen.getByText('exbot_the_secret')).toBeInTheDocument();
    expect(screen.getByText(/copy it now, it won't be shown again/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy secret' })).toBeInTheDocument();
  });

  it('lists tokens and only offers revoke for live ones', () => {
    mocks.useBots.mockReturnValue({ data: [makeBot()] });
    mocks.useBotTokens.mockReturnValue({
      data: [
        makeToken({ token_id: 'tid-live', label: 'live' }),
        makeToken({ token_id: 'tid-dead', label: 'dead', revoked_at: '2026-02-01T00:00:00Z' }),
      ],
    });
    render(<BotsPanel />);
    expand('Helper');

    expect(screen.getByRole('button', { name: 'Revoke live' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke dead' })).toBeNull();
    expect(screen.getByText('revoked')).toBeInTheDocument();
  });

  it('revokes a token after confirmation', async () => {
    mocks.useBots.mockReturnValue({ data: [makeBot()] });
    mocks.useBotTokens.mockReturnValue({ data: [makeToken({ token_id: 'tid-live', label: 'live' })] });
    render(<BotsPanel />);
    expand('Helper');

    fireEvent.click(screen.getByRole('button', { name: 'Revoke live' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    expect(mocks.revokeToken).toHaveBeenCalledWith('tid-live');
  });

  it('shows an empty token list', () => {
    mocks.useBots.mockReturnValue({ data: [makeBot()] });
    render(<BotsPanel />);
    expand('Helper');
    expect(screen.getByText('No tokens yet.')).toBeInTheDocument();
  });

  it('saves the webhook with its transport and trigger words', () => {
    mocks.useBots.mockReturnValue({ data: [makeBot()] });
    mocks.setWebhook.mockImplementation((_input, opts?: { onSuccess?: (r: unknown) => void }) =>
      opts?.onSuccess?.({ ok: true, signing_secret: 'exwhsec_shown_once' }),
    );
    render(<BotsPanel />);
    expand('Helper');

    fireEvent.change(screen.getByLabelText('Callback URL'), {
      target: { value: ' https://bot.example.com/hook ' },
    });
    fireEvent.change(screen.getByLabelText('Payload format'), { target: { value: 'mattermost' } });
    // Commas and whitespace both separate: a trigger word can contain neither.
    fireEvent.change(screen.getByLabelText('Trigger words'), {
      target: { value: 'deploy, status  rollout' },
    });
    fireEvent.click(screen.getByLabelText(/Match anywhere in the message/));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(mocks.setWebhook.mock.calls[0][0]).toEqual({
      id: 'bot_1',
      callback_url: 'https://bot.example.com/hook',
      transport: 'mattermost',
      trigger_words: ['deploy', 'status', 'rollout'],
      trigger_when: 1,
    });
    // The shared secret is revealed once so the receiver can be configured.
    expect(screen.getByText('exwhsec_shown_once')).toBeInTheDocument();
  });

  it('explains each payload format', () => {
    mocks.useBots.mockReturnValue({ data: [makeBot()] });
    render(<BotsPanel />);
    expand('Helper');

    expect(screen.getByText(/HMAC X-Ex-Signature/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Payload format'), { target: { value: 'mattermost' } });
    expect(screen.getByText(/existing Mattermost bot/)).toBeInTheDocument();
  });

  it('pre-fills the webhook form from the bot', () => {
    mocks.useBots.mockReturnValue({
      data: [
        makeBot({
          callback_url: 'https://bot.example.com/hook',
          transport: 'mattermost',
          trigger_words: ['deploy', 'status'],
          trigger_when: 1,
        }),
      ],
    });
    render(<BotsPanel />);
    expand('Helper');

    expect((screen.getByLabelText('Callback URL') as HTMLInputElement).value).toBe(
      'https://bot.example.com/hook',
    );
    expect((screen.getByLabelText('Payload format') as HTMLSelectElement).value).toBe('mattermost');
    expect((screen.getByLabelText('Trigger words') as HTMLInputElement).value).toBe('deploy, status');
    expect(screen.getByLabelText(/Match anywhere in the message/)).toBeChecked();
  });

  it('surfaces a webhook save failure', () => {
    mocks.useBots.mockReturnValue({ data: [makeBot()] });
    mocks.state.setWebhook = {
      isPending: false,
      isError: true,
      error: new Error('callback URL must be https'),
    };
    render(<BotsPanel />);
    expand('Helper');
    expect(screen.getByText('callback URL must be https')).toBeInTheDocument();
  });

  it('deletes a bot after confirmation', async () => {
    mocks.useBots.mockReturnValue({ data: [makeBot()] });
    render(<BotsPanel />);
    expand('Helper');

    fireEvent.click(screen.getByRole('button', { name: /Delete bot/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete bot' }));
    expect(mocks.deleteBot).toHaveBeenCalledWith('bot_1');
  });

  it('surfaces a delete failure instead of failing silently', () => {
    // A silent failure is why "the bot cannot be deleted" looked like a dead
    // button; a 404 additionally hints that the API may be out of date.
    mocks.useBots.mockReturnValue({ data: [makeBot()] });
    mocks.state.deleteBot = { isPending: false, isError: true, error: new Error('404 not found') };
    render(<BotsPanel />);
    expand('Helper');

    const note = screen.getByTestId('bot-action-error');
    expect(note).toHaveTextContent(/wasn't found on the server/);
    expect(note).toHaveTextContent(/restart the server/);
  });

  it('surfaces a revoke failure and a non-Error rejection', () => {
    mocks.useBots.mockReturnValue({ data: [makeBot()] });
    mocks.state.revokeToken = { isError: true, error: 'some non-Error value' };
    render(<BotsPanel />);
    expand('Helper');
    expect(screen.getByTestId('bot-action-error')).toHaveTextContent('That action failed');
  });

  it('disables delete while it is in flight', () => {
    mocks.useBots.mockReturnValue({ data: [makeBot()] });
    mocks.state.deleteBot = { isPending: true, isError: false, error: null };
    render(<BotsPanel />);
    expand('Helper');
    expect(screen.getByRole('button', { name: /Delete bot/ })).toBeDisabled();
  });

  it('collapses a row again', () => {
    mocks.useBots.mockReturnValue({ data: [makeBot()] });
    render(<BotsPanel />);
    expand('Helper');
    expect(screen.getByLabelText('Callback URL')).toBeInTheDocument();
    expand('Helper');
    expect(screen.queryByLabelText('Callback URL')).toBeNull();
  });

  it('shows a description when the bot has one', () => {
    mocks.useBots.mockReturnValue({ data: [makeBot({ description: 'files tickets' })] });
    render(<BotsPanel />);
    expand('Helper');
    expect(screen.getByText('files tickets')).toBeInTheDocument();
  });

  it('copies a revealed secret to the clipboard', async () => {
    const { copyToClipboard } = await import('@/lib/clipboard');
    mocks.useBots.mockReturnValue({ data: [makeBot()] });
    mocks.createToken.mockImplementation((_label, opts?: { onSuccess?: (t: unknown) => void }) =>
      opts?.onSuccess?.({ ...makeToken(), token: 'exbot_copy_me' }),
    );
    render(<BotsPanel />);
    expand('Helper');
    fireEvent.click(screen.getByRole('button', { name: /Issue token/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Copy secret' }));
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith('exbot_copy_me'));
    // The button confirms, then reverts.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument());
  });

  // Both ConfirmDialogs are always mounted, so each cancel is exercised in its
  // own render to keep the "Cancel" button unambiguous.
  it('cancelling the revoke dialog does not revoke', async () => {
    mocks.useBots.mockReturnValue({ data: [makeBot()] });
    mocks.useBotTokens.mockReturnValue({ data: [makeToken({ token_id: 'tid-live', label: 'live' })] });
    render(<BotsPanel />);
    expand('Helper');

    fireEvent.click(screen.getByRole('button', { name: 'Revoke live' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByTestId('confirm-dialog-cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.revokeToken).not.toHaveBeenCalled();
  });

  it('cancelling the delete dialog does not delete', async () => {
    mocks.useBots.mockReturnValue({ data: [makeBot()] });
    render(<BotsPanel />);
    expand('Helper');

    fireEvent.click(screen.getByRole('button', { name: /Delete bot/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByTestId('confirm-dialog-cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.deleteBot).not.toHaveBeenCalled();
  });
});
