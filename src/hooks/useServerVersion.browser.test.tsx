import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { applyServerVersionEvent, useServerVersion, useServerVersionPoller } from './useServerVersion';
import { captureServerVersion } from '@/lib/api';

// The /api/v1/version check in a real browser: real Response objects, real
// focus/visibility events, one React Query client per test.

function Probe() {
  const { serverVersion, outdated } = useServerVersion();
  return <div data-testid="sv" data-version={serverVersion ?? ''} data-outdated={String(outdated)} />;
}

function Poller() {
  useServerVersionPoller();
  return null;
}

function versionResponse(version: string, etag = 'etag-1'): Response {
  return new Response(JSON.stringify({ version }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ETag: etag },
  });
}

let client: QueryClient;
// vitest-browser-react's cleanup() does not await React's async unmount, so on
// WebKit a previous Probe can outlive the test and the next getByTestId('sv')
// resolves to multiple elements (strict-mode violation). Track each render and
// await its unmount instead.
let mounted: Awaited<ReturnType<typeof render>> | null = null;
async function mount(ui: ReactNode = (<><Poller /><Probe /></>)) {
  mounted = await render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return mounted;
}

let realFetch: typeof fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  client.clear();
  globalThis.fetch = realFetch;
});

const sentETag = (call: unknown[]) =>
  ((call[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined)?.['If-None-Match'];

describe('useServerVersion in the browser', () => {
  it('records the version from a 200 and re-checks with If-None-Match when the page is shown again', async () => {
    const fetchMock = vi.fn(async () => versionResponse('v2'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const screen = await mount();
    await expect.element(screen.getByTestId('sv')).toHaveAttribute('data-version', 'v2');
    expect(sentETag(fetchMock.mock.calls[0])).toBeUndefined();
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    await expect.poll(() => fetchMock.mock.calls.length).toBe(2);
    expect(sentETag(fetchMock.mock.calls[1])).toBe('etag-1');
  });

  it('a 304 changes nothing', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 304 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const screen = await mount();
    await expect.poll(() => client.getQueryState(['server-version'])?.status).toBe('success');
    await expect.element(screen.getByTestId('sv')).toHaveAttribute('data-version', '');
  });

  it('flips outdated once the server reports a version unlike the stamped build', async () => {
    globalThis.fetch = vi.fn(async () => versionResponse('a-different-build', 'etag-x')) as unknown as typeof fetch;
    const screen = await mount();
    await expect.element(screen.getByTestId('sv')).toHaveAttribute('data-outdated', 'true');
  });

  it('a pushed server.version frame shows without a poll', async () => {
    globalThis.fetch = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const screen = await mount(<Probe />);
    applyServerVersionEvent(client, 'pushed-build');
    await expect.element(screen.getByTestId('sv')).toHaveAttribute('data-version', 'pushed-build');
  });

  it('a version header on an API response shows without a poll', async () => {
    globalThis.fetch = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const screen = await mount(<Probe />);
    captureServerVersion(new Response(null, { headers: { 'X-EX-App-Version': 'header-build' } }));
    await expect.element(screen.getByTestId('sv')).toHaveAttribute('data-version', 'header-build');
  });

  it('the poller and every consumer share one check', async () => {
    const fetchMock = vi.fn(async () => versionResponse('v9', 'etag-9'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const screen = await mount(
      <>
        <Poller />
        <Probe />
        <Probe />
      </>,
    );
    await expect.element(screen.getByTestId('sv').first()).toHaveAttribute('data-version', 'v9');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
