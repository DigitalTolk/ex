import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { CodeBlock } from './CodeBlock';
import { copyToClipboard } from '@/lib/clipboard';

vi.mock('@/lib/clipboard', () => ({
  copyToClipboard: vi.fn(async () => {}),
}));

// Browser twin for the copied-state arms: clicking copy flips the button
// into its confirmation state (label, tooltip, check icon) and back.

let active: { unmount: () => Promise<void> } | null = null;
afterEach(async () => {
  if (active) await active.unmount();
  active = null;
  vi.mocked(copyToClipboard).mockClear();
});

describe('CodeBlock copy confirmation (browser)', () => {
  it('flips to "Copied" after a click and returns to rest', async () => {
    const result = await render(<CodeBlock code={'const a = 1;\n'} language="ts" />);
    active = result;
    const btn = document.querySelector('[data-testid="code-copy-button"]') as HTMLButtonElement;
    expect(btn.getAttribute('aria-label')).toBe('Copy code');

    btn.click();
    await expect.poll(() => btn.getAttribute('aria-label')).toBe('Copied');
    expect(btn.getAttribute('title')).toBe('Copied');
    expect(vi.mocked(copyToClipboard)).toHaveBeenCalledWith('const a = 1;\n');

    // The confirmation resets after its 1.5s timeout.
    await expect.poll(() => btn.getAttribute('aria-label'), { timeout: 3000 }).toBe('Copy code');
  });
});
