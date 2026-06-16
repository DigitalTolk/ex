import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CodeBlock } from './CodeBlock';

const copyMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/lib/clipboard', () => ({
  copyToClipboard: (...args: unknown[]) => copyMock(...args),
}));

afterEach(() => {
  copyMock.mockClear();
  vi.useRealTimers();
});

describe('CodeBlock', () => {
  it('highlights a known language, renders a gutter, and shows a language indicator', () => {
    render(<CodeBlock code={'function a(){}\nreturn 1'} language="js" />);
    const gutter = screen.getByTestId('code-line-numbers');
    expect(gutter.textContent).toBe('1\n2');
    expect(document.querySelector('code.hljs')).not.toBeNull();
    expect(document.querySelector('pre[data-language="js"]')).not.toBeNull();
    const langLabel = screen.getByTestId('code-language');
    expect(langLabel.textContent).toBe('js');
    // Hidden on mobile (cramped width), shown from md up.
    expect(langLabel).toHaveClass('hidden', 'md:inline-block');
  });

  it('renders an icon-only copy button (no text label)', () => {
    render(<CodeBlock code={'x'} language="js" />);
    const btn = screen.getByTestId('code-copy-button');
    expect(btn.textContent).toBe('');
    expect(btn).toHaveAttribute('aria-label', 'Copy code');
    expect(btn.querySelector('svg')).not.toBeNull();
  });

  it('omits the language indicator when no language is given', () => {
    render(<CodeBlock code={'plain'} />);
    expect(screen.queryByTestId('code-language')).toBeNull();
  });

  it('renders plain text with no gutter for an unknown language', () => {
    render(<CodeBlock code={'just text'} language="weird-lang" />);
    expect(screen.queryByTestId('code-line-numbers')).toBeNull();
    expect(screen.getByText('just text')).toBeInTheDocument();
  });

  it('renders plain text with no gutter when no language is given', () => {
    render(<CodeBlock code={'plain'} />);
    expect(screen.queryByTestId('code-line-numbers')).toBeNull();
    expect(screen.getByText('plain')).toBeInTheDocument();
  });

  it('copies the raw code, flips the icon state to copied, then resets', async () => {
    vi.useFakeTimers();
    render(<CodeBlock code={'x = 1\n'} language="python" />);
    const btn = screen.getByTestId('code-copy-button');
    fireEvent.click(btn);
    // Flush the awaited copyToClipboard microtask.
    await act(async () => {
      await Promise.resolve();
    });
    // Copies the raw code including the trailing newline.
    expect(copyMock).toHaveBeenCalledWith('x = 1\n');
    expect(btn).toHaveAttribute('aria-label', 'Code copied');
    act(() => vi.advanceTimersByTime(1600));
    expect(btn).toHaveAttribute('aria-label', 'Copy code');
  });
});
