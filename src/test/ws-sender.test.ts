import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setWSSender, sendWS } from '@/lib/ws-sender';

describe('ws-sender', () => {
  beforeEach(() => {
    setWSSender(null);
  });

  it('sendWS is a no-op when no sender is installed', () => {
    expect(() => sendWS({ type: 'typing' })).not.toThrow();
  });

  it('sendWS forwards JSON-stringified payload to the installed sender', () => {
    const send = vi.fn();
    setWSSender(send);
    sendWS({ type: 'typing', parentID: 'X' });
    expect(send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'typing', parentID: 'X' }),
    );
  });

  it('swallows JSON.stringify errors (circular structures)', () => {
    const send = vi.fn();
    setWSSender(send);
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    expect(() => sendWS(circ)).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('clears the sender when null is passed', () => {
    const send = vi.fn();
    setWSSender(send);
    setWSSender(null);
    sendWS({ type: 'typing' });
    expect(send).not.toHaveBeenCalled();
  });

  it('does NOT buffer an unflagged frame sent while the socket is down', () => {
    sendWS({ type: 'typing' }); // no sender, no buffer flag
    const send = vi.fn();
    setWSSender(send); // reconnect — nothing should flush
    expect(send).not.toHaveBeenCalled();
  });

  it('buffers a flagged frame while down and flushes it (in order) on reconnect', () => {
    sendWS({ type: 'notification.ack', messageID: 'm-1' }, { buffer: true });
    sendWS({ type: 'notification.ack', messageID: 'm-2' }, { buffer: true });
    const send = vi.fn();
    setWSSender(send);
    expect(send).toHaveBeenNthCalledWith(1, JSON.stringify({ type: 'notification.ack', messageID: 'm-1' }));
    expect(send).toHaveBeenNthCalledWith(2, JSON.stringify({ type: 'notification.ack', messageID: 'm-2' }));
    setWSSender(null);
  });

  it('buffers a flagged frame when the live send throws, flushing it next reconnect', () => {
    const dead = vi.fn(() => { throw new Error('socket closed'); });
    setWSSender(dead);
    sendWS({ type: 'notification.ack', messageID: 'm-blip' }, { buffer: true });
    expect(dead).toHaveBeenCalledTimes(1); // attempted, threw
    const send = vi.fn();
    setWSSender(send); // reconnect flushes the buffered ack
    expect(send).toHaveBeenCalledWith(JSON.stringify({ type: 'notification.ack', messageID: 'm-blip' }));
    setWSSender(null);
  });

  it('keeps the unsent remainder buffered when a reconnect dies mid-flush', () => {
    sendWS({ type: 'notification.ack', messageID: 'a' }, { buffer: true });
    sendWS({ type: 'notification.ack', messageID: 'b' }, { buffer: true });
    // First install dies on the first frame — 'a' attempted, then it throws,
    // so 'a' and 'b' stay queued for the next reconnect.
    const dying = vi.fn(() => { throw new Error('died mid-flush'); });
    setWSSender(dying);
    expect(dying).toHaveBeenCalledTimes(1);
    const healthy = vi.fn();
    setWSSender(healthy);
    expect(healthy).toHaveBeenNthCalledWith(1, JSON.stringify({ type: 'notification.ack', messageID: 'a' }));
    expect(healthy).toHaveBeenNthCalledWith(2, JSON.stringify({ type: 'notification.ack', messageID: 'b' }));
    setWSSender(null);
  });

  it('bounds the buffer, dropping the oldest frames past the cap', () => {
    for (let i = 0; i < 70; i += 1) {
      sendWS({ type: 'notification.ack', messageID: `m-${i}` }, { buffer: true });
    }
    const send = vi.fn();
    setWSSender(send);
    // Cap is 64, so the 6 oldest (m-0..m-5) were dropped; m-6 is now first.
    expect(send).toHaveBeenCalledTimes(64);
    expect(send).toHaveBeenNthCalledWith(1, JSON.stringify({ type: 'notification.ack', messageID: 'm-6' }));
    setWSSender(null);
  });
});

describe('clearWSPending', () => {
  it('drops buffered frames so they cannot flush into a later session', async () => {
    const { sendWS, setWSSender, clearWSPending } = await import('@/lib/ws-sender');
    setWSSender(null);
    sendWS({ type: 'notification.ack', messageID: 'm-old-session' }, { buffer: true });
    clearWSPending(); // logout/user-switch teardown
    const sent: string[] = [];
    setWSSender((frame) => sent.push(frame)); // next session's socket
    expect(sent).toEqual([]);
  });
});
