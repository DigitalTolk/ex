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

  it('preserves fenced code block language hints', () => {
    const examples = [
      ['php', 'php'],
      ['javascript', 'javascript'],
      ['js', 'javascript'],
      ['typescript', 'typescript'],
      ['ts', 'typescript'],
      ['python', 'python'],
      ['py', 'python'],
      ['go', 'go'],
      ['rust', 'rust'],
      ['ruby', 'ruby'],
      ['rb', 'ruby'],
      ['bash', 'bash'],
      ['sh', 'bash'],
      ['ini', 'ini'],
      ['hcl', 'hcl'],
      ['java', 'java'],
      ['c', 'c'],
      ['c++', 'cpp'],
      ['c#', 'csharp'],
      ['f#', 'fsharp'],
      ['objective-c', 'objective-c'],
      ['swift', 'swift'],
      ['kotlin', 'kotlin'],
      ['sql', 'sql'],
      ['html', 'html'],
      ['css', 'css'],
      ['json', 'json'],
      ['yaml', 'yaml'],
    ] as const;

    for (const [hint, className] of examples) {
      const { container, unmount } = render(<>{renderMarkdown(`\`\`\`${hint}\ncode\n\`\`\``)}</>);
      const pre = container.querySelector('pre');
      const code = container.querySelector('code');
      expect(pre?.getAttribute('data-language')).toBe(hint);
      expect(code).toHaveClass(`language-${className}`);
      expect(code?.textContent).toBe('code');
      unmount();
    }
  });

  it('renders visible syntax tokens for language-hinted code blocks', () => {
    const { container } = render(<>{renderMarkdown("```php\n// comment\nfunction demo() {\n  $value = 'ok';\n  return 123;\n}\n```")}</>);
    const spans = Array.from(container.querySelectorAll('code span'));
    expect(spans.some((span) => span.textContent === '// comment' && span.className.includes('muted-foreground'))).toBe(true);
    expect(spans.some((span) => span.textContent === 'function' && span.className.includes('purple'))).toBe(true);
    expect(spans.some((span) => span.textContent === '$value' && span.className.includes('sky'))).toBe(true);
    expect(spans.some((span) => span.textContent === "'ok'" && span.className.includes('emerald'))).toBe(true);
    expect(spans.some((span) => span.textContent === '123' && span.className.includes('amber'))).toBe(true);
  });

  it.each([
    ['python', 'def'],
    ['javascript', 'const'],
    ['typescript', 'interface'],
    ['go', 'func'],
    ['rust', 'fn'],
    ['ruby', 'end'],
    ['bash', 'then'],
    ['hcl', 'resource'],
    ['sql', 'select'],
    ['swift', 'let'],
    ['kotlin', 'fun'],
    ['java', 'public'],
    ['c', 'int'],
    ['c++', 'namespace'],
    ['c#', 'using'],
    ['ini', 'true'],
    ['yaml', 'false'],
    ['json', 'null'],
  ])('highlights %s language keywords', (language, keyword) => {
    const { container } = render(<>{renderMarkdown(`\`\`\`${language}\n${keyword}\n\`\`\``)}</>);
    const span = container.querySelector('code span');
    expect(span?.textContent).toBe(keyword);
    expect(span?.className).toContain('purple');
  });

  it('leaves unrecognized code tokens unwrapped', () => {
    const { container } = render(<>{renderMarkdown('```php\nplainIdentifier\n```')}</>);
    expect(container.querySelectorAll('code span')).toHaveLength(0);
    expect(container.querySelector('code')?.textContent).toBe('plainIdentifier');
  });

  it('does not add synthetic vertical margin to fenced code blocks', () => {
    const { container } = render(<>{renderMarkdown('```\none\n```')}</>);
    expect(container.querySelector('pre')).toHaveClass('my-0');
  });

  it.each([
    ['zero', '```\none\n```\n```php\ntwo\n```', 0],
    ['one', '```\none\n```\n\n```php\ntwo\n```', 1],
    ['two', '```\none\n```\n\n\n```php\ntwo\n```', 2],
  ])('renders exactly %s blank line(s) between adjacent fenced code blocks', (_label, markdown, blanks) => {
    const { container } = render(<>{renderMarkdown(markdown)}</>);
    expect(container.querySelectorAll('pre')).toHaveLength(2);
    expect(container.querySelectorAll('p')).toHaveLength(blanks);
  });

  it('renders links and bare URLs', () => {
    const { container } = render(
      <>{renderMarkdown('see [docs](https://example.com) and https://example.org')}</>,
    );
    const links = container.querySelectorAll('a');
    expect(links.length).toBe(2);
    expect(links[0].getAttribute('href')).toBe('https://example.com');
    expect(links[1].getAttribute('href')).toBe('https://example.org');
    expect(links[1].textContent).toBe('example.org');
    expect(links[0]).toHaveClass('text-link');
    expect(links[0]).not.toHaveClass('underline');
  });

  it('keeps http protocol visible for bare URLs', () => {
    const { container } = render(<>{renderMarkdown('see http://example.org')}</>);
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('http://example.org');
    expect(link?.textContent).toBe('http://example.org');
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
    // The middle paragraph carries `data-blank="true"` so the
    // `.prose-message` CSS rule in index.css can give it a real
    // min-height — without this marker Tailwind preflight collapses
    // the empty <p> against its siblings and the user-visible gap
    // disappears even though the markup is technically three <p>.
    expect(ps[1].getAttribute('data-blank')).toBe('true');
    expect(ps[0].getAttribute('data-blank')).not.toBe('true');
    expect(ps[2].getAttribute('data-blank')).not.toBe('true');
  });

  it('stacks one blank paragraph per consecutive blank line', () => {
    const { container } = render(<>{renderMarkdown('a\n\n\n\nb')}</>);
    const ps = container.querySelectorAll('p');
    // a, blank, blank, blank, b
    expect(ps.length).toBe(5);
    expect(ps[0].textContent).toBe('a');
    expect(ps[4].textContent).toBe('b');
  });

  it('leaves raw markdown image URLs as literal text instead of rendering media', () => {
    const { container } = render(
      <>{renderMarkdown('![cat](https://media.giphy.com/cat.gif =300x200)')}</>,
    );
    expect(container.querySelector('img, video')).toBeNull();
    expect(container.textContent).toContain('![cat](https://media.giphy.com/cat.gif =300x200)');
  });

  it('leaves raw markdown video URLs as literal text instead of rendering media', () => {
    const url = 'https://media.giphy.com/cat.mp4?cid=keep';
    const { container } = render(
      <>{renderMarkdown(`![cat](${url} =300x200)`)}</>,
    );
    expect(container.querySelector('img, video')).toBeNull();
    expect(container.textContent).toContain(`![cat](${url} =300x200)`);
  });

  it('renders persisted Giphy references without storing a media URL in the message body', () => {
    const { container } = render(<>{renderMarkdown('![GIPHY](giphy:g-1)', { giphyAPIKey: '' })}</>);
    expect(container.textContent).toContain('GIPHY unavailable');
    expect(container.textContent).not.toContain('media.giphy.com');
  });

  it('renders split skin-tone emoji shortcodes as one toned emoji', () => {
    const { container } = render(<>{renderMarkdown('hi :hand::skin-tone-3:')}</>);
    const emoji = container.querySelector('span[title=":hand::skin-tone-3:"]');
    expect(emoji?.textContent).toBe('🖐🏽');
  });

  it('leaves unknown emoji and skin-tone shortcodes literal', () => {
    const { container } = render(<>{renderMarkdown(':not_real: :not_real::skin-tone-3:')}</>);
    expect(container.textContent).toContain(':not_real:');
    expect(container.textContent).toContain(':not_real::skin-tone-3:');
  });
});
