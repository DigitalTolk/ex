import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { renderMarkdown } from '@/lib/markdown';
import { renderHastTree } from '@/lib/markdown-hast';
import type { HastNode } from '@/types';

// Server-style hast trees that the backend's RenderToHast produces.
// These tests exercise the frontend's hydration path WITHOUT touching
// the legacy regex parser — proving the per-viewer behaviour
// (currentUserId, onTagClick, renderUserMention, emojiMap, GIPHY API
// key) survives the migration to a server-rendered tree.

function root(...children: HastNode[]): HastNode {
  return { type: 'root', children };
}

function el(tagName: string, properties: Record<string, unknown>, ...children: HastNode[]): HastNode {
  return { type: 'element', tagName, properties, children };
}

function text(value: string): HastNode {
  return { type: 'text', value };
}

describe('renderMarkdown via hast tree', () => {
  it('hydrates a paragraph with bold/italic/strike/code', () => {
    const tree = root(
      el('p', {},
        el('strong', {}, text('b')),
        text(' '),
        el('em', {}, text('i')),
        text(' '),
        el('s', {}, text('s')),
        text(' '),
        el('code', {}, text('c')),
      ),
    );
    const { container } = render(<>{renderMarkdown('', { tree })}</>);
    expect(container.querySelector('strong')?.textContent).toBe('b');
    expect(container.querySelector('em')?.textContent).toBe('i');
    expect(container.querySelector('s')?.textContent).toBe('s');
    expect(container.querySelector('code')?.textContent).toBe('c');
  });

  it('hydrates headings h1..h6 with the legacy class strings', () => {
    const tree = root(
      el('h1', {}, text('A')),
      el('h2', {}, text('B')),
      el('h3', {}, text('C')),
    );
    const { container } = render(<>{renderMarkdown('', { tree })}</>);
    const h1 = container.querySelector('h1');
    const h2 = container.querySelector('h2');
    const h3 = container.querySelector('h3');
    expect(h1?.textContent).toBe('A');
    expect(h1?.className).toContain('text-2xl');
    expect(h2?.className).toContain('text-xl');
    expect(h3?.className).toContain('text-lg');
  });

  it('hydrates ordered + unordered lists with li children', () => {
    const tree = root(
      el('ul', {},
        el('li', {}, text('one')),
        el('li', {}, text('two')),
      ),
      el('ol', {},
        el('li', {}, text('alpha')),
      ),
    );
    const { container } = render(<>{renderMarkdown('', { tree })}</>);
    expect(container.querySelectorAll('ul li')).toHaveLength(2);
    expect(container.querySelectorAll('ol li')).toHaveLength(1);
  });

  it('hydrates blockquote and hr', () => {
    const tree = root(
      el('blockquote', {}, el('p', {}, text('quoted'))),
      el('hr', {}),
    );
    const { container } = render(<>{renderMarkdown('', { tree })}</>);
    expect(container.querySelector('blockquote')?.textContent).toContain('quoted');
    expect(container.querySelector('hr')).not.toBeNull();
  });

  it('hydrates a fenced code block into a highlighted CodeBlock with a copy button and line numbers', () => {
    const tree = root(
      el('pre', { 'data-language': 'php' },
        el('code', { className: ['language-php'] }, text("function demo() {}\n")),
      ),
    );
    const { container } = render(<>{renderMarkdown('', { tree })}</>);
    // CodeBlock keeps data-language on the code <pre> and adds the gutter +
    // copy affordance; php is a known language so it highlights.
    expect(container.querySelector('pre[data-language="php"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="code-copy-button"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="code-line-numbers"]')).not.toBeNull();
    expect(container.querySelector('code.hljs')).not.toBeNull();
    expect(container.querySelector('.hljs-keyword, .hljs-title, .hljs-function, .hljs-built_in')).not.toBeNull();
  });

  it('renders an unknown-language fenced block as plain text with a copy button and no gutter', () => {
    const tree = root(
      el('pre', { 'data-language': 'no-such-lang' },
        el('code', {}, text('just text\n')),
      ),
    );
    const { container } = render(<>{renderMarkdown('', { tree })}</>);
    expect(container.querySelector('[data-testid="code-copy-button"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="code-line-numbers"]')).toBeNull();
    expect(container.textContent).toContain('just text');
  });

  it('renders ex-mention-user as a pill with viewer-aware self highlight', () => {
    const tree = root(el('p', {},
      el('ex-mention-user', { 'data-user-id': 'u-1', 'data-name': 'Alice', 'data-value': '@[u-1|Alice]' }),
    ));
    const { container, rerender } = render(<>{renderMarkdown('', { tree })}</>);
    const pill = container.querySelector('[data-mention-user-id="u-1"]');
    expect(pill?.textContent).toBe('@Alice');
    expect(pill?.getAttribute('data-mention-self')).toBe('false');

    // Same tree, different viewer → self pill.
    rerender(<>{renderMarkdown('', { tree, currentUserId: 'u-1' })}</>);
    const selfPill = container.querySelector('[data-mention-user-id="u-1"]');
    expect(selfPill?.getAttribute('data-mention-self')).toBe('true');
  });

  it('routes ex-mention-user through renderUserMention when wired', () => {
    const tree = root(el('p', {},
      el('ex-mention-user', { 'data-user-id': 'u-1', 'data-name': 'Alice', 'data-value': '@[u-1|Alice]' }),
    ));
    const wrap = vi.fn((id: string, name: string, _isSelf: boolean, pill: React.ReactNode) => (
      <span data-wrapped data-id={id} data-name={name}>{pill}</span>
    ));
    const { container } = render(<>{renderMarkdown('', { tree, renderUserMention: wrap })}</>);
    expect(container.querySelector('[data-wrapped]')?.getAttribute('data-id')).toBe('u-1');
    expect(wrap).toHaveBeenCalledWith('u-1', 'Alice', false, expect.anything());
  });

  it('renders ex-mention-channel as a navigatable pill', () => {
    const tree = root(el('p', {},
      el('ex-mention-channel', { 'data-channel-id': 'ch-1', 'data-slug': 'general', 'data-value': '~[ch-1|general]' }),
    ));
    const { container } = render(<>{renderMarkdown('', { tree })}</>);
    const a = container.querySelector('[data-channel-id="ch-1"]') as HTMLAnchorElement | null;
    expect(a?.getAttribute('href')).toBe('/channel/general');
    expect(a?.textContent).toBe('~general');
  });

  it('renders ex-mention-group with the highlighted pill style', () => {
    const tree = root(el('p', {},
      el('ex-mention-group', { 'data-group': 'all', 'data-value': '@all' }),
    ));
    const { container } = render(<>{renderMarkdown('', { tree })}</>);
    const pill = container.querySelector('[data-mention-group="all"]');
    expect(pill?.textContent).toBe('@all');
  });

  it('renders ex-hashtag as a clickable button when onTagClick is wired', () => {
    const tree = root(el('p', {},
      el('ex-hashtag', { 'data-tag': 'bugfix', 'data-value': '#BugFix' }),
    ));
    const onTagClick = vi.fn();
    const { container } = render(<>{renderMarkdown('', { tree, onTagClick })}</>);
    const btn = container.querySelector('[data-testid="hashtag-pill"]');
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toBe('#BugFix');
    fireEvent.click(btn!);
    expect(onTagClick).toHaveBeenCalledWith('bugfix');
  });

  it('renders ex-hashtag as plain text when onTagClick is omitted', () => {
    const tree = root(el('p', {},
      el('ex-hashtag', { 'data-tag': 'plain', 'data-value': '#plain' }),
    ));
    const { container } = render(<>{renderMarkdown('', { tree })}</>);
    expect(container.querySelector('[data-testid="hashtag-pill"]')).toBeNull();
    expect(container.querySelector('p')?.textContent).toContain('#plain');
  });

  it('renders ex-emoji-shortcode (custom workspace emoji) as an inline image', () => {
    const tree = root(el('p', {},
      el('ex-emoji-shortcode', { 'data-name': 'company_logo', 'data-value': ':company_logo:' }),
    ));
    const { container } = render(
      <>{renderMarkdown('', { tree, emojiMap: { company_logo: 'https://cdn/emoji.png' } })}</>,
    );
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('https://cdn/emoji.png');
  });

  it('renders ex-emoji-shortcode (skin-toned) as the toned glyph', () => {
    const tree = root(el('p', {},
      el('ex-emoji-shortcode', { 'data-name': 'hand', 'data-skin': 'skin-tone-3', 'data-value': ':hand::skin-tone-3:' }),
    ));
    const { container } = render(<>{renderMarkdown('', { tree })}</>);
    const span = container.querySelector('span[title=":hand::skin-tone-3:"]');
    expect(span?.textContent).toBe('🖐🏽');
  });

  it('renders ex-emoji-shortcode (unknown) as the literal source', () => {
    const tree = root(el('p', {},
      el('ex-emoji-shortcode', { 'data-name': 'not_real', 'data-value': ':not_real:' }),
    ));
    const { container } = render(<>{renderMarkdown('', { tree })}</>);
    expect(container.textContent).toContain(':not_real:');
  });

  it('renders ex-bare-url as a link with https:// stripped from the visible text', () => {
    const tree = root(el('p', {},
      el('ex-bare-url', { 'data-href': 'https://example.org/foo', 'data-value': 'https://example.org/foo' }),
    ));
    const { container } = render(<>{renderMarkdown('', { tree })}</>);
    const a = container.querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://example.org/foo');
    expect(a?.textContent).toBe('example.org/foo');
  });

  it('renders ex-media-literal as the original markdown source', () => {
    const tree = root(el('p', {},
      el('ex-media-literal', { 'data-value': '![cat](https://example.com/cat.gif =200x200)' }),
    ));
    const { container } = render(<>{renderMarkdown('', { tree })}</>);
    expect(container.textContent).toContain('![cat](https://example.com/cat.gif =200x200)');
    expect(container.querySelector('img, video')).toBeNull();
  });

  it('renders ex-giphy via the GiphyEmbed component (unavailable when key missing)', () => {
    const tree = root(el('p', {},
      el('ex-giphy', { 'data-id': 'g-1' }),
    ));
    const { container } = render(<>{renderMarkdown('', { tree, giphyAPIKey: '' })}</>);
    expect(container.textContent).toContain('GIPHY unavailable');
  });

  it('renders the data-blank paragraph as a whitespace spacer that re-emits data-blank', () => {
    const tree = root(
      el('p', {}, text('first')),
      el('p', { 'data-blank': 'true' }, text(' ')),
      el('p', { 'data-blank': 'true' }, text(' ')),
      el('p', {}, text('second')),
    );
    const { container } = render(<>{renderMarkdown('', { tree })}</>);
    const ps = container.querySelectorAll('p');
    expect(ps).toHaveLength(4);
    expect(ps[0].textContent).toBe('first');
    // Both spacers must keep data-blank="true" so the `.prose-message
    // p[data-blank="true"]` min-height rule applies — without it the
    // <p> collapses to ~0px and stacked blank lines vanish.
    expect(ps[1].getAttribute('data-blank')).toBe('true');
    expect(ps[1].className).toContain('leading-snug');
    expect(ps[2].getAttribute('data-blank')).toBe('true');
    expect(ps[3].textContent).toBe('second');
  });

  it('falls back to the legacy parser when no tree is provided', () => {
    const { container } = render(<>{renderMarkdown('# Title\nbody')}</>);
    expect(container.querySelector('h1')?.textContent).toBe('Title');
  });

  it('hydrates h4, h5, h6 with their tier-specific classes', () => {
    const tree = root(el('h4', {}, text('D')), el('h5', {}, text('E')), el('h6', {}, text('F')));
    const { container } = render(<>{renderMarkdown('', { tree })}</>);
    expect(container.querySelector('h4')?.className).toContain('text-base');
    expect(container.querySelector('h5')?.className).toContain('text-sm');
    expect(container.querySelector('h6')?.className).toContain('uppercase');
  });

  it('hydrates explicit links with target=_blank and the link class', () => {
    const tree = root(el('p', {},
      el('a', { href: 'https://x.test' }, text('click me')),
    ));
    const { container } = render(<>{renderMarkdown('', { tree })}</>);
    const a = container.querySelector('a') as HTMLAnchorElement | null;
    expect(a?.getAttribute('href')).toBe('https://x.test');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.className).toContain('text-link');
  });

  it('hydrates inline <code> (no className) as the muted-bg pill style', () => {
    const tree = root(el('p', {}, el('code', {}, text('inline'))));
    const { container } = render(<>{renderMarkdown('', { tree })}</>);
    expect(container.querySelector('code')?.className).toContain('bg-muted');
  });

  it('uses the workspace emoji map only when no skin tone is supplied', () => {
    // Toned variant should NOT pick up the workspace emoji map — the
    // map only covers static glyphs.
    const tree = root(el('p', {},
      el('ex-emoji-shortcode', { 'data-name': 'company_logo', 'data-skin': 'skin-tone-3', 'data-value': ':company_logo::skin-tone-3:' }),
    ));
    const { container } = render(
      <>{renderMarkdown('', { tree, emojiMap: { company_logo: 'https://cdn/x.png' } })}</>,
    );
    expect(container.querySelector('img')).toBeNull();
    // Falls through to literal-text since `:company_logo:` isn't a CLDR shortcode.
    expect(container.textContent).toContain(':company_logo::skin-tone-3:');
  });

  it('handles ex-bare-url for http:// (keeps protocol visible)', () => {
    const tree = root(el('p', {},
      el('ex-bare-url', { 'data-href': 'http://example.org', 'data-value': 'http://example.org' }),
    ));
    const { container } = render(<>{renderMarkdown('', { tree })}</>);
    const a = container.querySelector('a');
    expect(a?.textContent).toBe('http://example.org');
  });

  // Coverage for the defensive `?? ''` defaults — exercised by a
  // deliberately under-specified tree (the server always emits the
  // full data set, but the renderer's defaults guarantee a stable
  // visual fallback if a future server emits an abbreviated form).
  it('renders ex-* tags with missing data attributes via defensive defaults', () => {
    const tree = root(el('p', {},
      // No data-href / data-value → bare-url renders nothing visible
      // but doesn't crash.
      el('ex-bare-url', {}),
      // No data-name → emoji-shortcode falls through to literal ":"
      // (data-value default).
      el('ex-emoji-shortcode', {}),
      // No data-tag / data-value → hashtag renders "#" with no body.
      el('ex-hashtag', {}),
      // No data-channel-id / data-slug → mention-channel renders an
      // empty pill ~/channel/.
      el('ex-mention-channel', {}),
      // No data-group → mention-group falls through to "@" alone.
      el('ex-mention-group', {}),
      // No data-user-id / data-name → mention-user renders @ alone.
      el('ex-mention-user', {}),
    ));
    const { container } = render(<>{renderMarkdown('', { tree })}</>);
    // No exceptions thrown is the assertion — content is best-effort.
    expect(container.querySelector('p')).not.toBeNull();
  });

  it('renders ex-emoji-shortcode (standard CLDR, no workspace map) as the unicode glyph', () => {
    const tree = root(el('p', {},
      el('ex-emoji-shortcode', { 'data-name': 'smile', 'data-value': ':smile:' }),
    ));
    const { container } = render(<>{renderMarkdown('', { tree })}</>);
    const span = container.querySelector('span[title=":smile:"]');
    expect(span?.textContent).toBe('😄');
  });

  it('renders ex-giphy with explicit width + height', () => {
    const tree = root(el('p', {},
      el('ex-giphy', { 'data-id': 'g-2', 'data-width': '200', 'data-height': '150' }),
    ));
    const { container } = render(<>{renderMarkdown('', { tree, giphyAPIKey: '' })}</>);
    expect(container.textContent).toContain('GIPHY unavailable');
  });
});

describe('tag allowlist (defense-in-depth)', () => {
  it('unwraps a disallowed element but keeps its children', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'element', tagName: 'p', properties: {}, children: [
          { type: 'element', tagName: 'script', properties: {}, children: [
            { type: 'text', value: 'alert(1)' },
          ] },
          { type: 'text', value: ' safe tail' },
        ] },
      ],
    } as never;
    render(<div data-testid="allow">{renderHastTree(tree)}</div>);
    const host = screen.getByTestId('allow');
    // The script ELEMENT is gone…
    expect(host.querySelector('script')).toBeNull();
    // …but its text content degrades to visible text (never lost), and
    // siblings are untouched.
    expect(host.textContent).toContain('alert(1)');
    expect(host.textContent).toContain('safe tail');
  });

  it('renders every allowed structural tag normally', () => {
    const el = (tagName: string, ...children: unknown[]) =>
      ({ type: 'element', tagName, properties: {}, children }) as never;
    const text = (value: string) => ({ type: 'text', value }) as never;
    const tree = {
      type: 'root',
      children: [el('blockquote', el('em', text('quoted')))],
    } as never;
    render(<div data-testid="allow-ok">{renderHastTree(tree)}</div>);
    const host = screen.getByTestId('allow-ok');
    expect(host.querySelector('blockquote em')).not.toBeNull();
  });

  it('drops a disallowed element that arrives without a children field', () => {
    // Go's omitempty elides empty children arrays — a childless hostile
    // element must unwrap to nothing instead of crashing the flatMap.
    const tree = {
      type: 'root',
      children: [
        { type: 'element', tagName: 'p', properties: {}, children: [
          { type: 'element', tagName: 'iframe', properties: { src: 'https://evil.example' } },
          { type: 'text', value: 'still here' },
        ] },
      ],
    } as never;
    render(<div data-testid="allow-childless">{renderHastTree(tree)}</div>);
    const host = screen.getByTestId('allow-childless');
    expect(host.querySelector('iframe')).toBeNull();
    expect(host.textContent).toContain('still here');
  });

  it('renders a bare text root (malformed server tree) as plain text', () => {
    const tree = { type: 'text', value: 'just text' } as never;
    render(<div data-testid="allow-text-root">{renderHastTree(tree)}</div>);
    expect(screen.getByTestId('allow-text-root').textContent).toBe('just text');
  });
});
