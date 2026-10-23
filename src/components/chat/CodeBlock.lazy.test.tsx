import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { CodeBlock } from './CodeBlock';
import { highlighterImport, resetCodeHighlightForTests } from '@/lib/code-highlight-loader';

// Own file: counts how often the highlighter module loads, which needs a
// module graph no other test has touched. The grammar call is wrapped so the
// remount test can count how often it runs.
const hl = vi.hoisted(() => ({ loads: 0 }));
vi.mock('@/lib/code-highlight', async (importOriginal) => {
  hl.loads++;
  const actual = await importOriginal<typeof import('@/lib/code-highlight')>();
  return { ...actual, highlightToHast: vi.fn(actual.highlightToHast) };
});

const TS = 'const answer = 42;\nfunction ask() {\n  return answer;\n}\n';

afterEach(() => {
  resetCodeHighlightForTests();
});

describe('CodeBlock lazy highlighting', () => {
  it('loads the highlighter only once a block names a supported language', async () => {
    // CodeBlock sits on every message's render path; lowlight and its
    // grammars came with it into the boot bundle.
    expect(hl.loads).toBe(0);
    render(<CodeBlock code="plain" />);
    render(<CodeBlock code="text" language="no-such-lang" />);
    expect(hl.loads).toBe(0);

    const { container } = render(<CodeBlock code={TS} language="ts" />);
    // The block is final-sized at once: gutter, label and code box are there
    // before the highlighting is.
    expect(screen.getByTestId('code-line-numbers').textContent).toBe('1\n2\n3\n4');
    const code = container.querySelector('code.hljs') as HTMLElement;
    expect(code.textContent).toBe(TS.replace(/\n$/, ''));
    expect(await screen.findByText('function')).toHaveClass('hljs-keyword');
    expect(code.textContent).toBe(TS.replace(/\n$/, ''));
    expect(hl.loads).toBe(1);
  });

  it('highlights a remounted block at its first render, without running the grammar again', async () => {
    const { highlightToHast } = await import('@/lib/code-highlight');
    const first = render(<CodeBlock code={TS} language="typescript" />);
    await screen.findByText('function');
    const runs = vi.mocked(highlightToHast).mock.calls.length;
    first.unmount();

    // A virtualized row scrolled back into view.
    const { container } = render(<CodeBlock code={TS} language="typescript" />);
    expect(container.querySelector('.hljs-keyword')).not.toBeNull();
    expect(vi.mocked(highlightToHast).mock.calls.length).toBe(runs);
  });

  it('keeps a block plain when the highlighter fails to load, and the next block tries again', async () => {
    const fail = { reject: (_err: Error) => undefined as void };
    highlighterImport.load = () => new Promise((_resolve, reject) => { fail.reject = reject; });
    const { container } = render(<CodeBlock code={TS} language="ts" />);
    await act(async () => {
      fail.reject(new Error('chunk gone'));
    });
    expect(container.querySelector('[class^="hljs-"]')).toBeNull();
    expect(screen.getByTestId('code-line-numbers')).toBeInTheDocument();

    highlighterImport.load = () => import('@/lib/code-highlight');
    render(<CodeBlock code="let x = 1" language="js" />);
    expect(await screen.findByText('let')).toHaveClass('hljs-keyword');
  });
});
