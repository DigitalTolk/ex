// niceScale: clean ticks covering [min, max], zero always in range.
export function niceScale(min: number, max: number, count = 4): { lo: number; hi: number; ticks: number[] } {
  const lo0 = Math.min(0, min);
  // All zeros still get an axis: 0 to 1, never a range of nothing (which
  // would divide by zero and draw no chart at all).
  const hi0 = max > 0 || lo0 < 0 ? Math.max(0, max) : 1;
  const span = hi0 - lo0;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5].find((m) => m * mag >= raw) ?? 10) * mag;
  const lo = Math.floor(lo0 / step) * step;
  const hi = Math.ceil(hi0 / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e9) / 1e9);
  return { lo, hi, ticks };
}
