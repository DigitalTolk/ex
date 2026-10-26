import { describe, it, expect, vi, afterEach } from 'vitest';

// The SDK chunk can fail to arrive (offline boot, a deploy rotating asset
// hashes mid-load). Reporting then turns itself off for the session instead
// of buffering forever.
vi.mock('@sentry/react', () => {
  throw new Error('chunk failed to load');
});

import { initErrorReporting, reportError, resetErrorReportingForTests } from './sentry';
import { SENTRY_DSN_META } from './version-meta';

describe('sentry SDK load failure', () => {
  afterEach(() => {
    resetErrorReportingForTests();
    document.head.querySelectorAll('meta').forEach((m) => m.remove());
  });

  it('switches reporting off once the SDK import rejects', async () => {
    const tag = document.createElement('meta');
    tag.setAttribute('name', SENTRY_DSN_META);
    tag.setAttribute('content', 'https://key@o0.ingest.sentry.io/42');
    document.head.appendChild(tag);
    expect(initErrorReporting()).toBe(true);
    reportError(new Error('queued while loading'));
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('early') }));
    // Inactive (not merely loading) once the import has failed.
    await vi.waitFor(() => expect(initErrorReporting()).toBe(false));
    // Nothing throws or queues from here on.
    reportError(new Error('after failure'));
    // Message-only: an error object with no listener left would surface as
    // this test's own uncaught error.
    window.dispatchEvent(new ErrorEvent('error', { message: 'late' }));
  });
});
