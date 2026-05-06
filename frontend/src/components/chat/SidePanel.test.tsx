import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SidePanel } from './SidePanel';

describe('SidePanel', () => {
  it('closes on a right-sidebar mobile left swipe', () => {
    const onClose = vi.fn();
    render(
      <SidePanel title="Files" ariaLabel="Files" closeLabel="Close files" onClose={onClose}>
        <p>body</p>
      </SidePanel>,
    );

    const panel = screen.getByLabelText('Files');
    fireEvent.pointerDown(panel, { pointerType: 'touch', clientX: 220, clientY: 120 });
    fireEvent.pointerUp(panel, { pointerType: 'touch', clientX: 120, clientY: 128 });

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
    fireEvent.pointerDown(panel, { pointerType: 'mouse', clientX: 220, clientY: 120 });
    fireEvent.pointerUp(panel, { pointerType: 'mouse', clientX: 120, clientY: 128 });

    expect(onClose).not.toHaveBeenCalled();
  });
});
