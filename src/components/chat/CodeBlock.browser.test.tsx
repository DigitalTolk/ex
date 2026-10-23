import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { CodeBlock } from './CodeBlock';
import { copyToClipboard } from '@/lib/clipboard';
import { highlighterImport, resetCodeHighlightForTests } from '@/lib/code-highlight-loader';

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
  resetCodeHighlightForTests();
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

describe('CodeBlock lazy highlighting (browser)', () => {
  // A chat row must paint at its final height: react-virtuoso measures it on
  // first paint, and a block that grew when its colours arrived would shift
  // the list and break scroll-to-bottom (CLAUDE.md, explicit dimensions).
  it('keeps its exact size when the highlighting arrives', async () => {
    resetCodeHighlightForTests();
    const pending = { resolve: () => undefined as void };
    const load = highlighterImport.load;
    highlighterImport.load = () =>
      new Promise((resolve) => {
        pending.resolve = () => resolve(load());
      });
    const code = [
      'export function greet(name: string): string {',
      '  // say hello',
      '  const greeting = `Hello, ${name}!`;',
      '  return greeting.repeat(2) + 42;',
      '}',
      '',
    ].join('\n');
    const result = await render(
      <div style={{ width: 320 }}>
        <CodeBlock code={code} language="ts" />
      </div>,
    );
    active = result;
    const block = result.container.querySelector('[data-testid="code-line-numbers"]')!.closest('.group') as HTMLElement;
    const codeBox = block.querySelector('pre[data-language] code') as HTMLElement;
    expect(codeBox.querySelector('[class^="hljs-"]')).toBeNull();
    const before = block.getBoundingClientRect();
    const textBefore = codeBox.textContent;

    pending.resolve();
    await expect.poll(() => codeBox.querySelector('.hljs-keyword')).not.toBeNull();
    const after = block.getBoundingClientRect();
    expect(after.height).toBe(before.height);
    expect(after.width).toBe(before.width);
    expect(codeBox.textContent).toBe(textBefore);
  });
});
