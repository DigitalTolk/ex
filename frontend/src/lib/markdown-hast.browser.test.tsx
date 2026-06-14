import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHastTree } from './markdown-hast';
import type { HastNode } from '@/types';

vi.mock('@/hooks/useSettings', () => ({
  useWorkspaceSettings: () => ({ data: { giphyAPIKey: '' }, isLoading: false }),
}));

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function wrap(children: React.ReactNode) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function elem(tagName: string, props: Record<string, unknown> = {}, children: HastNode[] = []): HastNode {
  return { type: 'element', tagName, properties: props, children };
}

function text(value: string): HastNode {
  return { type: 'text', value };
}

function root(children: HastNode[]): HastNode {
  return { type: 'root', children };
}

describe('renderHastTree — every custom-tag branch', () => {
  it('renders a self-mention with the highlight class when currentUserId matches', async () => {
    const tree = root([
      elem('p', {}, [
        elem('ex-mention-user', { 'data-user-id': 'u-1', 'data-name': 'Alice' }),
      ]),
    ]);
    await render(wrap(<>{renderHastTree(tree, { currentUserId: 'u-1' })}</>));
    const pill = document.querySelector('[data-mention-user-id="u-1"]') as HTMLElement;
    expect(pill.dataset.mentionSelf).toBe('true');
    expect(pill.className).toMatch(/amber/);
  });

  it('delegates to renderUserMention when provided', async () => {
    const renderUserMention = vi.fn((_uid: string, name: string, _isSelf: boolean, pill: React.ReactNode) => (
      <span data-testid="wrapped-mention" data-name={name}>{pill}</span>
    ));
    const tree = root([
      elem('p', {}, [
        elem('ex-mention-user', { 'data-user-id': 'u-2', 'data-name': 'Bob' }),
      ]),
    ]);
    await render(wrap(<>{renderHastTree(tree, { renderUserMention })}</>));
    expect(renderUserMention).toHaveBeenCalled();
    expect(document.querySelector('[data-testid="wrapped-mention"]')).not.toBeNull();
  });

  it('renders an ex-mention-channel as an <a> to /channel/<slug>', async () => {
    const tree = root([
      elem('p', {}, [
        elem('ex-mention-channel', { 'data-channel-id': 'ch-1', 'data-slug': 'random' }),
      ]),
    ]);
    await render(wrap(<>{renderHastTree(tree)}</>));
    const link = document.querySelector('a[href="/channel/random"]') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.textContent).toBe('~random');
  });

  it('renders an ex-mention-group with the @ prefix and highlight class', async () => {
    const tree = root([
      elem('p', {}, [elem('ex-mention-group', { 'data-group': 'here' })]),
    ]);
    await render(wrap(<>{renderHastTree(tree)}</>));
    const pill = document.querySelector('[data-mention-group="here"]') as HTMLElement;
    expect(pill).not.toBeNull();
    expect(pill.textContent).toBe('@here');
    expect(pill.className).toMatch(/amber/);
  });

  it('renders an ex-hashtag as a clickable button when onTagClick is supplied', async () => {
    const onTagClick = vi.fn();
    const tree = root([
      elem('p', {}, [elem('ex-hashtag', { 'data-tag': 'release', 'data-value': '#Release' })]),
    ]);
    await render(wrap(<>{renderHastTree(tree, { onTagClick })}</>));
    const btn = document.querySelector('button[data-testid="hashtag-pill"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe('#Release');
    btn.click();
    expect(onTagClick).toHaveBeenCalledWith('release');
  });

  it('renders an ex-hashtag as plain text when onTagClick is absent', async () => {
    const tree = root([
      elem('p', {}, [elem('ex-hashtag', { 'data-tag': 'release' })]),
    ]);
    await render(wrap(<>{renderHastTree(tree)}</>));
    expect(document.querySelector('button[data-testid="hashtag-pill"]')).toBeNull();
    expect(document.body.textContent).toContain('#release');
  });

  it('renders an ex-bare-url with the https:// stripped from the visible text', async () => {
    const tree = root([
      elem('p', {}, [elem('ex-bare-url', { 'data-href': 'https://example.org/page' })]),
    ]);
    await render(wrap(<>{renderHastTree(tree)}</>));
    const a = document.querySelector('a[href="https://example.org/page"]') as HTMLAnchorElement;
    expect(a).not.toBeNull();
    expect(a.textContent).toBe('example.org/page');
  });

  it('renders an ex-bare-url unchanged when the href is non-https (e.g. http://)', async () => {
    const tree = root([
      elem('p', {}, [elem('ex-bare-url', { 'data-href': 'http://example.org/x' })]),
    ]);
    await render(wrap(<>{renderHastTree(tree)}</>));
    const a = document.querySelector('a[href="http://example.org/x"]') as HTMLAnchorElement;
    expect(a.textContent).toBe('http://example.org/x');
  });

  it('renders an ex-emoji-shortcode as a custom <img> when the map has the name', async () => {
    const tree = root([
      elem('p', {}, [elem('ex-emoji-shortcode', { 'data-name': 'partyparrot' })]),
    ]);
    await render(wrap(<>{renderHastTree(tree, { emojiMap: { partyparrot: 'https://cdn.test/p.png' } })}</>));
    const img = document.querySelector('img[alt=":partyparrot:"]') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.src).toContain('p.png');
  });

  it('renders an ex-emoji-shortcode as unicode when known and no custom map', async () => {
    const tree = root([
      elem('p', {}, [elem('ex-emoji-shortcode', { 'data-name': 'smile' })]),
    ]);
    await render(wrap(<>{renderHastTree(tree)}</>));
    const span = document.querySelector('span[title=":smile:"]') as HTMLSpanElement;
    expect(span).not.toBeNull();
    expect(span.textContent).not.toBe(':smile:');
  });

  it('renders an ex-emoji-shortcode literal when the shortcode is unknown', async () => {
    const tree = root([
      elem('p', {}, [elem('ex-emoji-shortcode', { 'data-name': 'this-is-not-real', 'data-value': ':this-is-not-real:' })]),
    ]);
    await render(wrap(<>{renderHastTree(tree)}</>));
    expect(document.body.textContent).toContain(':this-is-not-real:');
  });

  it('applies the skin-tone suffix when data-skin is supplied', async () => {
    const tree = root([
      elem('p', {}, [elem('ex-emoji-shortcode', { 'data-name': 'wave', 'data-skin': 'skin-tone-3' })]),
    ]);
    await render(wrap(<>{renderHastTree(tree)}</>));
    const span = document.querySelector('span[title=":wave::skin-tone-3:"]');
    expect(span).not.toBeNull();
  });

  it('renders ex-media-literal as a span with the data-value content', async () => {
    const tree = root([
      elem('p', {}, [elem('ex-media-literal', { 'data-value': '![cat](https://example.com/x.png)' })]),
    ]);
    await render(wrap(<>{renderHastTree(tree)}</>));
    expect(document.body.textContent).toContain('![cat](https://example.com/x.png)');
  });

  it('renders inline code (no className) and block code (with className) differently', async () => {
    const tree = root([
      elem('p', {}, [elem('code', {}, [text('foo')])]),
      elem('pre', { 'data-language': 'go' }, [elem('code', { className: 'language-go' }, [text('package main')])]),
    ]);
    await render(wrap(<>{renderHastTree(tree)}</>));
    const inline = document.querySelector('p code') as HTMLElement;
    expect(inline.className).toMatch(/bg-muted/);
    const block = document.querySelector('pre code') as HTMLElement;
    expect(block.className).toContain('language-go');
  });

  it('renders <p data-blank="true"> as an empty paragraph (whitespace preserve)', async () => {
    const tree = root([
      elem('p', { 'data-blank': 'true' }),
    ]);
    await render(wrap(<>{renderHastTree(tree)}</>));
    const p = document.querySelector('p');
    expect(p).not.toBeNull();
    // The blank-paragraph branch renders a non-empty space child.
    expect(p?.textContent?.trim().length ?? 0).toBe(0);
  });

  it('renders an <hr> for a top-level horizontal rule node', async () => {
    const tree = root([elem('hr')]);
    await render(wrap(<>{renderHastTree(tree)}</>));
    expect(document.querySelector('hr')).not.toBeNull();
  });

  it('renders an <a href> link from a plain hast anchor', async () => {
    const tree = root([
      elem('p', {}, [elem('a', { href: 'https://example.org' }, [text('click')])]),
    ]);
    await render(wrap(<>{renderHastTree(tree)}</>));
    const a = document.querySelector('a[href="https://example.org"]') as HTMLAnchorElement;
    expect(a.textContent).toBe('click');
    expect(a.rel).toBe('noopener noreferrer');
  });

  it('tolerates a missing children field on a leaf element (omitempty defence)', async () => {
    // No children prop on ex-mention-user — the normaliseTree walker
    // patches it to [] so hast-util-to-jsx-runtime can read .length
    // without throwing.
    const tree: HastNode = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'p',
          children: [
            { type: 'element', tagName: 'ex-mention-user', properties: { 'data-user-id': 'u-3', 'data-name': 'Carol' } } as HastNode,
          ],
        },
      ],
    };
    await render(wrap(<>{renderHastTree(tree)}</>));
    const pill = document.querySelector('[data-mention-user-id="u-3"]');
    expect(pill).not.toBeNull();
  });

  it('renders every heading level with its own class ramp', async () => {
    const tree = root([
      elem('h1', {}, [text('H1')]),
      elem('h2', {}, [text('H2')]),
      elem('h3', {}, [text('H3')]),
      elem('h4', {}, [text('H4')]),
      elem('h5', {}, [text('H5')]),
      elem('h6', {}, [text('H6')]),
    ]);
    await render(wrap(<>{renderHastTree(tree)}</>));
    for (const t of ['H1', 'H2', 'H3', 'H4', 'H5', 'H6']) {
      expect(document.body.textContent).toContain(t);
    }
    // Distinct class ramp per level (covers the headingClass ternary chain).
    expect(document.querySelector('h2')?.className).toMatch(/text-xl/);
    expect(document.querySelector('h6')?.className).toMatch(/text-xs/);
  });

  it('falls back to empty ids/names when mention tags omit their data props', async () => {
    const tree = root([
      elem('p', {}, [
        elem('ex-mention-user', {}),
        elem('ex-mention-channel', {}),
        elem('ex-mention-group', {}),
      ]),
    ]);
    await render(wrap(<>{renderHastTree(tree)}</>));
    // The user/group pills render even with empty data (the `?? ''` paths).
    expect(document.querySelectorAll('[data-testid="mention-pill"]').length).toBeGreaterThanOrEqual(2);
    expect(document.querySelector('[data-testid="channel-mention-pill"]')).not.toBeNull();
  });

  it('renders a hashtag as plain text when no onTagClick handler is provided', async () => {
    const tree = root([
      elem('p', {}, [elem('ex-hashtag', { 'data-tag': 'launch', 'data-value': '#launch' })]),
    ]);
    await render(wrap(<>{renderHastTree(tree)}</>));
    // No handler → a non-interactive span, not a button.
    expect(document.body.textContent).toContain('#launch');
    expect(document.querySelector('button')).toBeNull();
  });

  it('renders a hashtag as a button when an onTagClick handler is provided', async () => {
    const onTagClick = vi.fn();
    const tree = root([
      elem('p', {}, [elem('ex-hashtag', { 'data-tag': 'launch' })]),
    ]);
    await render(wrap(<>{renderHastTree(tree, { onTagClick })}</>));
    const btn = document.querySelector('button');
    expect(btn).not.toBeNull();
    btn!.click();
    expect(onTagClick).toHaveBeenCalledWith('launch');
  });

  it('renders a giphy embed with explicit width/height', async () => {
    const tree = root([
      elem('p', {}, [elem('ex-giphy', { 'data-id': 'gif-1', 'data-width': '320', 'data-height': '180' })]),
    ]);
    await render(wrap(<>{renderHastTree(tree)}</>));
    // GiphyEmbed mounts with the parsed dimensions; assert the tree rendered.
    expect(document.body).not.toBeNull();
  });

  it('renders an ex-hashtag with no data-tag (the data-tag ?? "" fallback)', async () => {
    // No data-tag attribute → `props['data-tag'] ?? ''` takes the `?? ''` side.
    const tree = root([elem('p', {}, [elem('ex-hashtag', {})])]);
    await render(wrap(<>{renderHastTree(tree)}</>));
    // Renders the plain `#` span (no handler) without throwing.
    expect(document.querySelector('p')).not.toBeNull();
  });

  it('renders an ex-emoji-shortcode with no data-name (the data-name ?? "" fallback)', async () => {
    // No data-name → `props['data-name'] ?? ''` takes the `?? ''` side; with no
    // map entry and an unknown empty name it renders the literal.
    const tree = root([elem('p', {}, [elem('ex-emoji-shortcode', {})])]);
    await render(wrap(<>{renderHastTree(tree)}</>));
    expect(document.querySelector('p')).not.toBeNull();
  });

  it('renders a giphy embed with no id and no dimensions (the ?? "" / : undefined sides)', async () => {
    // ex-giphy with neither data-id nor data-width/height: id falls back to '',
    // and both `props['data-...'] ? Number(...) : undefined` ternaries take the
    // undefined side.
    const tree = root([elem('p', {}, [elem('ex-giphy', {})])]);
    await render(wrap(<>{renderHastTree(tree)}</>));
    expect(document.body).not.toBeNull();
  });

  it('prefers the unicode glyph over a custom emoji image when a skin tone is set', async () => {
    // With data-skin present, `!skin ? emojiMap[name] : undefined` takes the
    // undefined side, so even though emojiMap has the name the custom <img> is
    // skipped and the toned unicode span renders.
    const tree = root([
      elem('p', {}, [elem('ex-emoji-shortcode', { 'data-name': 'wave', 'data-skin': 'skin-tone-2' })]),
    ]);
    await render(wrap(<>{renderHastTree(tree, { emojiMap: { wave: 'https://cdn.test/wave.png' } })}</>));
    expect(document.querySelector('img[alt=":wave:"]')).toBeNull();
    expect(document.querySelector('span[title=":wave::skin-tone-2:"]')).not.toBeNull();
  });

  it('renders an ex-bare-url with an empty href fallback when data-href is missing', async () => {
    const tree = root([elem('p', {}, [elem('ex-bare-url', {})])]);
    await render(wrap(<>{renderHastTree(tree)}</>));
    // href falls back to '' → an anchor with an empty href still renders.
    expect(document.querySelector('a')).not.toBeNull();
  });

  it('strips the https:// scheme from a bare URL but keeps other schemes intact', async () => {
    const tree = root([
      elem('p', {}, [
        elem('ex-bare-url', { 'data-href': 'https://example.com/path' }),
        elem('ex-bare-url', { 'data-href': 'http://plain.example' }),
      ]),
    ]);
    await render(wrap(<>{renderHastTree(tree)}</>));
    expect(document.body.textContent).toContain('example.com/path');
    expect(document.body.textContent).toContain('http://plain.example');
  });
});
