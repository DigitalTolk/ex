import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SidePanel } from './SidePanel';

// The drag physics live in useSwipeDismiss (Motion, pointer-based) and are
// unit-tested there; here we mock it so the panel chrome is deterministic.
vi.mock('@/hooks/useSwipeDismiss', () => ({
  useSwipeDismiss: () => ({ dismissing: false, settled: true, motionProps: {} }),
}));

describe('SidePanel', () => {
  it('renders the title, body, and an arrow close button', () => {
    const onClose = vi.fn();
    render(
      <SidePanel title="Files" ariaLabel="Files" closeLabel="Close files" onClose={onClose}>
        <p>body</p>
      </SidePanel>,
    );
    expect(screen.getByText('Files')).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Close files'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('has no left border on mobile (only md:border-l) and sits under the app header', () => {
    render(
      <SidePanel title="Files" ariaLabel="Files" closeLabel="Close files" onClose={vi.fn()}>
        <p>body</p>
      </SidePanel>,
    );
    const panel = screen.getByLabelText('Files');
    expect(panel).toHaveClass('md:border-l');
    // No unconditional border-l (it would show on mobile).
    expect(panel.className).not.toMatch(/(^|\s)border-l(\s|$)/);
    expect(panel).toHaveClass('max-md:top-[var(--mobile-right-panel-top,6rem)]');
    expect(panel.className).not.toContain('safe-area-inset-top');
  });
});
