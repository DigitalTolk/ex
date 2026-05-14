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
});
