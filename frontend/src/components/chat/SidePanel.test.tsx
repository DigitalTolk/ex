import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SidePanel } from './SidePanel';

function touchSwipe(element: Element, fromX: number, toX: number, y = 120) {
  fireEvent.touchStart(element, { touches: [{ clientX: fromX, clientY: y }] });
  fireEvent.touchMove(element, { touches: [{ clientX: toX, clientY: y + 8 }] });
  fireEvent.touchEnd(element, { changedTouches: [{ clientX: toX, clientY: y + 8 }] });
}

function touchDrag(element: Element, fromX: number, toX: number, y = 120) {
  fireEvent.touchStart(element, { touches: [{ clientX: fromX, clientY: y }] });
  fireEvent.touchMove(element, { touches: [{ clientX: toX, clientY: y + 8 }] });
}

describe('SidePanel', () => {
  it('does not close on a right-sidebar mobile right-to-left swipe', () => {
    const onClose = vi.fn();
    render(
      <SidePanel title="Files" ariaLabel="Files" closeLabel="Close files" onClose={onClose}>
        <p>body</p>
      </SidePanel>,
    );

    const panel = screen.getByLabelText('Files');
    expect(panel).toHaveClass('mobile-right-sidebar-enter');
    touchSwipe(panel, 220, 120);

    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on a right-sidebar mobile left-to-right swipe', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(
      <SidePanel title="Files" ariaLabel="Files" closeLabel="Close files" onClose={onClose}>
        <p>body</p>
      </SidePanel>,
    );

    const panel = screen.getByLabelText('Files');
    touchSwipe(panel, 120, 220);

    expect(panel).toHaveAttribute('data-swipe-dismissing', 'true');
    expect(panel).toHaveClass('max-md:translate-x-full');
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(180));
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('tracks the finger while a right-sidebar swipe is in progress', () => {
    const onClose = vi.fn();
    render(
      <SidePanel title="Files" ariaLabel="Files" closeLabel="Close files" onClose={onClose}>
        <p>body</p>
      </SidePanel>,
    );

    const panel = screen.getByLabelText('Files');
    touchDrag(panel, 120, 180);

    expect(panel).toHaveStyle({ transform: 'translateX(60px)', transition: 'none' });
    expect(panel).toHaveAttribute('data-swipe-dismissing', 'false');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('settles back when a right-sidebar drag does not pass the close threshold', () => {
    const onClose = vi.fn();
    render(
      <SidePanel title="Files" ariaLabel="Files" closeLabel="Close files" onClose={onClose}>
        <p>body</p>
      </SidePanel>,
    );

    const panel = screen.getByLabelText('Files');
    touchSwipe(panel, 120, 170);

    expect(panel).not.toHaveStyle({ transform: 'translateX(50px)' });
    expect(panel).toHaveAttribute('data-swipe-dismissing', 'false');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ignores mouse drags so desktop panel behavior is unchanged', () => {
    const onClose = vi.fn();
    render(
      <SidePanel title="Files" ariaLabel="Files" closeLabel="Close files" onClose={onClose}>
        <p>body</p>
      </SidePanel>,
    );

    const panel = screen.getByLabelText('Files');
    fireEvent.mouseDown(panel, { clientX: 220, clientY: 120 });
    fireEvent.mouseUp(panel, { clientX: 120, clientY: 128 });

    expect(onClose).not.toHaveBeenCalled();
  });
});
