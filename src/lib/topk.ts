// topK returns the K smallest items from `items` per the given
// comparator, in sorted order. Single linear pass maintaining a sorted
// window of K — O(N·K) time, O(K) space — which beats `.sort().slice(0,
// K)` for K << N because it never sorts the trailing N-K items.
export function topK<T>(items: readonly T[], k: number, cmp: (a: T, b: T) => number): T[] {
  if (k <= 0) return [];
  if (items.length <= k) return items.slice().sort(cmp);
  const out: T[] = [];
  for (const item of items) {
    if (out.length < k) {
      let i = out.length;
      while (i > 0 && cmp(out[i - 1], item) > 0) i--;
      out.splice(i, 0, item);
      continue;
    }
    if (cmp(item, out[k - 1]) >= 0) continue;
    let i = k - 1;
    while (i > 0 && cmp(out[i - 1], item) > 0) i--;
    out.splice(i, 0, item);
    out.pop();
  }
  return out;
}
