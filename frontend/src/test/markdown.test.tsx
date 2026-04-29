import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { renderMarkdown } from '@/lib/markdown';

describe('renderMarkdown', () => {
  it('renders h1-h6 headers', () => {
    const { container } = render(<>{renderMarkdown('# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6')}</>);
    expect(container.querySelector('h1')?.textContent).toBe('H1');
    expect(container.querySelector('h2')?.textContent).toBe('H2');
    expect(container.querySelector('h3')?.textContent).toBe('H3');
    expect(container.querySelector('h4')?.textContent).toBe('H4');
    expect(container.querySelector('h5')?.textContent).toBe('H5');
    expect(container.querySelector('h6')?.textContent).toBe('H6');
  });

  it('renders bold/italic/strikethrough/code', () => {
    const { container } = render(
      <>{renderMarkdown('**b** *i* ~~s~~ `c`')}</>,
    );
    expect(container.querySelector('strong')?.textContent).toBe('b');
    expect(container.querySelector('em')?.textContent).toBe('i');
    expect(container.querySelector('s')?.textContent).toBe('s');
    expect(container.querySelector('code')?.textContent).toBe('c');
  });

  it('renders unordered and ordered lists', () => {
    const { container } = render(
      <>{renderMarkdown('- one\n- two\n\n1. alpha\n2. beta')}</>,
    );
    expect(container.querySelectorAll('ul li').length).toBe(2);
    expect(container.querySelectorAll('ol li').length).toBe(2);
  });

  it('renders horizontal rule', () => {
    const { container } = render(<>{renderMarkdown('above\n\n---\n\nbelow')}</>);
    expect(container.querySelector('hr')).not.toBeNull();
  });

  it('renders blockquote', () => {
    const { container } = render(<>{renderMarkdown('> quoted line')}</>);
    expect(container.querySelector('blockquote')?.textContent).toContain('quoted line');
  });

  it('renders fenced code block', () => {
    const { container } = render(<>{renderMarkdown('```\nlet x = 1;\n```')}</>);
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain('let x = 1;');
  });

  it('renders links and bare URLs', () => {
    const { container } = render(
      <>{renderMarkdown('see [docs](https://example.com) and https://example.org')}</>,
    );
    const links = container.querySelectorAll('a');
    expect(links.length).toBe(2);
    expect(links[0].getAttribute('href')).toBe('https://example.com');
    expect(links[1].getAttribute('href')).toBe('https://example.org');
  });

  it('does not treat # without space as a heading', () => {
    const { container } = render(<>{renderMarkdown('#hashtag here')}</>);
    expect(container.querySelector('h1')).toBeNull();
    expect(container.querySelector('p')?.textContent).toContain('#hashtag');
  });

  it('keeps paragraph separation between heading and body', () => {
    const { container } = render(<>{renderMarkdown('# Title\nbody text')}</>);
    expect(container.querySelector('h1')?.textContent).toBe('Title');
    expect(container.querySelector('p')?.textContent).toContain('body text');
  });

  it('renders #tag tokens as clickable buttons when onTagClick is set', () => {
    const onTagClick = vi.fn();
    const { container } = render(
      <>{renderMarkdown('hello #BugFix world #other-tag', { onTagClick })}</>,
    );
    const pills = container.querySelectorAll('[data-testid="hashtag-pill"]');
    expect(pills.length).toBe(2);
    expect(pills[0].getAttribute('data-tag')).toBe('bugfix');
    expect(pills[1].getAttribute('data-tag')).toBe('other-tag');
    fireEvent.click(pills[0]);
    expect(onTagClick).toHaveBeenCalledWith('bugfix');
  });

  it('leaves #tag tokens as plain text when no onTagClick is provided', () => {
    const { container } = render(<>{renderMarkdown('hello #plain world')}</>);
    expect(container.querySelector('[data-testid="hashtag-pill"]')).toBeNull();
    expect(container.querySelector('p')?.textContent).toContain('#plain');
  });
});
