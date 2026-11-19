import { memo, useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import { niceScale } from '@/lib/chart-scale';
import { cn } from '@/lib/utils';
import type { Block } from '@/types';

// Chart draws an app's chart block — bar, line or donut — as plain SVG: no
// library, nothing fetched. It renders at its final size on first paint (a
// fixed viewBox scaled to the message's width), so the virtualized list
// measures the row once.
//
// Series take colours in a fixed, validated order (--color-series-1…5), never
// the app's choice; identity is never colour alone — a legend names every
// series (or slice) and "Show data" gives the numbers as a table. Text wears
// text tokens, never a series colour.

type ChartBlock = Extract<Block, { type: 'chart' }>;

const SERIES = [1, 2, 3, 4, 5].map((n) => `var(--color-series-${n})`);
const SURFACE = 'var(--color-background)';

// A bar or line chart is H px tall at any width: it measures its box and
// draws in real pixels, so axis text stays 12px whether the chart fills a
// message or a third of one, and the row's height never changes. Until the
// box is measured it draws at W_DEFAULT — the same height either way.
const W_DEFAULT = 560;
const H = 200;
const PAD = { top: 10, right: 12, bottom: 24 };
const PLOT_H = H - PAD.top - PAD.bottom;

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

function withUnit(text: string, unit?: string): string {
  return unit ? `${text}${unit === '%' ? '' : ' '}${unit}` : text;
}

export const Chart = memo(function Chart({ block }: { block: ChartBlock }) {
  const [showData, setShowData] = useState(false);
  const tableID = useId();
  const title = block.text?.text;
  const multi = block.series.length > 1;
  return (
    <figure data-testid="block-chart" className="flex min-w-0 flex-col gap-2">
      {title && <figcaption className="text-sm font-semibold">{title}</figcaption>}
      {block.kind === 'donut' ? <Donut block={block} /> : <Cartesian block={block} />}
      {multi && <Legend block={block} />}
      <div>
        <button
          type="button"
          aria-expanded={showData}
          aria-controls={tableID}
          onClick={() => setShowData((v) => !v)}
          className="rounded text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {showData ? 'Hide data' : 'Show data'}
        </button>
        {showData && <DataTable id={tableID} block={block} />}
      </div>
    </figure>
  );
});

// Legend: two or more series (a donut lists its slices beside it).
function Legend({ block }: { block: ChartBlock }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-testid="chart-legend">
      {block.series.map((s, i) => (
        <li key={i} className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block size-2.5 rounded-sm" style={{ background: SERIES[i] }} />
          {s.name}
        </li>
      ))}
    </ul>
  );
}

function DataTable({ id, block }: { id: string; block: ChartBlock }) {
  return (
    <div id={id} className="mt-1.5 max-w-full overflow-x-auto rounded-md border border-border">
      <table className="w-full border-collapse text-xs">
        <thead className="bg-muted">
          <tr>
            <th scope="col" className="px-2 py-1 text-left font-semibold" />
            {block.series.map((s, i) => (
              <th key={i} scope="col" className="px-2 py-1 text-right font-semibold">
                {s.name || 'Value'}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.labels.map((label, r) => (
            <tr key={r} className="border-t border-border">
              <th scope="row" className="px-2 py-1 text-left font-normal">
                {label}
              </th>
              {block.series.map((s, i) => (
                <td key={i} className="px-2 py-1 text-right tabular-nums">
                  {withUnit(full.format(s.values[r]), block.unit)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Tooltip: the hovered label's values, placed over the chart at a fraction
// of its width (flipped to the left past 60%).
function Tooltip({ block, index, at }: { block: ChartBlock; index: number; at: number }) {
  const right = at > 0.6;
  return (
    <div
      role="status"
      data-testid="chart-tooltip"
      className="pointer-events-none absolute top-1 z-10 min-w-28 rounded-md border border-border bg-popover px-2 py-1.5 text-xs text-popover-foreground shadow-md"
      style={right ? { right: `${100 - at * 100}%` } : { left: `${at * 100}%` }}
    >
      <div className="mb-0.5 font-semibold">{block.labels[index]}</div>
      {block.series.map((s, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block size-2 rounded-sm" style={{ background: SERIES[i] }} />
          {s.name && <span className="text-muted-foreground">{s.name}</span>}
          <span className="ml-auto pl-2 tabular-nums">{withUnit(full.format(s.values[index]), block.unit)}</span>
        </div>
      ))}
    </div>
  );
}

function Cartesian({ block }: { block: ChartBlock }) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const W = useMeasuredWidth(box);
  const n = block.labels.length;
  const isBar = block.kind === 'bar';
  const { lo, hi, ticks } = useMemo(() => {
    const all = block.series.flatMap((s) => s.values);
    return niceScale(Math.min(...all), Math.max(...all));
  }, [block.series]);
  const tickText = ticks.map((t) => withUnit(compact.format(t), block.unit));
  // Room for the longest tick label (12px text, ~7px a character).
  const left = Math.max(28, Math.max(...tickText.map((t) => t.length)) * 7 + 10);
  const plotW = Math.max(40, W - left - PAD.right);
  const y = (v: number) => PAD.top + PLOT_H - ((v - lo) / (hi - lo)) * PLOT_H;
  const band = plotW / n;
  // A label's centre: bands for bars, evenly spread points for lines.
  const cx = (i: number) => (isBar || n === 1 ? left + band * i + band / 2 : left + (i * plotW) / (n - 1));
  // Every k-th label, so they never crowd (about 56px each).
  const step = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 56))));

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(cx(i) - px) < Math.abs(cx(best) - px)) best = i;
    setHover(best);
  };

  return (
    <div ref={box} className="relative">
      <svg
        width="100%"
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="block touch-pan-y"
        role="img"
        aria-label={`${isBar ? 'Bar' : 'Line'} chart${block.text ? `: ${block.text.text}` : ''}. Show data for the numbers.`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {ticks.map((t, i) => (
          <g key={t}>
            <line x1={left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--color-border)" strokeWidth={1} />
            <text x={left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-xs">
              {tickText[i]}
            </text>
          </g>
        ))}
        {block.labels.map((label, i) =>
          i % step === 0 ? (
            <text key={i} x={cx(i)} y={H - 6} textAnchor="middle" className="fill-muted-foreground text-xs">
              {label}
            </text>
          ) : null,
        )}
        {hover !== null && (
          <line data-testid="chart-crosshair" x1={cx(hover)} x2={cx(hover)} y1={PAD.top} y2={PAD.top + PLOT_H} stroke="var(--color-border-strong)" strokeWidth={1} />
        )}
        {isBar ? <Bars block={block} y={y} cx={cx} band={band} /> : <Lines block={block} y={y} cx={cx} hover={hover} lo={lo} />}
      </svg>
      {hover !== null && <Tooltip block={block} index={hover} at={cx(hover) / W} />}
    </div>
  );
}

// useMeasuredWidth is a box's width in px, following resizes; W_DEFAULT
// until measured (and where ResizeObserver is missing).
function useMeasuredWidth(ref: React.RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(W_DEFAULT);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w > 0) setWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

// Bars: at most 24 wide, a 2px gap between a label's bars, the data end
// rounded 4px and the baseline end square.
function Bars({ block, y, cx, band }: { block: ChartBlock; y: (v: number) => number; cx: (i: number) => number; band: number }) {
  const k = block.series.length;
  const width = Math.max(2, Math.min(24, (band * 0.7 - (k - 1) * 2) / k));
  const group = k * width + (k - 1) * 2;
  const base = y(0);
  return (
    <g data-testid="chart-bars">
      {block.labels.map((_, i) =>
        block.series.map((s, j) => {
          const x = cx(i) - group / 2 + j * (width + 2);
          const top = y(s.values[i]);
          const h = base - top;
          const r = Math.min(4, h, width / 2);
          const d =
            h <= 0
              ? ''
              : `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + width - r}Q${x + width},${top} ${x + width},${top + r}V${base}Z`;
          return d ? <path key={`${i}-${j}`} d={d} style={{ fill: SERIES[j] }} /> : null;
        }),
      )}
    </g>
  );
}

// Lines: 2px, round joins; a single series gets a 10% wash beneath it; the
// end point (and the hovered one) is a dot with a 2px surface ring.
function Lines({ block, y, cx, hover, lo }: { block: ChartBlock; y: (v: number) => number; cx: (i: number) => number; hover: number | null; lo: number }) {
  const n = block.labels.length;
  return (
    <g data-testid="chart-lines">
      {block.series.map((s, j) => {
        const points = s.values.map((v, i) => `${cx(i)},${y(v)}`).join(' ');
        const dots = n === 1 ? [0] : hover === null ? [n - 1] : [hover];
        return (
          <g key={j}>
            {block.series.length === 1 && n > 1 && (
              <polygon points={`${cx(0)},${y(Math.max(lo, 0))} ${points} ${cx(n - 1)},${y(Math.max(lo, 0))}`} style={{ fill: SERIES[j], fillOpacity: 0.1 }} />
            )}
            <polyline points={points} fill="none" style={{ stroke: SERIES[j] }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {dots.map((i) => (
              <circle key={i} cx={cx(i)} cy={y(s.values[i])} r={4} style={{ fill: SERIES[j], stroke: SURFACE }} strokeWidth={2} />
            ))}
          </g>
        );
      })}
    </g>
  );
}

// Donut: one series, a slice per label with a 2px surface gap between
// slices; the total sits in the middle. Hovering a slice names it. The
// server refuses a donut whose values add up to zero.
function Donut({ block }: { block: ChartBlock }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = block.series[0].values;
  const total = values.reduce((a, b) => a + b, 0);
  const R = 70;
  const thick = 20;
  const C = 2 * Math.PI * R;
  const lengths = values.map((v) => (v / total) * C);
  const starts = lengths.map((_, i) => lengths.slice(0, i).reduce((a, b) => a + b, 0));
  return (
    <div className="relative flex flex-wrap items-center gap-x-4 gap-y-2">
      <svg
        viewBox="0 0 180 180"
        className="block h-auto w-40 max-w-full shrink-0"
        role="img"
        aria-label={`Donut chart${block.text ? `: ${block.text.text}` : ''}. Show data for the numbers.`}
      >
        <g transform="rotate(-90 90 90)">
          {values.map((v, i) =>
            v > 0 ? (
              <circle
                key={i}
                data-testid="chart-slice"
                cx={90}
                cy={90}
                r={R}
                fill="none"
                style={{ stroke: SERIES[i] }}
                strokeWidth={hover === i ? thick + 4 : thick}
                strokeDasharray={`${Math.max(0, lengths[i] - 2)} ${C}`}
                strokeDashoffset={-starts[i]}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
              />
            ) : null,
          )}
        </g>
        <text x={90} y={86} textAnchor="middle" className="fill-foreground text-base font-semibold">
          {withUnit(compact.format(hover === null ? total : values[hover]), block.unit)}
        </text>
        <text x={90} y={106} textAnchor="middle" className="fill-muted-foreground text-xs">
          {hover === null ? 'Total' : block.labels[hover]}
        </text>
      </svg>
      <ul className="flex min-w-32 flex-1 flex-col gap-1 text-xs">
        {values.map((v, i) => (
          <li key={i} className={cn('flex items-center gap-1.5', hover === i && 'font-semibold')}>
            <span aria-hidden="true" className="inline-block size-2.5 shrink-0 rounded-sm" style={{ background: SERIES[i] }} />
            <span className="truncate">{block.labels[i]}</span>
            <span className="ml-auto pl-2 tabular-nums text-muted-foreground">{Math.round((v / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
