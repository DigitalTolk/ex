import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { Calendar } from './calendar';

describe('Calendar', () => {
  it('selects a day, pages months with the chevrons, and follows arrow-key focus', async () => {
    const onSelect = vi.fn();
    await render(<Calendar mode="single" selected={new Date(2999, 0, 10)} month={new Date(2999, 0, 1)} onSelect={onSelect} />);
    const day = (n: number) => document.querySelector(`[data-day="${new Date(2999, 0, n).toLocaleDateString()}"]`) as HTMLButtonElement;
    expect(day(10).getAttribute('data-selected-single')).toBe('true');
    await userEvent.click(day(12));
    expect(onSelect).toHaveBeenCalled();
    expect((onSelect.mock.calls[0][0] as Date).getDate()).toBe(12);

    // Keyboard: the picker marks the next day focused and the button follows.
    day(12).focus();
    await userEvent.keyboard('{ArrowRight}');
    await vi.waitFor(() => expect(document.activeElement).toBe(day(13)));

    await userEvent.click(document.querySelector('button[aria-label*="Next"]') as HTMLButtonElement);
    await vi.waitFor(() => expect(document.querySelector(`[data-day="${new Date(2999, 1, 1).toLocaleDateString()}"]`)).not.toBeNull());
    await userEvent.click(document.querySelector('button[aria-label*="Previous"]') as HTMLButtonElement);
    await vi.waitFor(() => expect(day(10)).not.toBeNull());
  });
});
