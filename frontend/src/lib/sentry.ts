// Optional Sentry error reporting for the SPA. The server injects the DSN as
// a meta tag (SENTRY_FRONTEND_DSN → <meta name="sentry-dsn">) only when ops
// opted in — no DSN, no init, zero runtime footprint. Because the Electron
// shell and the Capacitor app load this same SPA from the server, one
// integration covers every UI surface; events are tagged with the platform so
// a single Sentry project stays filterable. Errors only: performance tracing
// is Datadog's job (see Dockerfile / Orchestrion), so the sample rate is 0.
import * as Sentry from '@sentry/react';
import {
  BUILD_VERSION_META,
  SENTRY_DSN_META,
  SENTRY_REPLAY_ERROR_SAMPLE_RATE_META,
  SENTRY_REPLAY_SESSION_SAMPLE_RATE_META,
  SENTRY_TRACES_SAMPLE_RATE_META,
} from './version-meta';

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

let active = false;

// initErrorReporting starts Sentry iff the server injected a DSN. Called once
// from main.tsx before the app renders so boot-time crashes are captured.
// Returns whether reporting is active (also true for repeat calls).
export function initErrorReporting(): boolean {
  if (active) return true;
  const dsn = metaContent(SENTRY_DSN_META);
  if (!dsn) return false;
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
    sendDefaultPii: false,
    initialScope: { tags: { platform: detectPlatform() } },
  });
  if (replaysSessionSampleRate > 0 || replaysOnErrorSampleRate > 0) {
    // Replay is by far the heaviest part of the SDK — pull it in only when a
    // deployment actually samples it (Sentry's documented lazy pattern; the
    // rates above were already fixed at init).
    void import('@sentry/react')
      .then((mod) => {
        Sentry.addIntegration(mod.replayIntegration());
      })
      .catch(() => undefined);
  }
  active = true;
  return true;
}

// reportError forwards a caught error (e.g. from the app's ErrorBoundary —
// React swallows render errors before window.onerror can see them). No-op
// while reporting is inactive.
export function reportError(error: unknown, context?: Record<string, unknown>): void {
  if (!active) return;
  Sentry.captureException(error, context ? { extra: context } : undefined);
}

// resetErrorReportingForTests clears the module singleton between tests.
export function resetErrorReportingForTests(): void {
  active = false;
}
