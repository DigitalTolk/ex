import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  applyServerVersionEvent,
  BUILD_DISPLAY_VERSION,
  BUILD_VERSION,
  reportServerVersion,
  useServerVersion,
  useServerVersionPoller,
  type ServerVersionState,
} from '@/hooks/useServerVersion';
import { captureServerVersion } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { UpdateBanner } from '@/components/UpdateBanner';

// The deployed version is server state in React Query: each test gets its own
// client, so nothing one test learned about the server can show up in the
// next (the old module-level store needed a reset call in every suite).

const originalFetch = globalThis.fetch;
let client: QueryClient;

function Probe({ id = 'probe' }: { id?: string }) {
  const { serverVersion, outdated } = useServerVersion();
  return <div data-testid={id} data-version={serverVersion ?? ''} data-outdated={String(outdated)} />;
}

function Poller() {
  useServerVersionPoller();
  return null;
}

function renderWith(ui: ReactNode) {
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const probe = (id = 'probe') => screen.getByTestId(id);

function versionResponse(version: string, etag?: string): Response {
  return new Response(JSON.stringify({ version }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...(etag ? { ETag: etag } : {}) },
  });
}

const notModified = () => new Response(null, { status: 304 });

// A reply whose body is read without a stream: fake timers would stall one.
function plainReply(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, headers: new Headers(), json: async () => body } as unknown as Response;
}

const sentETags = () =>
  vi.mocked(globalThis.fetch).mock.calls.map(
    (call) => ((call[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined)?.['If-None-Match'],
  );

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Never settles unless a test says otherwise: the version stays unknown.
  globalThis.fetch = vi.fn(() => new Promise<Response>(() => undefined));
});

afterEach(() => {
  vi.useRealTimers();
  client.clear();
  globalThis.fetch = originalFetch;
});

describe('useServerVersion', () => {
  it('reports outdated=false before the server reports a version', () => {
    renderWith(<Probe />);
    expect(probe()).toHaveAttribute('data-version', '');
    expect(probe()).toHaveAttribute('data-outdated', 'false');
  });

  it('a server.version frame updates the query: outdated once it differs from the build', async () => {
    renderWith(<Probe />);
    act(() => applyServerVersionEvent(client, 'v2.0.0'));
    await waitFor(() => expect(probe()).toHaveAttribute('data-version', 'v2.0.0'));
    expect(probe()).toHaveAttribute('data-outdated', 'true');
    expect(BUILD_VERSION).toBe('test');
    expect(BUILD_DISPLAY_VERSION).toBe('release-test');
  });

  it('does not carry a version over from the previous test', () => {
    // The previous test left a newer version behind; a fresh client knows
    // nothing yet. With the old module-level store this read v2.0.0.
    renderWith(<Probe />);
    expect(probe()).toHaveAttribute('data-version', '');
    expect(probe()).toHaveAttribute('data-outdated', 'false');
  });

  it('compares the server version against app-version, not the display build-version', async () => {
    renderWith(<Probe />);
    act(() => applyServerVersionEvent(client, BUILD_DISPLAY_VERSION));
    await waitFor(() => expect(probe()).toHaveAttribute('data-version', 'release-test'));
    expect(probe()).toHaveAttribute('data-outdated', 'true');
  });

  it('keeps outdated=false when the server reports the build version', async () => {
    renderWith(<Probe />);
    act(() => applyServerVersionEvent(client, BUILD_VERSION));
    await waitFor(() => expect(probe()).toHaveAttribute('data-version', BUILD_VERSION));
    expect(probe()).toHaveAttribute('data-outdated', 'false');
  });

  it('every mounted consumer sees the same pushed version', async () => {
    renderWith(
      <>
        <Probe id="a" />
        <Probe id="b" />
      </>,
    );
    act(() => applyServerVersionEvent(client, 'v3.0.0'));
    await waitFor(() => expect(probe('a')).toHaveAttribute('data-version', 'v3.0.0'));
    expect(probe('b')).toHaveAttribute('data-version', 'v3.0.0');
  });

  it('ignores an empty pushed version and keeps the known one', async () => {
    renderWith(<Probe />);
    act(() => applyServerVersionEvent(client, 'v4.0.0'));
    act(() => applyServerVersionEvent(client, ''));
    await waitFor(() => expect(probe()).toHaveAttribute('data-version', 'v4.0.0'));
    expect(client.getQueryData<ServerVersionState>(queryKeys.serverVersion())).toEqual({ version: 'v4.0.0', etag: null });
  });

  it('a version header on any API response reaches the mounted consumers', async () => {
    renderWith(<Probe />);
    act(() => captureServerVersion(new Response(null, { headers: { 'X-EX-App-Version': 'from-header' } })));
    await waitFor(() => expect(probe()).toHaveAttribute('data-version', 'from-header'));
    expect(probe()).toHaveAttribute('data-outdated', 'true');
  });

  it('stops listening for reported versions once unmounted', () => {
    const view = renderWith(<Probe />);
    view.unmount();
    reportServerVersion('after-unmount');
    expect(client.getQueryData(queryKeys.serverVersion())).toBeUndefined();
  });

  it('checks the server once when mounted without a poller, and records the reply', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(versionResponse('v5', 'etag-5'));
    renderWith(<Probe />);
    await waitFor(() => expect(probe()).toHaveAttribute('data-version', 'v5'));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/v1/version', expect.objectContaining({ credentials: 'include' }));
    expect(client.getQueryData<ServerVersionState>(queryKeys.serverVersion())).toEqual({ version: 'v5', etag: 'etag-5' });
  });
});

describe('useServerVersionPoller', () => {
  it('a 304 returns the cached version; the poll sent the cached ETag back', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(versionResponse('v1', 'etag-1')).mockResolvedValue(notModified());
    renderWith(
      <>
        <Poller />
        <Probe />
      </>,
    );
    await waitFor(() => expect(probe()).toHaveAttribute('data-version', 'v1'));
    await act(() => client.refetchQueries({ queryKey: queryKeys.serverVersion() }));
    expect(sentETags()).toEqual([undefined, 'etag-1']);
    expect(probe()).toHaveAttribute('data-version', 'v1');
    expect(client.getQueryData<ServerVersionState>(queryKeys.serverVersion())).toEqual({ version: 'v1', etag: 'etag-1' });
  });

  it('a 304 before anything is known leaves the version unknown', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(notModified());
    renderWith(
      <>
        <Poller />
        <Probe />
      </>,
    );
    await waitFor(() =>
      expect(client.getQueryData<ServerVersionState>(queryKeys.serverVersion())).toEqual({ version: null, etag: null }),
    );
    expect(probe()).toHaveAttribute('data-version', '');
  });

  it('a reply with neither a version nor an ETag keeps the known ones', async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(versionResponse('v6', 'etag-6'))
      .mockResolvedValue(new Response('{}', { status: 200 }));
    renderWith(
      <>
        <Poller />
        <Probe />
      </>,
    );
    await waitFor(() => expect(probe()).toHaveAttribute('data-version', 'v6'));
    await act(() => client.refetchQueries({ queryKey: queryKeys.serverVersion() }));
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(client.getQueryData<ServerVersionState>(queryKeys.serverVersion())).toEqual({ version: 'v6', etag: 'etag-6' });
  });

  it('a reply with neither, before anything is known, records nothing', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('{}', { status: 200 }));
    renderWith(<Poller />);
    await waitFor(() =>
      expect(client.getQueryData<ServerVersionState>(queryKeys.serverVersion())).toEqual({ version: null, etag: null }),
    );
  });

  it('a pushed version keeps the ETag of the last poll', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(versionResponse('v7', 'etag-7')).mockResolvedValue(notModified());
    renderWith(
      <>
        <Poller />
        <Probe />
      </>,
    );
    await waitFor(() => expect(probe()).toHaveAttribute('data-version', 'v7'));
    act(() => applyServerVersionEvent(client, 'v8'));
    expect(client.getQueryData<ServerVersionState>(queryKeys.serverVersion())).toEqual({ version: 'v8', etag: 'etag-7' });
    await act(() => client.refetchQueries({ queryKey: queryKeys.serverVersion() }));
    expect(sentETags()).toEqual([undefined, 'etag-7']);
    await waitFor(() => expect(probe()).toHaveAttribute('data-version', 'v8'));
  });

  it('retries a failed check after 5 seconds instead of waiting for the next minute', async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch)
      .mockRejectedValueOnce(new TypeError('connection refused'))
      .mockResolvedValueOnce(plainReply(503, { version: 'v-503' }))
      .mockResolvedValue(plainReply(200, { version: 'mobile-reconnected' }));
    renderWith(
      <>
        <Poller />
        <Probe />
      </>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    // The second attempt answered 503: retried again, never recorded.
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(probe()).toHaveAttribute('data-version', '');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    // React Query hands the result to its observers on 0ms timers, which the
    // fake clock runs a millisecond later.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(probe()).toHaveAttribute('data-version', 'mobile-reconnected');
    expect(probe()).toHaveAttribute('data-outdated', 'true');
  });

  it('checks again every minute', async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(versionResponse('v9', 'etag-9')).mockResolvedValue(notModified());
    renderWith(<Poller />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(sentETags()).toEqual([undefined, 'etag-9']);
  });

  it('checks again when the page becomes visible, and when it is back online', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(versionResponse('v10', 'etag-10'));
    renderWith(<Poller />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    act(() => {
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    });
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
    act(() => {
      window.dispatchEvent(new Event('offline'));
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(3));
  });

  it('checks again on a back/forward-cache restore, not on an ordinary page show', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(versionResponse('v11', 'etag-11'));
    renderWith(<Poller />);
    await waitFor(() => expect(client.getQueryState(queryKeys.serverVersion())?.status).toBe('success'));
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    });
    // A refetch would have started synchronously.
    expect(client.getQueryState(queryKeys.serverVersion())?.fetchStatus).toBe('idle');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
  });

  it('copies reported versions into its client even with no consumer mounted', () => {
    renderWith(<Poller />);
    act(() => reportServerVersion('reported'));
    expect(client.getQueryData<ServerVersionState>(queryKeys.serverVersion())).toEqual({ version: 'reported', etag: null });
  });

  it('stops checking once unmounted', async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(versionResponse('v12'));
    const view = renderWith(<Poller />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    view.unmount();
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('UpdateBanner', () => {
  it('does not render while versions match', () => {
    applyServerVersionEvent(client, BUILD_VERSION);
    renderWith(<UpdateBanner />);
    expect(screen.queryByTestId('update-banner')).toBeNull();
  });

  it('renders when the server reports a different version', () => {
    applyServerVersionEvent(client, 'v9.9.9');
    renderWith(<UpdateBanner />);
    expect(screen.getByTestId('update-banner')).toBeInTheDocument();
    expect(screen.getByText('New version available.')).toBeInTheDocument();
    expect(screen.getByTestId('update-banner-reload')).toHaveTextContent('Reload');
    expect(screen.getByText('New version available.').parentElement).toHaveClass('text-center');
    expect(screen.getByTestId('update-banner').querySelector('svg')).toBeNull();
  });

  it('appears while mounted when a newer version is pushed', async () => {
    renderWith(<UpdateBanner />);
    expect(screen.queryByTestId('update-banner')).toBeNull();
    act(() => applyServerVersionEvent(client, 'v9.9.9'));
    expect(await screen.findByTestId('update-banner')).toBeInTheDocument();
  });

  it('the reload button cache-busts the location, replacing the current history entry', () => {
    applyServerVersionEvent(client, 'v9.9.9');

    const orig = window.location;
    let assigned = '';
    // Replace, never push: Back after the update must not land on the old build.
    const replace = vi.fn((v: string) => {
      assigned = v;
    });
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...orig,
        pathname: '/chat',
        search: '?foo=1',
        replace,
        get href() {
          return '/chat';
        },
        set href(_v: string) {
          throw new Error('the reload must not push a history entry');
        },
      },
    });

    try {
      renderWith(<UpdateBanner />);
      const btn = screen.getByTestId('update-banner-reload');
      fireEvent.click(btn);
      expect(replace).toHaveBeenCalledTimes(1);
      expect(assigned).toMatch(/^\/chat\?foo=1&v=\d+$/);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: orig });
    }
  });

  it('the reload button replaces a prior v= param instead of appending another one', () => {
    // Regression: the banner used to do `${search}${sep}v=…` which kept
    // tacking on a fresh v= each reload. After several rolls the URL
    // ended up like `?v=1&v=2&v=3&v=4&v=5`. Replace, don't append.
    applyServerVersionEvent(client, 'v9.9.9');

    const orig = window.location;
    let assigned = '';
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...orig,
        pathname: '/channel/general',
        search: '?v=111&v=222&foo=bar',
        replace: (v: string) => {
          assigned = v;
        },
      },
    });

    try {
      renderWith(<UpdateBanner />);
      fireEvent.click(screen.getByTestId('update-banner-reload'));
      // Exactly one v= and the original foo=bar must survive.
      expect(assigned).toMatch(/^\/channel\/general\?/);
      const qs = assigned.split('?')[1];
      const params = new URLSearchParams(qs);
      expect(params.getAll('v')).toHaveLength(1);
      expect(params.get('foo')).toBe('bar');
      expect(Number(params.get('v'))).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: orig });
    }
  });
});
