import { describe, it, expect, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { usePanelWidth } from './usePanelWidth';
import { PANEL_WIDTHS_RESET_EVENT, SIDEBAR_WIDTH, SIDE_PANEL_WIDTH } from '@/lib/panel-width';

function Probe({ grow }: { grow: 'right' | 'left' }) {
  const cfg = grow === 'right' ? SIDEBAR_WIDTH : SIDE_PANEL_WIDTH;
  const { width, handleProps } = usePanelWidth(cfg, grow, 'Resize test panel');
  return (
    <div>
      <span data-testid="width">{width}</span>
      <div data-testid="handle" {...handleProps} />
    </div>
  );
}

function widthValue() {
  return Number(screen.getByTestId('width').textContent);
}

// jsdom has no PointerEvent constructor; MouseEvent carries the same
// clientX/button fields the hook reads, and the listeners are registered for
// pointer* event TYPES, so dispatching works identically.
function pointer(type: string, opts: { clientX?: number; button?: number } = {}) {
  return new MouseEvent(type, { bubbles: true, clientX: opts.clientX ?? 0, button: opts.button ?? 0 });
}

describe('usePanelWidth', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('drags wider and persists the width on pointerup (grow=right)', () => {
    render(<Probe grow="right" />);
    const handle = screen.getByTestId('handle');
    expect(widthValue()).toBe(SIDEBAR_WIDTH.defaultWidth);

    act(() => {
      handle.dispatchEvent(pointer('pointerdown', { clientX: 100 }));
      handle.dispatchEvent(pointer('pointermove', { clientX: 160 }));
    });
    expect(widthValue()).toBe(SIDEBAR_WIDTH.defaultWidth + 60);
    act(() => {
      handle.dispatchEvent(pointer('pointerup'));
    });
    expect(localStorage.getItem(SIDEBAR_WIDTH.key)).toBe(String(SIDEBAR_WIDTH.defaultWidth + 60));
  });

  it('grow=left widens when the pointer moves left (right-hand panel)', () => {
    render(<Probe grow="left" />);
    const handle = screen.getByTestId('handle');
    act(() => {
      handle.dispatchEvent(pointer('pointerdown', { clientX: 500 }));
      handle.dispatchEvent(pointer('pointermove', { clientX: 440 }));
      handle.dispatchEvent(pointer('pointerup'));
    });
    expect(widthValue()).toBe(SIDE_PANEL_WIDTH.defaultWidth + 60);
  });

  it('clamps a drag beyond the bounds', () => {
    render(<Probe grow="right" />);
    const handle = screen.getByTestId('handle');
    act(() => {
      handle.dispatchEvent(pointer('pointerdown', { clientX: 0 }));
      handle.dispatchEvent(pointer('pointermove', { clientX: 5000 }));
      handle.dispatchEvent(pointer('pointerup'));
    });
    expect(widthValue()).toBe(SIDEBAR_WIDTH.max);
    act(() => {
      handle.dispatchEvent(pointer('pointerdown', { clientX: 5000 }));
      handle.dispatchEvent(pointer('pointermove', { clientX: -5000 }));
      handle.dispatchEvent(pointer('pointercancel'));
    });
    expect(widthValue()).toBe(SIDEBAR_WIDTH.min);
  });

  it('ignores non-primary buttons', () => {
    render(<Probe grow="right" />);
    const handle = screen.getByTestId('handle');
    act(() => {
      handle.dispatchEvent(pointer('pointerdown', { clientX: 100, button: 2 }));
      handle.dispatchEvent(pointer('pointermove', { clientX: 300 }));
    });
    expect(widthValue()).toBe(SIDEBAR_WIDTH.defaultWidth);
  });

  it('keyboard arrows follow screen direction; Home resets', () => {
    render(<Probe grow="right" />);
    const handle = screen.getByTestId('handle');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(widthValue()).toBe(SIDEBAR_WIDTH.defaultWidth + 16);
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(widthValue()).toBe(SIDEBAR_WIDTH.defaultWidth - 16);
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(widthValue()).toBe(SIDEBAR_WIDTH.defaultWidth);
    // Unrelated keys do nothing.
    fireEvent.keyDown(handle, { key: 'Enter' });
    expect(widthValue()).toBe(SIDEBAR_WIDTH.defaultWidth);
  });

  it('screen-direction arrows invert for a right-hand panel (grow=left)', () => {
    render(<Probe grow="left" />);
    const handle = screen.getByTestId('handle');
    // ArrowRight moves the handle right → right panel gets NARROWER.
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(widthValue()).toBe(SIDE_PANEL_WIDTH.defaultWidth - 16);
  });

  it('double-click resets to the default and persists it', () => {
    localStorage.setItem(SIDEBAR_WIDTH.key, '350');
    render(<Probe grow="right" />);
    expect(widthValue()).toBe(350);
    fireEvent.doubleClick(screen.getByTestId('handle'));
    expect(widthValue()).toBe(SIDEBAR_WIDTH.defaultWidth);
  });

  it('snaps back when the global reset event fires (profile settings)', () => {
    localStorage.setItem(SIDEBAR_WIDTH.key, '350');
    render(<Probe grow="right" />);
    expect(widthValue()).toBe(350);
    act(() => {
      window.dispatchEvent(new Event(PANEL_WIDTHS_RESET_EVENT));
    });
    expect(widthValue()).toBe(SIDEBAR_WIDTH.defaultWidth);
  });

  it('exposes the separator a11y contract', () => {
    render(<Probe grow="right" />);
    const handle = screen.getByTestId('handle');
    expect(handle).toHaveAttribute('role', 'separator');
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle).toHaveAttribute('aria-valuemin', String(SIDEBAR_WIDTH.min));
    expect(handle).toHaveAttribute('aria-valuemax', String(SIDEBAR_WIDTH.max));
    expect(handle).toHaveAttribute('aria-valuenow', String(SIDEBAR_WIDTH.defaultWidth));
  });
});

describe('usePanelWidth drag edge cases', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('ignores a stray pointermove after the drag ended', () => {
    render(<Probe grow="right" />);
    const handle = screen.getByTestId('handle');
    act(() => {
      handle.dispatchEvent(pointer('pointerdown', { clientX: 100 }));
      handle.dispatchEvent(pointer('pointerup'));
      // Listener teardown raced by a queued move: the drag record is gone,
      // so the move must be a no-op.
      handle.dispatchEvent(pointer('pointermove', { clientX: 300 }));
    });
    expect(widthValue()).toBe(SIDEBAR_WIDTH.defaultWidth);
  });

  it('a pointercancel after pointerup does not double-save', () => {
    render(<Probe grow="right" />);
    const handle = screen.getByTestId('handle');
    act(() => {
      handle.dispatchEvent(pointer('pointerdown', { clientX: 100 }));
      handle.dispatchEvent(pointer('pointermove', { clientX: 150 }));
      handle.dispatchEvent(pointer('pointerup'));
      handle.dispatchEvent(pointer('pointercancel'));
    });
    expect(widthValue()).toBe(SIDEBAR_WIDTH.defaultWidth + 50);
    expect(localStorage.getItem(SIDEBAR_WIDTH.key)).toBe(String(SIDEBAR_WIDTH.defaultWidth + 50));
  });
});
