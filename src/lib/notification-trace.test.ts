import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getNotificationTrace,
  NOTIFICATION_TRACE_FLAG_KEY,
  resetNotificationTraceForTests,
  traceNotification,
} from './notification-trace';

describe('notification-trace', () => {
  beforeEach(() => {
    resetNotificationTraceForTests();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records entries newest-last with step, messageID and detail', () => {
    traceNotification('surfaced', 'm-1', { acked: true });
    traceNotification('dedup', 'm-1');
    const trace = getNotificationTrace();
    expect(trace).toHaveLength(2);
    expect(trace[0]).toMatchObject({ step: 'surfaced', messageID: 'm-1', detail: { acked: true } });
    expect(trace[1]).toMatchObject({ step: 'dedup', messageID: 'm-1' });
    expect(trace[0].at).toBeGreaterThan(0);
  });

  it('is a bounded ring buffer (oldest entries drop past capacity)', () => {
    for (let i = 0; i < 120; i++) traceNotification('step', `m-${i}`);
    const trace = getNotificationTrace();
    expect(trace).toHaveLength(100);
    expect(trace[0].messageID).toBe('m-20');
    expect(trace[99].messageID).toBe('m-119');
  });

  it('getNotificationTrace returns a copy (mutation-safe)', () => {
    traceNotification('surfaced', 'm-1');
    const copy = getNotificationTrace();
    copy.pop();
    expect(getNotificationTrace()).toHaveLength(1);
  });

  it('mirrors to the console only when the debug flag is set', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    traceNotification('quiet', 'm-1');
    expect(debug).not.toHaveBeenCalled();
    localStorage.setItem(NOTIFICATION_TRACE_FLAG_KEY, 'true');
    traceNotification('loud', 'm-2', { parent: 'ch-1' });
    expect(debug).toHaveBeenCalledWith('[notif]', 'loud', 'm-2', { parent: 'ch-1' });
    // Entries without messageID/detail log placeholder blanks, not undefined.
    traceNotification('bare');
    expect(debug).toHaveBeenCalledWith('[notif]', 'bare', '', '');
  });
});
