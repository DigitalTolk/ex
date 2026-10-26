import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const initMock = vi.hoisted(() => vi.fn());
const captureMock = vi.hoisted(() => vi.fn());
const addIntegrationMock = vi.hoisted(() => vi.fn());
const browserTracingMock = vi.hoisted(() => vi.fn(() => ({ name: 'BrowserTracing' })));
const replayMock = vi.hoisted(() => vi.fn(() => ({ name: 'Replay' })));
const lazyLoadMock = vi.hoisted(() => vi.fn(async (_name: string) => replayMock));
vi.mock('@sentry/react', () => ({
  init: (...args: unknown[]) => initMock(...args),
  captureException: (...args: unknown[]) => captureMock(...args),
  addIntegration: (...args: unknown[]) => addIntegrationMock(...args),
  browserTracingIntegration: () => browserTracingMock(),
  lazyLoadIntegration: (name: string) => lazyLoadMock(name),
}));

import {
  detectPlatform,
  initErrorReporting,
  reportError,
  resetErrorReportingForTests,
  scrubDeep,
  scrubSecrets,
} from './sentry';
import {
  BUILD_VERSION_META,
  SENTRY_DSN_META,
  SENTRY_REPLAY_ERROR_SAMPLE_RATE_META,
  SENTRY_REPLAY_SESSION_SAMPLE_RATE_META,
  SENTRY_TRACES_SAMPLE_RATE_META,
} from './version-meta';

const DSN = 'https://key@o0.ingest.sentry.io/42';

function setMeta(name: string, content: string) {
  const tag = document.createElement('meta');
  tag.setAttribute('name', name);
  tag.setAttribute('content', content);
  document.head.appendChild(tag);
}

// The SDK is a lazy chunk: init lands once the dynamic import settles.
async function sdkLoaded() {
  await vi.waitFor(() => expect(initMock).toHaveBeenCalled());
}

function initOptions(): {
  beforeSend: (e: unknown) => unknown;
  beforeBreadcrumb: (b: unknown) => unknown;
} & Record<string, unknown> {
  return initMock.mock.calls[0][0];
}

function rejection(reason: unknown): Event {
  // jsdom has no PromiseRejectionEvent constructor; the listener only reads
  // `reason`.
  return Object.assign(new Event('unhandledrejection'), { reason });
}

describe('sentry error reporting', () => {
  beforeEach(() => {
    initMock.mockReset();
    captureMock.mockReset();
    addIntegrationMock.mockReset();
    browserTracingMock.mockClear();
    replayMock.mockClear();
    lazyLoadMock.mockClear();
    resetErrorReportingForTests();
    document.head.querySelectorAll('meta').forEach((m) => m.remove());
  });

  afterEach(() => {
    resetErrorReportingForTests();
    delete (window as { __EX_DESKTOP__?: boolean }).__EX_DESKTOP__;
    delete (window as { Capacitor?: unknown }).Capacitor;
  });

  it('stays fully inert without a server-injected DSN', async () => {
    expect(initErrorReporting()).toBe(false);
    reportError(new Error('boom'));
    // Message-only error events: with no listener of ours attached, one
    // carrying an error object would surface as the test's own uncaught error.
    window.dispatchEvent(new ErrorEvent('error', { message: 'early' }));
    await Promise.resolve();
    expect(initMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('initializes with the DSN, release, errors-only sampling, scrubbers and platform tag', async () => {
    setMeta(SENTRY_DSN_META, DSN);
    setMeta(BUILD_VERSION_META, 'v0.0.57');
    expect(initErrorReporting()).toBe(true);
    await sdkLoaded();
    expect(initMock).toHaveBeenCalledWith({
      dsn: DSN,
      release: 'v0.0.57',
      tracesSampleRate: 0,
      integrations: [],
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      dataCollection: { userInfo: false, cookies: false },
      ignoreErrors: [/ResizeObserver loop/],
      initialScope: { tags: { platform: 'web' } },
      beforeSend: expect.any(Function),
      beforeBreadcrumb: expect.any(Function),
    });
    // Nothing sampled → neither heavy integration is constructed or loaded.
    expect(browserTracingMock).not.toHaveBeenCalled();
    expect(lazyLoadMock).not.toHaveBeenCalled();
  });

  it('enables performance tracing at the server-served sample rate', async () => {
    setMeta(SENTRY_DSN_META, DSN);
    setMeta(SENTRY_TRACES_SAMPLE_RATE_META, '0.25');
    initErrorReporting();
    await sdkLoaded();
    expect(initOptions()).toMatchObject({
      tracesSampleRate: 0.25,
      integrations: [{ name: 'BrowserTracing' }],
    });
  });

  it('lazy-loads session replay from the SDK loader when a replay rate is served', async () => {
    setMeta(SENTRY_DSN_META, DSN);
    setMeta(SENTRY_REPLAY_SESSION_SAMPLE_RATE_META, '0.1');
    setMeta(SENTRY_REPLAY_ERROR_SAMPLE_RATE_META, '1');
    initErrorReporting();
    await sdkLoaded();
    expect(initOptions()).toMatchObject({
      replaysSessionSampleRate: 0.1,
      replaysOnErrorSampleRate: 1,
    });
    await vi.waitFor(() => {
      expect(addIntegrationMock).toHaveBeenCalledWith({ name: 'Replay' });
    });
    expect(lazyLoadMock).toHaveBeenCalledWith('replayIntegration');
  });

  it('error-only replay (session rate 0) still loads the integration', async () => {
    setMeta(SENTRY_DSN_META, DSN);
    setMeta(SENTRY_REPLAY_ERROR_SAMPLE_RATE_META, '0.5');
    initErrorReporting();
    await vi.waitFor(() => expect(addIntegrationMock).toHaveBeenCalled());
  });

  it('stays initialized when the lazy replay integration fails to load', async () => {
    // Replay is best-effort: a CDN fetch that fails (offline, blocked) is
    // swallowed — error reporting itself must stay active, no unhandled
    // rejection.
    setMeta(SENTRY_DSN_META, DSN);
    setMeta(SENTRY_REPLAY_ERROR_SAMPLE_RATE_META, '0.5');
    let failLoad: (e: Error) => void = () => undefined;
    lazyLoadMock.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (failLoad = reject)),
    );
    expect(initErrorReporting()).toBe(true);
    await vi.waitFor(() => expect(lazyLoadMock).toHaveBeenCalled());
    const load = lazyLoadMock.mock.results[0].value as Promise<unknown>;
    failLoad(new Error('replay bundle failed'));
    await expect(load).rejects.toThrow('replay bundle failed');
    expect(addIntegrationMock).not.toHaveBeenCalled();
    const err = new Error('boom');
    reportError(err);
    expect(captureMock).toHaveBeenCalledWith(err, undefined);
  });

  it('clamps and sanitizes served rates (tampered document fails safe)', async () => {
    setMeta(SENTRY_DSN_META, DSN);
    setMeta(SENTRY_TRACES_SAMPLE_RATE_META, '7');
    setMeta(SENTRY_REPLAY_SESSION_SAMPLE_RATE_META, 'banana');
    setMeta(SENTRY_REPLAY_ERROR_SAMPLE_RATE_META, '-1');
    initErrorReporting();
    await sdkLoaded();
    expect(initOptions()).toMatchObject({
      tracesSampleRate: 1, // clamped
      replaysSessionSampleRate: 0, // unparsable → off
      replaysOnErrorSampleRate: 0, // negative → off
    });
  });

  it('omits the release when the build-version meta is absent', async () => {
    setMeta(SENTRY_DSN_META, DSN);
    initErrorReporting();
    await sdkLoaded();
    expect(initOptions()).toMatchObject({ release: undefined });
  });

  it('is idempotent — repeat calls, while loading and once loaded, do not re-init', async () => {
    setMeta(SENTRY_DSN_META, DSN);
    expect(initErrorReporting()).toBe(true);
    expect(initErrorReporting()).toBe(true);
    await sdkLoaded();
    expect(initErrorReporting()).toBe(true);
    await Promise.resolve();
    expect(initMock).toHaveBeenCalledTimes(1);
  });

  it('reports errors (with and without context) once active', async () => {
    setMeta(SENTRY_DSN_META, DSN);
    initErrorReporting();
    await sdkLoaded();
    const err = new Error('render boom');
    reportError(err);
    expect(captureMock).toHaveBeenCalledWith(err, undefined);
    reportError(err, { componentStack: 'at App' });
    expect(captureMock).toHaveBeenCalledWith(err, { extra: { componentStack: 'at App' } });
  });

  it('keeps errors raised while the SDK chunk loads and sends them once it is up', async () => {
    setMeta(SENTRY_DSN_META, DSN);
    initErrorReporting();
    const thrown = new Error('boot crash');
    const rejected = new Error('boot rejection');
    const caught = new Error('boundary');
    window.dispatchEvent(new ErrorEvent('error', { error: thrown, message: 'boot crash' }));
    // A cross-origin "Script error." carries no error object, only a message.
    window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }));
    window.dispatchEvent(rejection(rejected));
    reportError(caught, { componentStack: 'at App' });
    expect(captureMock).not.toHaveBeenCalled();
    await sdkLoaded();
    expect(captureMock.mock.calls).toEqual([
      [thrown, undefined],
      [new Error('Script error.'), undefined],
      [rejected, undefined],
      [caught, { extra: { componentStack: 'at App' } }],
    ]);
    // Sentry's own global handlers own window errors from here on.
    captureMock.mockClear();
    window.dispatchEvent(new ErrorEvent('error', { message: 'later' }));
    window.dispatchEvent(rejection(new Error('later')));
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('buffers a bounded number of early errors', async () => {
    setMeta(SENTRY_DSN_META, DSN);
    initErrorReporting();
    for (let i = 0; i < 30; i++) window.dispatchEvent(new ErrorEvent('error', { error: new Error(`e${i}`) }));
    await sdkLoaded();
    expect(captureMock).toHaveBeenCalledTimes(20);
    expect(captureMock.mock.calls[19][0]).toEqual(new Error('e19'));
  });

  it('scrubs secrets from every outgoing event and breadcrumb', async () => {
    setMeta(SENTRY_DSN_META, DSN);
    initErrorReporting();
    await sdkLoaded();
    const { beforeSend, beforeBreadcrumb } = initOptions();
    expect(
      beforeSend({
        request: { url: 'https://ex.example.com/reset-password/s3cret?x=1' },
        transaction: '/invite/inv-tok',
        exception: { values: [{ value: 'GET /api/v1/media/med-tok/a.png failed' }] },
      }),
    ).toEqual({
      request: { url: 'https://ex.example.com/reset-password/[Filtered]?x=1' },
      transaction: '/invite/[Filtered]',
      exception: { values: [{ value: 'GET /api/v1/media/[Filtered]/a.png failed' }] },
    });
    expect(
      beforeBreadcrumb({ category: 'navigation', data: { from: '/oidc/callback?desktop_code=dc1', to: '/' } }),
    ).toEqual({ category: 'navigation', data: { from: '/oidc/callback?desktop_code=[Filtered]', to: '/' } });
  });

  it('detects the electron shell', () => {
    (window as { __EX_DESKTOP__?: boolean }).__EX_DESKTOP__ = true;
    expect(detectPlatform()).toBe('electron');
  });

  it('detects the capacitor shell', () => {
    (window as { Capacitor?: unknown }).Capacitor = {};
    expect(detectPlatform()).toBe('capacitor');
  });

  it('defaults to web', () => {
    expect(detectPlatform()).toBe('web');
  });
});

describe('scrubSecrets', () => {
  it.each([
    ['/reset-password/abc123', '/reset-password/[Filtered]'],
    ['https://h/invite/tok?x=1#y', 'https://h/invite/[Filtered]?x=1#y'],
    ['/api/v1/media/tok/file.pdf', '/api/v1/media/[Filtered]/file.pdf'],
    ['/auth/desktop/complete?code=abc&next=/', '/auth/desktop/complete?code=[Filtered]&next=/'],
    ['wss://h/api/v1/ws?ticket=t1&since=5', 'wss://h/api/v1/ws?ticket=[Filtered]&since=5'],
    ['/x?a=1&token=t2', '/x?a=1&token=[Filtered]'],
    ['/oidc/callback?DESKTOP_CODE=d', '/oidc/callback?DESKTOP_CODE=[Filtered]'],
    ['two: /invite/a and /invite/b', 'two: /invite/[Filtered] and /invite/[Filtered]'],
    // Lookalikes stay intact.
    ['/channel/general?barcode=1', '/channel/general?barcode=1'],
    ['/invites', '/invites'],
  ])('%s → %s', (input, expected) => {
    expect(scrubSecrets(input)).toBe(expected);
  });
});

describe('scrubDeep', () => {
  it('rewrites strings inside arrays and plain objects, leaving other values alone', () => {
    const err = new Error('/invite/keep-me');
    const when = new Date(0);
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { url: '/invite/t' });
    expect(
      scrubDeep({ list: ['/invite/t', 3, null, true], nested: { bare }, err, when, n: 1, u: undefined }),
    ).toEqual({ list: ['/invite/[Filtered]', 3, null, true], nested: { bare: { url: '/invite/[Filtered]' } }, err, when, n: 1, u: undefined });
  });

  it('stops descending past a depth cap (cyclic or pathological payloads)', () => {
    const cyclic: Record<string, unknown> = { url: '/invite/t' };
    cyclic.self = cyclic;
    const out = scrubDeep(cyclic) as Record<string, unknown>;
    expect(out.url).toBe('/invite/[Filtered]');
    let level: Record<string, unknown> = out;
    for (let i = 0; i < 11; i++) level = level.self as Record<string, unknown>;
    // The twelfth level is handed back untouched rather than walked forever.
    expect(level.self).toBe(cyclic);
  });
});
