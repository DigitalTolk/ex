import { afterEach, beforeEach, vi } from 'vitest';

// A timer an upload leaves pending can outlive its test file: the worker lives
// on after its last test (longer on a loaded machine), and once jsdom is torn
// down the timer throws "window is not defined" as an unhandled error, failing
// the run. Uppy's online check did exactly that until @uppy/core 6.3.2 made
// destroy() cancel it; this keeps any other such timer from doing the same.
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
