import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SidePanel } from './SidePanel';

function touchSwipe(element: Element, fromX: number, toX: number, y = 120) {
  fireEvent.touchStart(element, { touches: [{ clientX: fromX, clientY: y }] });
  fireEvent.touchMove(element, { touches: [{ clientX: toX, clientY: y + 8 }] });
  fireEvent.touchEnd(element, { changedTouches: [{ clientX: toX, clientY: y + 8 }] });
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
    touchSwipe(panel, 220, 120);

    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on a right-sidebar mobile left-to-right swipe', () => {
    const onClose = vi.fn();
    render(
      <SidePanel title="Files" ariaLabel="Files" closeLabel="Close files" onClose={onClose}>
        <p>body</p>
      </SidePanel>,
    );

    const panel = screen.getByLabelText('Files');
    touchSwipe(panel, 120, 220);

    expect(onClose).toHaveBeenCalledTimes(1);
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
