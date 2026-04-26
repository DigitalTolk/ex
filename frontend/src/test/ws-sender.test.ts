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
});
