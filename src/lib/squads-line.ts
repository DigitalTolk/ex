// visibleCount is how many items (widths in order, each with its separator)
// fit in `available` pixels: all of them when they do, else as many as leave
// room for the "+N" marker of width `more` — never fewer than one, so the
// line always starts with a squad.
export function visibleCount(widths: number[], more: number, available: number): number {
  const total = widths.reduce((sum, w) => sum + w, 0);
  if (total <= available) return widths.length;
  let used = 0;
  let count = 0;
  while (count < widths.length && used + widths[count] + more <= available) {
    used += widths[count];
    count++;
  }
  return Math.max(1, count);
}
