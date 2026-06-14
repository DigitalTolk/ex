import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useChannelMessages } from './useMessages';

// Browser coverage for the infinite-query window fetching (tail / around /
// older / newer). The jsdom useMessages.test.ts exercises these, but
// useMessages is excluded from the jsdom gate, so the fetchMessageWindow
// switch + page-param getters only count when driven in the browser gate.

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

beforeEach(() => {
  apiFetchMock.mockReset();
});

function Probe({ channelId, anchor }: { channelId?: string; anchor?: string }) {
  const q = useChannelMessages(channelId, anchor);
  return (
    <div>
      <div data-testid="state" data-pages={q.data?.pages.length ?? 0} data-fetching={String(q.isFetching)} />
      <button type="button" data-testid="next" onClick={() => void q.fetchNextPage()}>load older</button>
      <button type="button" data-testid="prev" onClick={() => void q.fetchPreviousPage()}>load newer</button>
    </div>
  );
}

function renderProbe(props: { channelId?: string; anchor?: string }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Probe {...props} />
    </QueryClientProvider>,
  );
}

function urls() {
  return apiFetchMock.mock.calls.map((c) => String(c[0]));
}

describe('useChannelMessages infinite window (browser)', () => {
  it('fetches the tail window by default with a limit', async () => {
    apiFetchMock.mockResolvedValue({ items: [], hasMoreOlder: false, hasMoreNewer: false });
    await renderProbe({ channelId: 'ch-1' });
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(urls()[0]).toContain('/api/v1/channels/ch-1/messages?');
    expect(urls()[0]).toContain('limit=50');
    expect(urls()[0]).not.toContain('around=');
  });

  it('seeds the initial fetch with /around when an anchor is supplied', async () => {
    apiFetchMock.mockResolvedValue({ items: [], hasMoreOlder: true, hasMoreNewer: true, oldestID: 'o', newestID: 'n' });
    await renderProbe({ channelId: 'ch-1', anchor: 'msg-deep' });
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(urls()[0]).toContain('around=msg-deep');
    expect(urls()[0]).toContain('before=25');
    expect(urls()[0]).toContain('after_count=25');
  });

  it('fetchNextPage requests an older window keyed off oldestID', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('cursor=')) {
        return Promise.resolve({ items: [], hasMoreOlder: false, hasMoreNewer: false });
      }
      return Promise.resolve({ items: [], hasMoreOlder: true, hasMoreNewer: false, oldestID: 'old-1' });
    });
    const screen = await renderProbe({ channelId: 'ch-1' });
    // Wait for the initial tail fetch to settle before paginating.
    await vi.waitFor(() => expect(screen.getByTestId('state').element().getAttribute('data-fetching')).toBe('false'));
    await screen.getByTestId('next').click();
    await vi.waitFor(() => {
      expect(urls().some((u) => u.includes('cursor=old-1'))).toBe(true);
    });
  });

  it('fetchPreviousPage requests a newer window keyed off newestID', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes('after=')) {
        return Promise.resolve({ items: [], hasMoreOlder: false, hasMoreNewer: false });
      }
      return Promise.resolve({ items: [], hasMoreOlder: false, hasMoreNewer: true, newestID: 'new-1' });
    });
    const screen = await renderProbe({ channelId: 'ch-1' });
    await vi.waitFor(() => expect(screen.getByTestId('state').element().getAttribute('data-fetching')).toBe('false'));
    await screen.getByTestId('prev').click();
    await vi.waitFor(() => {
      expect(urls().some((u) => u.includes('after=new-1'))).toBe(true);
    });
  });

  it('is disabled (no fetch) without a channel id', async () => {
    await renderProbe({ channelId: undefined });
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
