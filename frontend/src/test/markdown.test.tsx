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

  it('preserves blank lines as literal empty lines in the rendered output', () => {
    // Slack/iMessage parity: pressing Enter twice in the composer
    // leaves a visible gap. Previous behaviour collapsed double
    // newlines into a paragraph break with no visible spacing.
    const { container } = render(<>{renderMarkdown('first\n\nsecond')}</>);
    const ps = container.querySelectorAll('p');
    expect(ps.length).toBe(3);
    expect(ps[0].textContent).toBe('first');
    expect(ps[1].textContent?.trim()).toBe('');
    expect(ps[2].textContent).toBe('second');
  });

  it('stacks one blank paragraph per consecutive blank line', () => {
    const { container } = render(<>{renderMarkdown('a\n\n\n\nb')}</>);
    const ps = container.querySelectorAll('p');
    // a, blank, blank, blank, b
    expect(ps.length).toBe(5);
    expect(ps[0].textContent).toBe('a');
    expect(ps[4].textContent).toBe('b');
  });

  it('renders inline images with optional `=WxH` size suffix as width/height attrs', () => {
    // The Giphy composer hook injects `![title](url =WxH)` so the
    // chat list reserves the layout box at first paint — without
    // this, the row would resize on decode and break scroll
    // anchoring.
    const { container } = render(
      <>{renderMarkdown('![cat](https://media.giphy.com/cat.gif =300x200)')}</>,
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('https://media.giphy.com/cat.gif');
    expect(img!.getAttribute('width')).toBe('300');
    expect(img!.getAttribute('height')).toBe('200');
    expect(img!.getAttribute('alt')).toBe('cat');
  });

  it('renders inline images without a size suffix as plain `<img>`', () => {
    const { container } = render(
      <>{renderMarkdown('![logo](https://example.com/logo.png)')}</>,
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.hasAttribute('width')).toBe(false);
    expect(img!.hasAttribute('height')).toBe(false);
  });
});
