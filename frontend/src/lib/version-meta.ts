// The HTML meta-tag name the server stamps into each served index.html
// (handler.AppVersionMetaName on the Go side). Imported by both the
// runtime hook and the test setup so a future rename only happens once.
export const APP_VERSION_META = 'app-version';
export const BUILD_VERSION_META = 'build-version';
// The HTML meta-tag name for the (optional) Sentry DSN — injected by the
// server only when SENTRY_FRONTEND_DSN is configured (handler.SentryDSNMetaName).
export const SENTRY_DSN_META = 'sentry-dsn';
// Optional Sentry sample rates (0..1), injected only alongside the DSN and
// only when non-zero (handler.Sentry*SampleRateMetaName on the Go side).
export const SENTRY_TRACES_SAMPLE_RATE_META = 'sentry-traces-sample-rate';
export const SENTRY_REPLAY_SESSION_SAMPLE_RATE_META = 'sentry-replay-session-sample-rate';
export const SENTRY_REPLAY_ERROR_SAMPLE_RATE_META = 'sentry-replay-error-sample-rate';
