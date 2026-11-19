import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noteReceipt, useActionReceipts } from './action-receipts';

const line = (id: string) => useActionReceipts.getState().byMessage[id];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-02T10:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('action receipts', () => {
  it('keeps the latest line per card, stamped when noted', () => {
    noteReceipt('m1', { text: 'You clicked “Approve”' });
    noteReceipt('m2', { text: 'You chose “P1”', notice: 'Priority set', failed: false });
    expect(line('m1')).toEqual({ text: 'You clicked “Approve”', at: Date.parse('2026-11-02T10:00:00Z') });
    vi.advanceTimersByTime(1000);
    noteReceipt('m1', { text: 'You clicked “Reject”' });
    expect(line('m1')).toMatchObject({ text: 'You clicked “Reject”', at: Date.parse('2026-11-02T10:00:01Z') });
    expect(line('m2')).toMatchObject({ text: 'You chose “P1”', notice: 'Priority set' });
  });

  it("drops a click's answer when the card's line changed after the click", () => {
    const since = Date.now();
    noteReceipt('m1', { text: 'You opened “Expense”' });
    vi.advanceTimersByTime(500);
    noteReceipt('m1', { text: 'You clicked “Open”' }, since);
    expect(line('m1').text).toBe('You opened “Expense”');
  });

  it("notes a click's answer over a line from before the click, or on a card with no line", () => {
    noteReceipt('m1', { text: 'You clicked “Open”' });
    vi.advanceTimersByTime(500);
    const since = Date.now();
    noteReceipt('m1', { text: 'You chose “P2”' }, since);
    expect(line('m1').text).toBe('You chose “P2”');
    noteReceipt('m3', { text: 'You chose “P3”' }, since);
    expect(line('m3').text).toBe('You chose “P3”');
  });
});
