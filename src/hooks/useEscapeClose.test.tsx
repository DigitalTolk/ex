import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useEscapeClose } from './useEscapeClose';

function Panel({ onClose }: { onClose?: () => void }) {
  useEscapeClose(onClose);
  return (
    <aside>
      <button type="button">action</button>
      <input aria-label="field" />
    </aside>
  );
}

function press(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(event);
  return event;
}

afterEach(() => {
  (document.activeElement as HTMLElement | null)?.blur();
});

describe('useEscapeClose', () => {
  it('closes the panel on an Escape nobody else took, and takes the key', () => {
    const onClose = vi.fn();
    render(<Panel onClose={onClose} />);
    const event = press('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    press('Enter');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // A menu, dialog, popover or the lightbox closing on the same Escape marks
  // it handled: the panel under it stays.
  it('leaves an Escape a layer above already took', () => {
    const onClose = vi.fn();
    render(<Panel onClose={onClose} />);
    const takeIt = (e: KeyboardEvent) => e.preventDefault();
    document.addEventListener('keydown', takeIt);
    try {
      press('Escape');
    } finally {
      document.removeEventListener('keydown', takeIt);
    }
    expect(onClose).not.toHaveBeenCalled();
  });

  it('leaves an Escape that ends an IME composition', () => {
    const onClose = vi.fn();
    render(<Panel onClose={onClose} />);
    press('Escape', { isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a text field keeps the first Escape (it lets go of the field); the next closes', () => {
    const onClose = vi.fn();
    const { getByLabelText } = render(<Panel onClose={onClose} />);
    const field = getByLabelText('field');
    field.focus();
    press('Escape');
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(field);
    press('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('without an onClose leaves the key alone', () => {
    render(<Panel />);
    expect(press('Escape').defaultPrevented).toBe(false);
  });

  it('stops listening when the panel goes', () => {
    const onClose = vi.fn();
    const { unmount } = render(<Panel onClose={onClose} />);
    unmount();
    press('Escape');
    expect(onClose).not.toHaveBeenCalled();
  });
});
