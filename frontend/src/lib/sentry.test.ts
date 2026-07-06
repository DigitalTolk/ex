import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const initMock = vi.hoisted(() => vi.fn());
const captureMock = vi.hoisted(() => vi.fn());
const addIntegrationMock = vi.hoisted(() => vi.fn());
const browserTracingMock = vi.hoisted(() => vi.fn(() => ({ name: 'BrowserTracing' })));
const replayMock = vi.hoisted(() => vi.fn(() => ({ name: 'Replay' })));
vi.mock('@sentry/react', () => ({
  init: (...args: unknown[]) => initMock(...args),
  captureException: (...args: unknown[]) => captureMock(...args),
  addIntegration: (...args: unknown[]) => addIntegrationMock(...args),
  browserTracingIntegration: () => browserTracingMock(),
  replayIntegration: () => replayMock(),
}));

import {
  detectPlatform,
  initErrorReporting,
  reportError,
  resetErrorReportingForTests,
} from './sentry';
import {
  BUILD_VERSION_META,
  SENTRY_DSN_META,
  SENTRY_REPLAY_ERROR_SAMPLE_RATE_META,
  SENTRY_REPLAY_SESSION_SAMPLE_RATE_META,
  SENTRY_TRACES_SAMPLE_RATE_META,
} from './version-meta';

function setMeta(name: string, content: string) {
  const tag = document.createElement('meta');
  tag.setAttribute('name', name);
  tag.setAttribute('content', content);
  document.head.appendChild(tag);
}

describe('sentry error reporting', () => {
  beforeEach(() => {
    initMock.mockReset();
    captureMock.mockReset();
    addIntegrationMock.mockReset();
    browserTracingMock.mockClear();
    replayMock.mockClear();
    resetErrorReportingForTests();
    document.head.querySelectorAll('meta').forEach((m) => m.remove());
  });

  afterEach(() => {
    delete (window as { __EX_DESKTOP__?: boolean }).__EX_DESKTOP__;
    delete (window as { Capacitor?: unknown }).Capacitor;
  });

  it('stays fully inert without a server-injected DSN', () => {
    expect(initErrorReporting()).toBe(false);
    expect(initMock).not.toHaveBeenCalled();
    reportError(new Error('boom'));
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('initializes with the DSN, release, errors-only sampling, and platform tag', () => {
    setMeta(SENTRY_DSN_META, 'https://key@o0.ingest.sentry.io/42');
    setMeta(BUILD_VERSION_META, 'v0.0.57');
    expect(initErrorReporting()).toBe(true);
    expect(initMock).toHaveBeenCalledWith({
      dsn: 'https://key@o0.ingest.sentry.io/42',
      release: 'v0.0.57',
      tracesSampleRate: 0,
      integrations: [],
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      sendDefaultPii: false,
      initialScope: { tags: { platform: 'web' } },
    });
    // Nothing sampled → neither heavy integration is constructed or loaded.
    expect(browserTracingMock).not.toHaveBeenCalled();
    expect(replayMock).not.toHaveBeenCalled();
  });

  it('enables performance tracing at the server-served sample rate', () => {
    setMeta(SENTRY_DSN_META, 'https://key@o0.ingest.sentry.io/42');
    setMeta(SENTRY_TRACES_SAMPLE_RATE_META, '0.25');
    initErrorReporting();
    expect(initMock.mock.calls[0][0]).toMatchObject({
      tracesSampleRate: 0.25,
      integrations: [{ name: 'BrowserTracing' }],
    });
  });

  it('lazy-loads session replay when a replay rate is served', async () => {
    setMeta(SENTRY_DSN_META, 'https://key@o0.ingest.sentry.io/42');
    setMeta(SENTRY_REPLAY_SESSION_SAMPLE_RATE_META, '0.1');
    setMeta(SENTRY_REPLAY_ERROR_SAMPLE_RATE_META, '1');
    initErrorReporting();
    expect(initMock.mock.calls[0][0]).toMatchObject({
      replaysSessionSampleRate: 0.1,
      replaysOnErrorSampleRate: 1,
    });
    // The replay integration arrives via dynamic import + addIntegration.
    await vi.waitFor(() => {
      expect(addIntegrationMock).toHaveBeenCalledWith({ name: 'Replay' });
    });
  });

  it('error-only replay (session rate 0) still loads the integration', async () => {
    setMeta(SENTRY_DSN_META, 'https://key@o0.ingest.sentry.io/42');
    setMeta(SENTRY_REPLAY_ERROR_SAMPLE_RATE_META, '0.5');
    initErrorReporting();
    await vi.waitFor(() => expect(addIntegrationMock).toHaveBeenCalled());
  });

  it('clamps and sanitizes served rates (tampered document fails safe)', () => {
    setMeta(SENTRY_DSN_META, 'https://key@o0.ingest.sentry.io/42');
    setMeta(SENTRY_TRACES_SAMPLE_RATE_META, '7');
    setMeta(SENTRY_REPLAY_SESSION_SAMPLE_RATE_META, 'banana');
    setMeta(SENTRY_REPLAY_ERROR_SAMPLE_RATE_META, '-1');
    initErrorReporting();
    expect(initMock.mock.calls[0][0]).toMatchObject({
      tracesSampleRate: 1, // clamped
      replaysSessionSampleRate: 0, // unparsable → off
      replaysOnErrorSampleRate: 0, // negative → off
    });
  });

  it('omits the release when the build-version meta is absent', () => {
    setMeta(SENTRY_DSN_META, 'https://key@o0.ingest.sentry.io/42');
    initErrorReporting();
    expect(initMock.mock.calls[0][0]).toMatchObject({ release: undefined });
  });

  it('is idempotent — a second init call does not re-init', () => {
    setMeta(SENTRY_DSN_META, 'https://key@o0.ingest.sentry.io/42');
    expect(initErrorReporting()).toBe(true);
    expect(initErrorReporting()).toBe(true);
    expect(initMock).toHaveBeenCalledTimes(1);
  });

  it('reports errors (with and without context) once active', () => {
    setMeta(SENTRY_DSN_META, 'https://key@o0.ingest.sentry.io/42');
    initErrorReporting();
    const err = new Error('render boom');
    reportError(err);
    expect(captureMock).toHaveBeenCalledWith(err, undefined);
    reportError(err, { componentStack: 'at App' });
    expect(captureMock).toHaveBeenCalledWith(err, { extra: { componentStack: 'at App' } });
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
