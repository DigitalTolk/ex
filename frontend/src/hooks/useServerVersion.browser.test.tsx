import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { useServerVersion, resetServerVersionForTests } from './useServerVersion';

// Browser coverage for the /api/v1/version poller. The poller is a module
// singleton lazily started by the first consumer; resetServerVersionForTests
// tears it down (interval + listeners) so each test starts clean.

function Probe() {
  const { serverVersion, outdated } = useServerVersion();
  return <div data-testid="sv" data-version={serverVersion ?? ''} data-outdated={String(outdated)} />;
}

function versionResponse(version: string, etag = 'etag-1') {
  return { status: 200, ok: true, headers: new Headers({ ETag: etag }), json: async () => ({ version }) } as unknown as Response;
}

let realFetch: typeof fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  resetServerVersionForTests();
});
afterEach(() => {
  cleanup();
  resetServerVersionForTests();
  globalThis.fetch = realFetch;
});

describe('useServerVersion poller', () => {
  it('records the server version from a 200 response and re-polls with If-None-Match on focus', async () => {
    const fetchMock = vi.fn().mockResolvedValue(versionResponse('v2'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const screen = await render(<Probe />);
    await vi.waitFor(() => {
      expect(screen.getByTestId('sv').element().getAttribute('data-version')).toBe('v2');
    });
    // First poll carried no If-None-Match; after caching the ETag, a focus
    // re-poll sends it back.
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => {
      const sentConditional = fetchMock.mock.calls.some(
        (c) => (c[1] as { headers?: Record<string, string> } | undefined)?.headers?.['If-None-Match'] === 'etag-1',
      );
      expect(sentConditional).toBe(true);
    });
  });

  it('treats a 304 as no-change', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 304, ok: false, headers: new Headers(), json: async () => ({}) } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const screen = await render(<Probe />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByTestId('sv').element().getAttribute('data-version')).toBe('');
  });

  it('schedules a retry on a non-ok response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 503, ok: false, headers: new Headers(), json: async () => ({}) } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await render(<Probe />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it('schedules a retry when the fetch throws (offline)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await render(<Probe />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it('re-polls on online / pageshow and skips the visibility tick when hidden', async () => {
    const fetchMock = vi.fn().mockResolvedValue(versionResponse('v3', 'etag-3'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await render(<Probe />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const before = fetchMock.mock.calls.length;
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('pageshow'));
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
    // A visibilitychange while hidden must NOT poll.
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    const afterEvents = fetchMock.mock.calls.length;
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(fetchMock.mock.calls.length).toBe(afterEvents);
    if (original) Object.defineProperty(document, 'visibilityState', original);
  });
});
