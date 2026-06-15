import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
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

// vitest-browser-react's cleanup() does not await React's async unmount, so on
// WebKit a previous Probe can outlive the test and the next getByTestId('sv')
// resolves to multiple elements (strict-mode violation). Track each render and
// await its unmount instead.
let mounted: Awaited<ReturnType<typeof render>> | null = null;
async function mount() {
  mounted = await render(<Probe />);
  return mounted;
}

let realFetch: typeof fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  resetServerVersionForTests();
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  resetServerVersionForTests();
  globalThis.fetch = realFetch;
});

describe('useServerVersion poller', () => {
  it('records the server version from a 200 response and re-polls with If-None-Match on focus', async () => {
    const fetchMock = vi.fn().mockResolvedValue(versionResponse('v2'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const screen = await mount();
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
    const screen = await mount();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByTestId('sv').element().getAttribute('data-version')).toBe('');
  });

  it('schedules a retry on a non-ok response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 503, ok: false, headers: new Headers(), json: async () => ({}) } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await mount();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it('schedules a retry when the fetch throws (offline)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await mount();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it('handles a 200 response that carries neither an ETag nor a version field', async () => {
    // res.ok with no ETag header (the `if (etag)` false side, line 93) and no
    // `version` in the JSON body (the `if (data?.version)` false side, line 95):
    // the poll runs to completion without recording anything.
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers(),
      json: async () => ({}),
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const screen = await mount();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByTestId('sv').element().getAttribute('data-version')).toBe('');
  });

  it('coalesces a focus re-poll while a failure retry is already scheduled', async () => {
    // First poll returns 503 → scheduleRetry sets retryTimeoutID. A focus
    // event then triggers tick() again; if that path schedules another retry
    // it hits scheduleRetry's `if (retryTimeoutID !== null) return` early-out
    // (line 75 true side).
    const fetchMock = vi.fn().mockResolvedValue({ status: 503, ok: false, headers: new Headers(), json: async () => ({}) } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await mount();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
  });

  it('re-polls on online / pageshow and skips the visibility tick when hidden', async () => {
    const fetchMock = vi.fn().mockResolvedValue(versionResponse('v3', 'etag-3'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await mount();
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

  it('the poller starts only once even when a second consumer mounts (pollerStarted early-out)', async () => {
    // Two consumers in one tree: the first effect calls startPoller and sets
    // pollerStarted; the second calls startPoller again and hits the
    // `if (pollerStarted) return` true side (line 65). The fetch fires once.
    const fetchMock = vi.fn().mockResolvedValue(versionResponse('v9', 'etag-9'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    mounted = await render(
      <>
        <Probe />
        <Probe />
      </>,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // A single poller → exactly one initial poll despite two subscribers.
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it('reset notifies live subscribers (subscribers.size !== 0 arm)', async () => {
    // With a Probe mounted there is a live subscriber, so
    // resetServerVersionForTests takes the `subscribers.size === 0` FALSE side
    // (line 36) and fans the reset out to the subscriber's callback, which
    // re-reads the now-null snapshot.
    const fetchMock = vi.fn().mockResolvedValue(versionResponse('v10', 'etag-10'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const screen = await mount();
    await vi.waitFor(() => {
      expect(screen.getByTestId('sv').element().getAttribute('data-version')).toBe('v10');
    });
    resetServerVersionForTests();
    await vi.waitFor(() => {
      expect(screen.getByTestId('sv').element().getAttribute('data-version')).toBe('');
    });
  });

  it('flips outdated to true once the server reports a version unlike the stamped build', async () => {
    // browser-setup.ts stamps a real meta tag, so BUILD_VERSION is
    // 'browser-test' (not 'dev') → the dev-build suppression
    // (devBuildWithoutServerStamp) is false and a differing server version
    // makes `outdated` true. This drives the `v !== null && v !== BUILD_VERSION
    // && !devBuildWithoutServerStamp` all-true side of line 146.
    const fetchMock = vi.fn().mockResolvedValue(versionResponse('a-different-build', 'etag-x'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const screen = await mount();
    await vi.waitFor(() => {
      expect(screen.getByTestId('sv').element().getAttribute('data-outdated')).toBe('true');
    });
  });
});
