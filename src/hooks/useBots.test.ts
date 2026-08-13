import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/api';
import {
  useBots,
  useBotTokens,
  useCreateBot,
  useCreateBotToken,
  useDeleteBot,
  useRevokeBotToken,
  useSetBotWebhook,
  type Bot,
  type BotToken,
} from './useBots';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return createElement(QueryClientProvider, { client: qc }, children);
}

const bot: Bot = {
  user_id: 'bot_1',
  name: 'Helper',
  created_by: 'u-adm',
  create_at: '2026-01-01T00:00:00Z',
  update_at: '2026-01-01T00:00:00Z',
};

const token: BotToken = {
  token_id: 'tid-1',
  bot_user_id: 'bot_1',
  create_at: '2026-01-01T00:00:00Z',
};

describe('useBots', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('lists bots', async () => {
    vi.mocked(apiFetch).mockResolvedValue([bot]);
    const { result } = renderHook(() => useBots(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([bot]));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/admin/bots');
  });

  it('tolerates a non-array response', async () => {
    // A malformed response must not crash the admin page.
    vi.mocked(apiFetch).mockResolvedValue(null);
    const { result } = renderHook(() => useBots(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([]));
  });

  it('creates a bot', async () => {
    vi.mocked(apiFetch).mockResolvedValue(bot);
    const { result } = renderHook(() => useCreateBot(), { wrapper });
    result.current.mutate({ name: 'Helper', description: 'does things' });
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/admin/bots', {
      method: 'POST',
      body: JSON.stringify({ name: 'Helper', description: 'does things' }),
    });
  });

  it('deletes a bot', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);
    const { result } = renderHook(() => useDeleteBot(), { wrapper });
    result.current.mutate('bot 1');
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    // The id is URL-encoded so a reserved character can't alter the path.
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/admin/bots/bot%201', { method: 'DELETE' });
  });

  it('rejects a delete with no id instead of requesting .../undefined', async () => {
    // A missing id used to produce a 404 that looked like "the bot won't delete".
    const { result } = renderHook(() => useDeleteBot(), { wrapper });
    result.current.mutate('');
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toContain('Missing bot id');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('sets a webhook with its transport and triggers', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, signing_secret: 'exwhsec_x' });
    const { result } = renderHook(() => useSetBotWebhook(), { wrapper });
    result.current.mutate({
      id: 'bot_1',
      callback_url: 'https://bot.example.com/hook',
      transport: 'mattermost',
      trigger_words: ['deploy'],
      trigger_when: 1,
    });
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    // The id goes in the path, everything else in the body.
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/admin/bots/bot_1/webhook', {
      method: 'PUT',
      body: JSON.stringify({
        callback_url: 'https://bot.example.com/hook',
        transport: 'mattermost',
        trigger_words: ['deploy'],
        trigger_when: 1,
      }),
    });
  });

  it('lists a bot’s tokens, and stays idle without a bot id', async () => {
    vi.mocked(apiFetch).mockResolvedValue([token]);
    const { result } = renderHook(() => useBotTokens('bot_1'), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([token]));

    vi.mocked(apiFetch).mockClear();
    const { result: idle } = renderHook(() => useBotTokens(''), { wrapper });
    expect(idle.current.fetchStatus).toBe('idle');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('tolerates a non-array token response', async () => {
    vi.mocked(apiFetch).mockResolvedValue(null);
    const { result } = renderHook(() => useBotTokens('bot_1'), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([]));
  });

  it('issues a token', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ...token, token: 'exbot_secret' });
    const { result } = renderHook(() => useCreateBotToken('bot_1'), { wrapper });
    result.current.mutate('prod');
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/admin/bots/bot_1/tokens', {
      method: 'POST',
      body: JSON.stringify({ label: 'prod' }),
    });
  });

  it('revokes a token', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);
    const { result } = renderHook(() => useRevokeBotToken('bot_1'), { wrapper });
    result.current.mutate('tid-1');
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/admin/bots/bot_1/tokens/tid-1', {
      method: 'DELETE',
    });
  });
});
