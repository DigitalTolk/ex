import { afterEach, beforeEach, vi } from 'vitest';

// Uppy's constructor schedules a check of navigator.onLine 3 s out, and
// destroy() never cancels it. An upload near the end of a test file left that
// check pending past the file: the worker lives on after its last test (longer
// on a loaded machine), and once jsdom was torn down the check threw "window
// is not defined" as an unhandled error, failing the run.
//
// A file that runs real uploads in jsdom calls this once. Its timers are fake
// but keep pace with the clock, so uploads run as they would, and whatever a
// test leaves pending is dropped when it ends.
export function dropTimersLeftByUploads(): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
}
