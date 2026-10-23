// Optional Sentry error reporting for the SPA. The server injects the DSN as
// a meta tag (SENTRY_FRONTEND_DSN → <meta name="sentry-dsn">) only when ops
// opted in — no DSN, no init, zero runtime footprint: the SDK is a lazy chunk
// fetched only once a DSN is present, so a deployment without one never
// downloads it. Because the Electron shell and the Capacitor app load this
// same SPA from the server, one integration covers every UI surface; events
// are tagged with the platform so a single Sentry project stays filterable.
// Errors only by default: performance tracing is Datadog's job (see
// Dockerfile / Orchestrion), so the sample rate defaults to 0.
import type * as SentrySDK from '@sentry/react';
import {
  BUILD_VERSION_META,
  SENTRY_DSN_META,
  SENTRY_REPLAY_ERROR_SAMPLE_RATE_META,
  SENTRY_REPLAY_SESSION_SAMPLE_RATE_META,
  SENTRY_TRACES_SAMPLE_RATE_META,
} from './version-meta';

// The slice of the SDK this module calls. Taking exactly these members off
// the dynamic import (destructured, below) lets the bundler drop the rest —
// Session Replay above all — from the SDK chunk.
type Sentry = Pick<
  typeof SentrySDK,
  'init' | 'captureException' | 'addIntegration' | 'browserTracingIntegration' | 'lazyLoadIntegration'
>;

function metaContent(name: string): string {
  return document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? '';
}

// metaRate parses a server-injected 0..1 sample rate. The server validates
// its env vars, so garbage here means a tampered document — fail safe to 0
// (off) and clamp anything above 1.
function metaRate(name: string): number {
  const v = Number.parseFloat(metaContent(name));
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(v, 1);
}

export type ErrorReportingPlatform = 'web' | 'electron' | 'capacitor';

// detectPlatform distinguishes the three shells this SPA runs in, using the
// globals each shell already exposes.
export function detectPlatform(): ErrorReportingPlatform {
  if (window.__EX_DESKTOP__) return 'electron';
  if ('Capacitor' in window) return 'capacitor';
  return 'web';
}

// ---------------------------------------------------------------------------
// Scrubbing. Some of the app's URLs carry a secret in the path or the query:
// a password-reset or invite token, a media capability token, the desktop
// hand-off code, the WebSocket ticket. Any of them can surface in an event —
// the page URL, a navigation or fetch breadcrumb, an error message — so every
// string in an outgoing event or breadcrumb is rewritten before it leaves.

const FILTERED = '[Filtered]';
const SECRET_PATH = /(\/(?:reset-password|invite|api\/v1\/media)\/)[^/?#\s"']+/gi;
const SECRET_PARAM = /([?&#](?:desktop_code|code|ticket|token)=)[^&#\s"']*/gi;

export function scrubSecrets(text: string): string {
  return text.replace(SECRET_PATH, `$1${FILTERED}`).replace(SECRET_PARAM, `$1${FILTERED}`);
}

// Events are plain JSON-shaped data; a depth cap keeps a pathological (or
// cyclic) `extra` payload from recursing without bound.
const SCRUB_MAX_DEPTH = 12;

export function scrubDeep<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return scrubSecrets(value) as T;
  if (depth >= SCRUB_MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, depth + 1)) as T;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v, depth + 1);
  return out as T;
}

// ---------------------------------------------------------------------------
// Loading. Errors thrown while the SDK chunk is still on its way would be
// lost, so they are buffered (bounded) and replayed once it initialises —
// Sentry's own global handlers take over from that moment.

const EARLY_BUFFER_MAX = 20;

// 'ready' is `sdk !== null`.
type State = 'off' | 'loading' | 'failed';
let state: State = 'off';
let sdk: Sentry | null = null;
let queued: Array<{ error: unknown; extra?: Record<string, unknown> }> = [];
let stopEarlyCapture: (() => void) | null = null;

function enqueue(error: unknown, extra?: Record<string, unknown>) {
  if (queued.length < EARLY_BUFFER_MAX) queued.push({ error, extra });
}

function captureEarlyErrors(): () => void {
  const onError = (e: ErrorEvent) => enqueue(e.error ?? new Error(e.message));
  const onRejection = (e: PromiseRejectionEvent) => enqueue(e.reason);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}

function start(Sentry: Sentry, dsn: string) {
  // Sampling is ops-tuned per deployment via env vars the server serves as
  // meta tags; everything defaults to 0 (off) — errors-only remains the
  // baseline, and backend traces stay Datadog's job.
  const tracesSampleRate = metaRate(SENTRY_TRACES_SAMPLE_RATE_META);
  const replaysSessionSampleRate = metaRate(SENTRY_REPLAY_SESSION_SAMPLE_RATE_META);
  const replaysOnErrorSampleRate = metaRate(SENTRY_REPLAY_ERROR_SAMPLE_RATE_META);
  Sentry.init({
    dsn,
    // The build-version meta (GIT_TAG/SHA) is what CI knows at build time,
    // so it is the release key source maps can later be uploaded under.
    release: metaContent(BUILD_VERSION_META) || undefined,
    tracesSampleRate,
    integrations: tracesSampleRate > 0 ? [Sentry.browserTracingIntegration()] : [],
    replaysSessionSampleRate,
    replaysOnErrorSampleRate,
    // SDK v11 replaced `sendDefaultPii: false` with `dataCollection`, whose
    // defaults are all ON — so the opt-outs must be explicit. `userInfo`
    // gates server-side IP inference; request headers stay on because the
    // User-Agent is how Sentry derives browser/OS context (v10 sent it too).
    dataCollection: { userInfo: false, cookies: false },
    // The message list applies Virtuoso's size corrections synchronously
    // inside ResizeObserver callbacks (see MessageList), which the browser
    // reports as this benign loop notice. Not an error worth an event.
    ignoreErrors: [/ResizeObserver loop/],
    initialScope: { tags: { platform: detectPlatform() } },
    beforeSend: (event) => scrubDeep(event),
    beforeBreadcrumb: (breadcrumb) => scrubDeep(breadcrumb),
  });
  sdk = Sentry;
  stopEarlyCapture?.();
  stopEarlyCapture = null;
  const pending = queued;
  queued = [];
  for (const { error, extra } of pending) Sentry.captureException(error, extra ? { extra } : undefined);
  if (replaysSessionSampleRate > 0 || replaysOnErrorSampleRate > 0) {
    // Session Replay (rrweb) is by far the heaviest part of the SDK, so it
    // is not in the SDK chunk at all: Sentry fetches it from its CDN only
    // for a deployment that samples it (the rates above were fixed at init).
    // Best-effort — reporting itself stays up if it never arrives.
    void Sentry.lazyLoadIntegration('replayIntegration')
      .then((replayIntegration) => Sentry.addIntegration(replayIntegration()))
      .catch(() => undefined);
  }
}

// initErrorReporting starts Sentry iff the server injected a DSN. Called once
// from main.tsx before the app renders so boot-time crashes are captured.
// Returns whether reporting is active (also true for repeat calls).
export function initErrorReporting(): boolean {
  if (sdk) return true;
  if (state !== 'off') return state === 'loading';
  const dsn = metaContent(SENTRY_DSN_META);
  if (!dsn) return false;
  state = 'loading';
  stopEarlyCapture = captureEarlyErrors();
  import('@sentry/react').then(
    ({ init, captureException, addIntegration, browserTracingIntegration, lazyLoadIntegration }) =>
      start({ init, captureException, addIntegration, browserTracingIntegration, lazyLoadIntegration }, dsn),
    () => {
      // The chunk never arrived (offline boot, mid-deploy hash rotation):
      // nothing can be reported this session, so stop buffering.
      state = 'failed';
      stopEarlyCapture?.();
      stopEarlyCapture = null;
      queued = [];
    },
  );
  return true;
}

// reportError forwards a caught error (e.g. from the app's ErrorBoundary —
// React swallows render errors before window.onerror can see them). Queued
// while the SDK is loading; a no-op while reporting is off.
export function reportError(error: unknown, context?: Record<string, unknown>): void {
  if (sdk) {
    sdk.captureException(error, context ? { extra: context } : undefined);
    return;
  }
  if (state === 'loading') enqueue(error, context);
}

// resetErrorReportingForTests clears the module singleton between tests.
export function resetErrorReportingForTests(): void {
  stopEarlyCapture?.();
  stopEarlyCapture = null;
  state = 'off';
  sdk = null;
  queued = [];
}
