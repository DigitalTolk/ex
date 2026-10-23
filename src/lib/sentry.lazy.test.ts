import { describe, it, expect, vi } from 'vitest';

// The SDK must not be part of the app's eager graph: this module is loaded
// on every boot, and a deployment without a DSN must never fetch Sentry.
// The mock factory runs the moment anything imports '@sentry/react'.
const sdkLoads = vi.hoisted(() => ({ count: 0 }));
vi.mock('@sentry/react', () => {
  sdkLoads.count++;
  return {};
});

import { initErrorReporting, reportError } from './sentry';

describe('sentry without a DSN', () => {
  it('never loads the SDK', async () => {
    expect(initErrorReporting()).toBe(false);
    reportError(new Error('boom'));
    await Promise.resolve();
    expect(sdkLoads.count).toBe(0);
  });
});
