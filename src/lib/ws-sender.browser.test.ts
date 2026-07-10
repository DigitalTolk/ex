import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setWSSender, sendWS, clearWSPending } from '@/lib/ws-sender';

// Browser-project coverage for the ack buffer-and-flush path (the jsdom suite
// covers the same logic; this keeps the browser branch gate honest since
// ws-sender is also imported by browser-run code).
describe('ws-sender (browser) — ack buffering', () => {
  beforeEach(() => {
    setWSSender(null);
  });

  it('drops unflagged frames while down but buffers + flushes flagged ones on reconnect', () => {
    sendWS({ type: 'typing' }); // unflagged, no sender → dropped
    sendWS({ type: 'notification.ack', messageID: 'm-1' }, { buffer: true });
    sendWS({ type: 'notification.ack', messageID: 'm-2' }, { buffer: true });
    const send = vi.fn();
    setWSSender(send);
    expect(send).toHaveBeenNthCalledWith(1, JSON.stringify({ type: 'notification.ack', messageID: 'm-1' }));
    expect(send).toHaveBeenNthCalledWith(2, JSON.stringify({ type: 'notification.ack', messageID: 'm-2' }));
    setWSSender(null);
  });

  it('re-buffers the remainder when a reconnect dies mid-flush, then flushes on the next', () => {
    sendWS({ type: 'notification.ack', messageID: 'a' }, { buffer: true });
    sendWS({ type: 'notification.ack', messageID: 'b' }, { buffer: true });
    const dying = vi.fn(() => { throw new Error('died'); });
    setWSSender(dying);
    expect(dying).toHaveBeenCalledTimes(1);
    const healthy = vi.fn();
    setWSSender(healthy);
    expect(healthy).toHaveBeenNthCalledWith(1, JSON.stringify({ type: 'notification.ack', messageID: 'a' }));
    expect(healthy).toHaveBeenNthCalledWith(2, JSON.stringify({ type: 'notification.ack', messageID: 'b' }));
    setWSSender(null);
  });

  it('buffers when the live send throws and bounds the queue at the cap', () => {
    const dead = vi.fn(() => { throw new Error('closed'); });
    setWSSender(dead);
    for (let i = 0; i < 70; i += 1) {
      sendWS({ type: 'notification.ack', messageID: `m-${i}` }, { buffer: true });
    }
    const send = vi.fn();
    setWSSender(send);
    expect(send).toHaveBeenCalledTimes(64); // 6 oldest dropped past the cap
    expect(send).toHaveBeenNthCalledWith(1, JSON.stringify({ type: 'notification.ack', messageID: 'm-6' }));
    setWSSender(null);
  });

  it('clearWSPending drops buffered frames so they cannot leak into a later session', () => {
    setWSSender(null);
    sendWS({ type: 'notification.ack', messageID: 'm-old-session' }, { buffer: true });
    clearWSPending(); // logout/user-switch teardown
    const sent: string[] = [];
    setWSSender((frame) => sent.push(frame)); // next session's socket
    expect(sent).toEqual([]);
  });
});
