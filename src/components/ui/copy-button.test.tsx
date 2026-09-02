import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { COPY_FEEDBACK_MS, CopyButton } from '@/components/ui/copy-button';

const copyMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: copyMock }));

beforeEach(() => {
  copyMock.mockClear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function clickCopy(button: HTMLElement) {
  fireEvent.click(button);
  // Flush the awaited copyToClipboard microtask.
  await act(async () => {
    await Promise.resolve();
  });
}

describe('CopyButton', () => {
  it('copies the value and confirms, then returns to rest', async () => {
    render(<CopyButton value="https://ex.test/hook/abc" label="Copy webhook URL" />);
    const button = screen.getByRole('button', { name: 'Copy webhook URL' });
    expect(button).toHaveAttribute('data-copied', 'false');

    await clickCopy(button);

    expect(copyMock).toHaveBeenCalledWith('https://ex.test/hook/abc');
    expect(button).toHaveAttribute('aria-label', 'Copied');
    expect(button).toHaveAttribute('title', 'Copied');
    expect(button).toHaveAttribute('data-copied', 'true');

    act(() => vi.advanceTimersByTime(COPY_FEEDBACK_MS + 100));
    expect(button).toHaveAttribute('aria-label', 'Copy webhook URL');
    expect(button).toHaveAttribute('data-copied', 'false');
  });

  // A boolean "copied" flag cannot express this: the second click would not
  // change state, so no effect re-runs and the checkmark vanishes on the FIRST
  // click's schedule — a fraction of a second after the user's second copy.
  it('restarts the confirmation window when clicked again mid-confirmation', async () => {
    render(<CopyButton value="x" label="Copy thing" />);
    const button = screen.getByRole('button', { name: 'Copy thing' });

    await clickCopy(button);
    act(() => vi.advanceTimersByTime(COPY_FEEDBACK_MS - 200));
    expect(button).toHaveAttribute('data-copied', 'true');

    await clickCopy(button);
    // Past the FIRST click's deadline, still confirming.
    act(() => vi.advanceTimersByTime(300));
    expect(button).toHaveAttribute('data-copied', 'true');
    expect(copyMock).toHaveBeenCalledTimes(2);

    act(() => vi.advanceTimersByTime(COPY_FEEDBACK_MS));
    expect(button).toHaveAttribute('data-copied', 'false');
  });

  it('is an icon-only control (no text label) and accepts style overrides', () => {
    render(
      <CopyButton
        value="x"
        label="Copy code"
        variant="outline"
        size="icon-xs"
        className="opacity-0"
        data-testid="code-copy-button"
      />,
    );
    const button = screen.getByTestId('code-copy-button');
    expect(button.textContent).toBe('');
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button.className).toContain('opacity-0');
    // icon-xs sizing, not the icon-sm default.
    expect(button.className).toContain('size-6');
  });
});
