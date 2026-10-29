import { describe, expect, it } from 'vitest';
import { useRef, type RefObject } from 'react';
import { render } from 'vitest-browser-react';
import { useAtBottomRef } from './useAtBottomRef';

// Browser coverage for the at-bottom tracker. Two shapes: a ref that is
// never attached to a DOM node (the `if (!el) return` guard, line 21)
// and an attached scroller whose scroll events flip the tracked value.

function NullRefProbe() {
  // The ref starts as null and is never wired to a real element, so the
  // effect bails at the `!el` guard. The returned ref keeps its initial
  // `true`.
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useAtBottomRef(scrollRef);
  return <div data-testid="null-probe" data-at-bottom={String(atBottom.current)} />;
}

function AttachedProbe({ height = 100 }: { height?: number }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useAtBottomRef(scrollRef);
  return (
    <div>
      <div
        ref={scrollRef}
        data-testid="scroller"
        style={{ height, overflowY: 'auto' }}
      >
        <div style={{ height: 1000 }}>tall content</div>
      </div>
      <button
        data-testid="read"
        onClick={(e) =>
          ((e.currentTarget as HTMLButtonElement).dataset.value = String(atBottom.current))
        }
      />
    </div>
  );
}

function ReportingProbe({
  reports,
  exposeRef,
  resetKey,
}: {
  reports: boolean[];
  exposeRef: (ref: RefObject<boolean>) => void;
  resetKey?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useAtBottomRef(scrollRef, (value) => reports.push(value), resetKey);
  exposeRef(atBottom);
  return (
    <div ref={scrollRef} data-testid="scroller" style={{ height: 100, overflowY: 'auto' }}>
      <div style={{ height: 1000 }}>tall content</div>
    </div>
  );
}

describe('useAtBottomRef (browser)', () => {
  // The thread panel files where its reader is (lib/read-position) from these
  // reports. It also sets the ref itself while following new replies down;
  // that must not swallow the report of the reader coming back down.
  it('reports each change once, even after the caller set the ref itself', async () => {
    const reports: boolean[] = [];
    let atBottom: RefObject<boolean> | undefined;
    const screen = await render(<ReportingProbe reports={reports} exposeRef={(ref) => (atBottom = ref)} />);
    const scroller = screen.getByTestId('scroller').element() as HTMLDivElement;
    const scrollTo = async (top: number) => {
      scroller.scrollTop = top;
      scroller.dispatchEvent(new Event('scroll'));
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    };

    // It mounts at the top, far from the bottom.
    expect(reports).toEqual([false]);
    await scrollTo(0);
    expect(reports).toEqual([false]);
    await scrollTo(scroller.scrollHeight);
    expect(reports).toEqual([false, true]);
    await scrollTo(scroller.scrollTop - 300);
    expect(reports).toEqual([false, true, false]);
    atBottom!.current = true;
    await scrollTo(scroller.scrollHeight);
    expect(reports).toEqual([false, true, false, true]);
  });

  // The thread panel stays mounted when another thread opens in it. The new
  // thread's position is reported even when it matches the old one's last
  // report: the reader scrolled up in thread A must not leave thread B
  // filed as "at the bottom".
  it('reports again from scratch when the reset key changes', async () => {
    const reports: boolean[] = [];
    const screen = await render(<ReportingProbe reports={reports} exposeRef={() => {}} resetKey="thread-a" />);
    expect(reports).toEqual([false]);
    await screen.rerender(<ReportingProbe reports={reports} exposeRef={() => {}} resetKey="thread-b" />);
    expect(reports).toEqual([false, false]);
    await screen.rerender(<ReportingProbe reports={reports} exposeRef={() => {}} resetKey="thread-b" />);
    expect(reports).toEqual([false, false]);
  });

  it('bails out of the effect when the scroll ref is never attached', async () => {
    const screen = await render(<NullRefProbe />);
    // Initialized to true; the unattached ref means no listener was wired.
    expect(screen.getByTestId('null-probe').element().getAttribute('data-at-bottom')).toBe('true');
  });

  it('tracks the at-bottom state from real scroll events', async () => {
    const screen = await render(<AttachedProbe />);
    const scroller = screen.getByTestId('scroller').element() as HTMLDivElement;
    const read = screen.getByTestId('read').element() as HTMLButtonElement;

    // Scroll to the very top — far from the bottom → atBottom should be false.
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll'));
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    read.click();
    expect(read.dataset.value).toBe('false');

    // Scroll to the bottom → within the 120px slack → atBottom true.
    scroller.scrollTop = scroller.scrollHeight;
    scroller.dispatchEvent(new Event('scroll'));
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    read.click();
    expect(read.dataset.value).toBe('true');
  });

  // The browser moves the view itself: scroll anchoring nudges it down when
  // content grows below (the event arrives before the ResizeObserver that
  // follows the growth), and a viewport growing from below (the composer
  // collapsing after a send) pulls it up while it stays at the bottom.
  // Neither is the reader leaving.
  it('keeps following through scrolls the reader did not make', async () => {
    const screen = await render(<AttachedProbe />);
    const scroller = screen.getByTestId('scroller').element() as HTMLDivElement;
    const read = screen.getByTestId('read').element() as HTMLButtonElement;
    const atBottom = () => {
      read.click();
      return read.dataset.value;
    };
    const scrollTo = async (top: number) => {
      scroller.scrollTop = top;
      scroller.dispatchEvent(new Event('scroll'));
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    };

    await scrollTo(scroller.scrollHeight);
    expect(atBottom()).toBe('true');
    // Content grew by 300px below; anchoring moved the view down by 60.
    (scroller.firstElementChild as HTMLElement).style.height = '1300px';
    await scrollTo(scroller.scrollTop + 60);
    expect(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight).toBeGreaterThan(120);
    expect(atBottom()).toBe('true');

    // A real scroll up, away from the bottom, lets go…
    await scrollTo(scroller.scrollTop - 200);
    expect(atBottom()).toBe('false');
    // …and a scroll down that stops short of the bottom does not rejoin.
    await scrollTo(scroller.scrollTop + 50);
    expect(atBottom()).toBe('false');
  });

  it('stays at the bottom when the viewport grows from below', async () => {
    const screen = await render(<AttachedProbe height={100} />);
    const scroller = screen.getByTestId('scroller').element() as HTMLDivElement;
    const read = screen.getByTestId('read').element() as HTMLButtonElement;
    scroller.scrollTop = scroller.scrollHeight;
    scroller.dispatchEvent(new Event('scroll'));
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    const before = scroller.scrollTop;
    await screen.rerender(<AttachedProbe height={400} />);
    scroller.dispatchEvent(new Event('scroll'));
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    expect(scroller.scrollTop).toBeLessThan(before);
    read.click();
    expect(read.dataset.value).toBe('true');
  });
});
