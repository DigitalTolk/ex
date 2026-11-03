import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { Chart } from './Chart';
import { BlockList } from './MessageBlocks';
import { niceScale } from '@/lib/chart-scale';
import type { Block } from '@/types';

type ChartBlock = Extract<Block, { type: 'chart' }>;

const bar: ChartBlock = {
  type: 'chart',
  block_id: 'b1',
  kind: 'bar',
  text: { type: 'plain_text', text: 'Signups by day' },
  labels: ['Mon', 'Tue', 'Wed'],
  series: [
    { name: 'Web', values: [180, 0, 195] },
    { name: 'Mobile', values: [60, 72, 70] },
  ],
};

// Points the pointer at a fraction of the chart's width.
function hoverAt(svg: Element, fraction: number) {
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 560, height: 200, right: 560, bottom: 200, x: 0, y: 0, toJSON: () => ({}) });
  fireEvent.pointerMove(svg, { clientX: 560 * fraction, clientY: 100 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Chart', () => {
  it('draws a bar chart with a title, legend, bars (none for a zero) and its data on request', () => {
    render(<Chart block={bar} />);
    expect(screen.getByText('Signups by day').tagName).toBe('FIGCAPTION');
    const svg = screen.getByRole('img', { name: 'Bar chart: Signups by day. Show data for the numbers.' });
    expect(svg).toHaveAttribute('height', '200');
    // Six bars minus the zero.
    expect(svg.querySelectorAll('[data-testid="chart-bars"] path')).toHaveLength(5);
    expect(within(screen.getByTestId('chart-legend')).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Web', 'Mobile']);

    const show = screen.getByRole('button', { name: 'Show data' });
    fireEvent.click(show);
    const table = screen.getByRole('table');
    expect(show).toHaveAttribute('aria-expanded', 'true');
    expect(table.parentElement).toHaveAttribute('id', show.getAttribute('aria-controls'));
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['', 'Web', 'Mobile']);
    expect(within(table).getByRole('rowheader', { name: 'Tue' }).parentElement!.textContent).toBe('Tue072');
    fireEvent.click(screen.getByRole('button', { name: 'Hide data' }));
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows the hovered label in a tooltip, flipping it near the right edge', () => {
    render(<Chart block={bar} />);
    const svg = screen.getByRole('img');
    hoverAt(svg, 0.1);
    const tip = screen.getByTestId('chart-tooltip');
    expect(tip).toHaveTextContent('Mon');
    expect(tip).toHaveTextContent('Web180');
    expect(tip.style.left).not.toBe('');
    expect(screen.getByTestId('chart-crosshair')).toBeInTheDocument();
    hoverAt(svg, 0.95);
    expect(screen.getByTestId('chart-tooltip')).toHaveTextContent('Wed');
    expect(screen.getByTestId('chart-tooltip').style.right).not.toBe('');
    fireEvent.pointerLeave(svg);
    expect(screen.queryByTestId('chart-tooltip')).toBeNull();
  });

  it('draws lines: a wash under a single series, the end dot, units on the axis', () => {
    const { container } = render(
      <Chart
        block={{ type: 'chart', block_id: 'b1', kind: 'line', unit: 'ms', labels: ['W1', 'W2', 'W3'], series: [{ values: [-20, 10, 30] }] }}
      />,
    );
    expect(screen.getByRole('img', { name: 'Line chart. Show data for the numbers.' })).toBeInTheDocument();
    expect(container.querySelector('polygon')).not.toBeNull();
    expect(container.querySelectorAll('circle')).toHaveLength(1);
    expect(container.textContent).toContain('20 ms');
    expect(container.textContent).toContain('-20 ms');
    // No legend for one series: the title names it.
    expect(screen.queryByTestId('chart-legend')).toBeNull();
    hoverAt(screen.getByRole('img'), 0.5);
    expect(screen.getByTestId('chart-tooltip')).toHaveTextContent('W210 ms');
  });

  it('draws several lines without a wash, and a single point', () => {
    const { container, unmount } = render(
      <Chart
        block={{ type: 'chart', block_id: 'b1', kind: 'line', unit: '%', labels: ['Q1', 'Q2'], series: [{ name: 'A', values: [1, 2] }, { name: 'B', values: [3, 4] }] }}
      />,
    );
    expect(container.querySelector('polygon')).toBeNull();
    expect(container.querySelectorAll('polyline')).toHaveLength(2);
    expect(container.textContent).toContain('4%');
    unmount();
    const one = render(<Chart block={{ type: 'chart', block_id: 'b2', kind: 'line', labels: ['Now'], series: [{ values: [5] }] }} />);
    expect(one.container.querySelector('polygon')).toBeNull();
    expect(one.container.querySelectorAll('circle')).toHaveLength(1);
    hoverAt(screen.getByRole('img'), 0.5);
    expect(screen.getByTestId('chart-tooltip')).toHaveTextContent('Now');
  });

  it('draws a donut: slices (none for a zero), the total, and the hovered slice', () => {
    render(
      <Chart
        block={{ type: 'chart', block_id: 'b1', kind: 'donut', text: { type: 'plain_text', text: 'Plan mix' }, unit: 'seats', labels: ['Free', 'Team', 'Gone'], series: [{ values: [600, 400, 0] }] }}
      />,
    );
    expect(screen.getByRole('img', { name: 'Donut chart: Plan mix. Show data for the numbers.' })).toBeInTheDocument();
    const slices = screen.getAllByTestId('chart-slice');
    expect(slices).toHaveLength(2);
    expect(screen.getByText('1K seats')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('60%')).toBeInTheDocument();
    expect(screen.getByText('0%')).toBeInTheDocument();
    fireEvent.pointerEnter(slices[1]);
    expect(screen.getByText('400 seats')).toBeInTheDocument();
    expect(screen.getAllByText('Team')).toHaveLength(2);
    expect(screen.getByText('Team', { selector: 'span' }).closest('li')).toHaveClass('font-semibold');
    fireEvent.pointerLeave(slices[1]);
    expect(screen.getByText('Total')).toBeInTheDocument();
  });

  it('draws at the width of its box, following resizes', () => {
    let notify: (entries: { contentRect: { width: number } }[]) => void = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: typeof notify) {
          notify = cb;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    const { unmount } = render(<Chart block={bar} />);
    const svg = screen.getByRole('img');
    expect(svg).toHaveAttribute('viewBox', '0 0 560 200');
    act(() => notify([{ contentRect: { width: 320.4 } }]));
    expect(svg).toHaveAttribute('viewBox', '0 0 320 200');
    act(() => notify([{ contentRect: { width: 0 } }]));
    expect(svg).toHaveAttribute('viewBox', '0 0 320 200');
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });
});

describe('Chart edges', () => {
  it('names an unnamed series "Value" in its data, thins crowded labels, and draws without ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const labels = Array.from({ length: 30 }, (_, i) => `D${i + 1}`);
    const { container } = render(<Chart block={{ type: 'chart', block_id: 'b1', kind: 'line', labels, series: [{ values: labels.map((_, i) => i) }] }} />);
    expect(screen.getByRole('img')).toHaveAttribute('viewBox', '0 0 560 200');
    const shown = [...container.querySelectorAll('svg text')].map((t) => t.textContent).filter((t) => t?.startsWith('D'));
    expect(shown.length).toBeLessThan(30);
    expect(shown[0]).toBe('D1');
    fireEvent.click(screen.getByRole('button', { name: 'Show data' }));
    expect(screen.getByRole('columnheader', { name: 'Value' })).toBeInTheDocument();
  });

  it('labels a donut with no title, and is drawn for a chart block in a message', () => {
    render(<BlockList blocks={[{ type: 'chart', block_id: 'b1', kind: 'donut', labels: ['A', 'B'], series: [{ values: [1, 3] }] }]} />);
    expect(screen.getByRole('img', { name: 'Donut chart. Show data for the numbers.' })).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(within(screen.getByTestId('message-blocks')).getByTestId('block-chart')).toBeInTheDocument();
  });
});

describe('Columns', () => {
  it('lays columns side by side in their shares, each with its own blocks', () => {
    render(
      <BlockList
        blocks={[
          {
            type: 'columns',
            block_id: 'b1',
            blocks: [
              { type: 'column', block_id: 'b2', width: 2, blocks: [{ type: 'rich_text', block_id: 'b3', content: [{ type: 'paragraph', spans: [{ type: 'text', text: 'Left' }] }] }] },
              { type: 'column', block_id: 'b4', blocks: [] },
              { type: 'divider', block_id: 'b5' },
            ],
          },
        ]}
      />,
    );
    const row = screen.getByTestId('block-columns');
    const grid = row.firstElementChild as HTMLElement;
    expect(grid.style.getPropertyValue('--ex-columns')).toBe('2fr 1fr');
    const cols = within(row).getAllByTestId('block-column');
    expect(cols).toHaveLength(2);
    expect(cols[0]).toHaveTextContent('Left');
    expect(cols[1].textContent).toBe('');
  });

  it('draws nothing for a stray column', () => {
    const { container } = render(<BlockList blocks={[{ type: 'column', block_id: 'b1', blocks: [] }]} />);
    expect(container.querySelector('[data-testid="message-blocks"]')!.textContent).toBe('');
  });
});

describe('niceScale', () => {
  it('covers the range with clean ticks, zero always in it', () => {
    expect(niceScale(3, 87)).toEqual({ lo: 0, hi: 100, ticks: [0, 25, 50, 75, 100] });
    expect(niceScale(-20, 30).ticks).toEqual([-20, 0, 20, 40]);
    expect(niceScale(0, 0)).toEqual({ lo: 0, hi: 1, ticks: [0, 0.25, 0.5, 0.75, 1] });
    expect(niceScale(0, 9.3e6).hi).toBe(1e7);
    // A raw step past 5× its magnitude rounds up to the next power of ten.
    expect(niceScale(0, 28).ticks).toEqual([0, 10, 20, 30]);
  });
});
