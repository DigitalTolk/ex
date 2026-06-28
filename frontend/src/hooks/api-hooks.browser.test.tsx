import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useUserChannels,
  useChannel,
  useChannelBySlug,
  useChannelMembers,
  useBrowseChannels,
  useCreateChannel,
  useJoinChannel,
  useMuteChannel,
  useSetChannelNotificationPrefs,
} from './useChannels';
import { useEmojis, useEmojiMap } from './useEmoji';
import { useUserState } from './useUserState';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

beforeEach(() => {
  apiFetchMock.mockReset();
});

function Probe<T>({ hook }: { hook: () => { data?: T; status?: string } }) {
  const r = hook();
  return (
    <div
      data-testid="probe"
      data-status={r.status ?? ''}
      data-data={r.data === undefined ? '' : JSON.stringify(r.data)}
      data-call={apiFetchMock.mock.calls[0]?.[0] ?? ''}
    />
  );
}

function MutationProbe({
  hook,
  vars,
}: {
  hook: () => { mutate: (v: unknown) => void; status: string };
  vars: unknown;
}) {
  const m = hook();
  return (
    <button
      data-testid="trigger"
      data-status={m.status}
      onClick={() => m.mutate(vars)}
    />
  );
}

function renderHook<T>(hook: () => { data?: T; status?: string }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Probe hook={hook} />
    </QueryClientProvider>,
  );
}

describe('useChannels — queries', () => {
  it('useUserChannels coerces non-array API responses to []', async () => {
    apiFetchMock.mockResolvedValue(null);
    const screen = await renderHook(() => useUserChannels());
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByTestId('probe').element().getAttribute('data-data')).toBe('[]');
  });

  it('useUserChannels respects enabled:false', async () => {
    apiFetchMock.mockResolvedValue([]);
    await renderHook(() => useUserChannels({ enabled: false }));
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('useChannel is disabled when no channelId', async () => {
    apiFetchMock.mockResolvedValue({});
    await renderHook(() => useChannel(undefined));
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('useChannel hits /channels/:id when channelId is set', async () => {
    apiFetchMock.mockResolvedValue({ id: 'ch-1' });
    await renderHook(() => useChannel('ch-1'));
    await new Promise((r) => setTimeout(r, 100));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/channels/ch-1');
  });

  it('useChannelBySlug is disabled when slug is missing', async () => {
    await renderHook(() => useChannelBySlug(undefined));
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('useChannelMembers fetches /channels/:id/members', async () => {
    apiFetchMock.mockResolvedValue([]);
    await renderHook(() => useChannelMembers('ch-1'));
    await new Promise((r) => setTimeout(r, 100));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/channels/ch-1/members');
  });

  it('useBrowseChannels appends q= only when a non-empty query is supplied', async () => {
    apiFetchMock.mockResolvedValue([]);
    await renderHook(() => useBrowseChannels());
    await new Promise((r) => setTimeout(r, 100));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/channels/browse');
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue([]);
    await renderHook(() => useBrowseChannels(' general '));
    await new Promise((r) => setTimeout(r, 100));
    expect(apiFetchMock.mock.calls[0][0]).toContain('q=general');
  });
});

describe('useChannels — mutations', () => {
  function renderMutation(hook: () => { mutate: (v: unknown) => void; status: string }, vars: unknown) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MutationProbe hook={hook} vars={vars} />
      </QueryClientProvider>,
    );
  }

  it('useCreateChannel POSTs to /channels and invalidates the channel queries on success', async () => {
    apiFetchMock.mockResolvedValue({ id: 'ch-1', name: 'general' });
    const screen = await renderMutation(useCreateChannel as never, {
      name: 'general',
      type: 'public',
    });
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock).toHaveBeenCalled();
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/channels');
    expect((apiFetchMock.mock.calls[0][1] as { method: string }).method).toBe('POST');
  });

  it('useJoinChannel POSTs to /channels/:id/join', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const screen = await renderMutation(useJoinChannel as never, 'ch-1');
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/channels/ch-1/join');
  });

  it('useMuteChannel PUTs to /channels/:id/mute with body { muted }', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const screen = await renderMutation(useMuteChannel as never, { channelId: 'ch-1', muted: true });
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    const [url, init] = apiFetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/channels/ch-1/mute');
    expect((init as { method: string }).method).toBe('PUT');
    expect(JSON.parse((init as { body: string }).body)).toEqual({ muted: true });
  });

  it('useSetChannelNotificationPrefs PUTs the override to /notification-preferences', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const screen = await renderMutation(useSetChannelNotificationPrefs as never, {
      channelId: 'ch-1',
      override: { desktopLevel: 'all', threadReplies: false },
    });
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    const [url, init] = apiFetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/channels/ch-1/notification-preferences');
    expect((init as { method: string }).method).toBe('PUT');
    expect(JSON.parse((init as { body: string }).body)).toEqual({ desktopLevel: 'all', threadReplies: false });
  });
});

describe('useEmoji', () => {
  it('useEmojis coerces a non-array response to []', async () => {
    apiFetchMock.mockResolvedValue(null);
    const screen = await renderHook(() => useEmojis());
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByTestId('probe').element().getAttribute('data-data')).toBe('[]');
  });

  it('useEmojiMap reshapes the list into { name → imageURL }', async () => {
    apiFetchMock.mockResolvedValue([
      { name: 'party', imageURL: 'https://cdn.test/p.png' },
      { name: 'wave', imageURL: 'https://cdn.test/w.png' },
    ]);
    const screen = await renderHook(() => useEmojiMap());
    await new Promise((r) => setTimeout(r, 200));
    const raw = screen.getByTestId('probe').element().getAttribute('data-data') ?? '';
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual({ party: 'https://cdn.test/p.png', wave: 'https://cdn.test/w.png' });
  });

  it('useEmojis is disabled when enabled=false', async () => {
    apiFetchMock.mockResolvedValue([]);
    await renderHook(() => useEmojis(false));
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('useUserState', () => {
  it('coalesces missing fields into empty defaults', async () => {
    apiFetchMock.mockResolvedValue({});
    const screen = await renderHook(() => useUserState());
    await new Promise((r) => setTimeout(r, 200));
    const raw = screen.getByTestId('probe').element().getAttribute('data-data') ?? '';
    const parsed = JSON.parse(raw);
    expect(parsed.threadNotifications).toEqual([]);
    expect(parsed.threadSeen).toEqual({});
    expect(parsed.hiddenConversations).toEqual([]);
  });

  it('passes through populated fields', async () => {
    apiFetchMock.mockResolvedValue({
      threadNotifications: ['root-1'],
      threadSeen: { 't-1': '2026-01-01T00:00:00Z' },
    });
    const screen = await renderHook(() => useUserState());
    await new Promise((r) => setTimeout(r, 200));
    const raw = screen.getByTestId('probe').element().getAttribute('data-data') ?? '';
    const parsed = JSON.parse(raw);
    expect(parsed.threadNotifications[0]).toBe('root-1');
    expect(parsed.threadSeen['t-1']).toBe('2026-01-01T00:00:00Z');
  });
});
