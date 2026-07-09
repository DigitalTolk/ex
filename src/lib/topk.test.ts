import { describe, it, expect } from 'vitest';
import { topK } from './topk';

const numAsc = (a: number, b: number) => a - b;

describe('topK', () => {
  it('returns the k smallest values in sorted order', () => {
    expect(topK([5, 1, 4, 2, 3, 6], 3, numAsc)).toEqual([1, 2, 3]);
  });

  it('returns the whole list (sorted) when k >= items.length', () => {
    expect(topK([3, 1, 2], 5, numAsc)).toEqual([1, 2, 3]);
  });

  it('returns an empty list when k <= 0', () => {
    expect(topK([1, 2, 3], 0, numAsc)).toEqual([]);
    expect(topK([1, 2, 3], -1, numAsc)).toEqual([]);
  });

  it('handles ties stably-ish — equal items don\'t reorder past one another', () => {
    // Comparator returns 0 for equal items; we want the first ones to
    // win since out.length < k inserts at the end of an equal run.
    const items = [{ k: 1, v: 'a' }, { k: 1, v: 'b' }, { k: 2, v: 'c' }];
    const out = topK(items, 2, (a, b) => a.k - b.k);
    expect(out.map((o) => o.v)).toEqual(['a', 'b']);
  });

  it('handles a single-item list', () => {
    expect(topK([42], 5, numAsc)).toEqual([42]);
  });

  it('returns sorted output even when k=1', () => {
    expect(topK([5, 1, 9, 2], 1, numAsc)).toEqual([1]);
  });

  it('does not sort the input array', () => {
    const input = [5, 1, 4, 2, 3];
    topK(input, 3, numAsc);
    expect(input).toEqual([5, 1, 4, 2, 3]);
  });
});
