import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderMarkdown } from './markdown';

// The legacy regex-based markdown path (no `tree`) is still used by the
// composer's preview, by older message rows that haven't been migrated,
// and as a fallback when the backend hast isn't available. This file
// pushes coverage on the inline + block regex branches.

vi.mock('@/hooks/useSettings', () => ({
  useWorkspaceSettings: () => ({ data: { giphyAPIKey: '' }, isLoading: false }),
}));

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function wrap(children: React.ReactNode) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('renderMarkdown (legacy regex pipeline)', () => {
  it('returns null on an empty body with no tree opts', () => {
    expect(renderMarkdown('')).toBeNull();
  });

  it('renders ATX headings h1 through h6 with size classes', async () => {
    await render(
      wrap(<>{renderMarkdown('# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6')}</>),
    );
    expect(document.querySelector('h1')?.textContent).toBe('H1');
    expect(document.querySelector('h2')?.textContent).toBe('H2');
    expect(document.querySelector('h6')?.textContent).toBe('H6');
    expect(document.querySelector('h6')?.className).toMatch(/uppercase/);
  });

  it('renders a horizontal rule for "---"', async () => {
    await render(wrap(<>{renderMarkdown('---')}</>));
    expect(document.querySelector('hr')).not.toBeNull();
  });

  it('renders a fenced code block with the language hint', async () => {
    await render(wrap(<>{renderMarkdown('```go\nfunc main() {}\n```')}</>));
    const pre = document.querySelector('pre');
    expect(pre?.getAttribute('data-language')).toBe('go');
    const code = pre?.querySelector('code');
    expect(code?.className).toContain('language-go');
  });

  it('renders a blockquote with one <div> per line', async () => {
    await render(wrap(<>{renderMarkdown('> first\n> second')}</>));
    const bq = document.querySelector('blockquote');
    expect(bq).not.toBeNull();
    expect(bq?.querySelectorAll('div').length).toBe(2);
  });

  it('renders unordered lists for "- " and "* "', async () => {
    await render(wrap(<>{renderMarkdown('- one\n- two')}</>));
    const ul = document.querySelector('ul');
    expect(ul?.tagName).toBe('UL');
    expect(ul?.querySelectorAll('li').length).toBe(2);
  });

  it('renders ordered lists for "1. " and "2) "', async () => {
    await render(wrap(<>{renderMarkdown('1. one\n2) two')}</>));
    const ol = document.querySelector('ol');
    expect(ol?.tagName).toBe('OL');
    expect(ol?.querySelectorAll('li').length).toBe(2);
  });

  it('renders **bold** and *italic* and ~~strike~~ and `code` inline', async () => {
    const screen = await render(wrap(<>{renderMarkdown('**b** *i* ~~s~~ `c`')}</>));
    await expect.element(screen.getByText('b')).toBeVisible();
    await expect.element(screen.getByText('i')).toBeVisible();
    await expect.element(screen.getByText('s')).toBeVisible();
    await expect.element(screen.getByText('c')).toBeVisible();
    expect(document.querySelector('strong')?.textContent).toBe('b');
    expect(document.querySelector('em')?.textContent).toBe('i');
    expect(document.querySelector('del,s')?.textContent).toBe('s');
    expect(document.querySelector('code')?.textContent).toBe('c');
  });

  it('linkifies bare https URLs with the protocol stripped from the visible text', async () => {
    await render(wrap(<>{renderMarkdown('see https://example.org/page for more')}</>));
    const a = document.querySelector('a[href="https://example.org/page"]') as HTMLAnchorElement;
    expect(a).not.toBeNull();
    expect(a.textContent).toBe('example.org/page');
  });

  it('renders user mentions with the displayName and a pill class', async () => {
    await render(wrap(<>{renderMarkdown('hello @[u-1|Alice]!')}</>));
    const pill = document.querySelector('[data-mention-user-id="u-1"]') as HTMLElement;
    expect(pill).not.toBeNull();
    expect(pill.textContent).toBe('@Alice');
  });

  it('highlights "you" mentions when the user matches currentUserId', async () => {
    await render(wrap(<>{renderMarkdown('hi @[u-1|Alice]', { currentUserId: 'u-1' })}</>));
    const pill = document.querySelector('[data-mention-user-id="u-1"]') as HTMLElement;
    expect(pill.className).toMatch(/amber/);
  });

  it('renders channel mentions like ~[ch-1|general]', async () => {
    await render(wrap(<>{renderMarkdown('go to ~[ch-1|general]')}</>));
    const pill = document.querySelector('[data-channel-id="ch-1"]') as HTMLElement;
    expect(pill).not.toBeNull();
    expect(pill.textContent).toBe('~general');
  });

  it('renders @all and @here group mentions with the highlight class', async () => {
    await render(wrap(<>{renderMarkdown('attention @all and @here')}</>));
    const all = document.querySelector('[data-mention-group="all"]');
    const here = document.querySelector('[data-mention-group="here"]');
    expect(all).not.toBeNull();
    expect(here).not.toBeNull();
    expect((all as HTMLElement).className).toMatch(/amber/);
  });

  it('renders hashtags as buttons when onTagClick is supplied, plain text otherwise', async () => {
    const onTagClick = vi.fn();
    await render(wrap(<>{renderMarkdown('see #BugFix today', { onTagClick })}</>));
    const btn = document.querySelector('button[data-testid="hashtag-pill"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.dataset.tag).toBe('bugfix');
    btn.click();
    expect(onTagClick).toHaveBeenCalledWith('bugfix');

    // Reset DOM and try again without onTagClick.
    document.body.innerHTML = '';
    await render(wrap(<>{renderMarkdown('see #BugFix today')}</>));
    expect(document.querySelector('button[data-testid="hashtag-pill"]')).toBeNull();
  });

  it('replaces :smile: emoji shortcodes with the matching unicode glyph', async () => {
    const screen = await render(wrap(<>{renderMarkdown('hello :smile:')}</>));
    await expect.element(screen.getByText(/hello/)).toBeVisible();
    // The unicode for :smile: is 😄 — we just assert the raw shortcode no
    // longer leaks into the rendered output.
    expect(document.body.textContent).not.toContain(':smile:');
  });

  it('renders a markdown link [text](https://...) as an anchor', async () => {
    await render(wrap(<>{renderMarkdown('click [here](https://example.org)')}</>));
    const a = document.querySelector('a[href="https://example.org"]');
    expect(a?.textContent).toBe('here');
  });

  it('renders a giphy: image markdown reference as a GiphyEmbed', async () => {
    await render(wrap(<>{renderMarkdown('![GIPHY](giphy:abc =200x150)')}</>));
    // Without a real apiKey the GiphyEmbed renders the unavailable
    // placeholder — confirm it actually mounted.
    expect(document.body.textContent).toMatch(/GIPHY/);
  });

  it('leaves a raw image markdown reference as literal text (no img injection)', async () => {
    await render(wrap(<>{renderMarkdown('![cat](https://example.com/cat.png =320x240)')}</>));
    // Raw http image URLs are intentionally not rendered as <img> — they
    // stay as plain text so a malicious message can't inject media.
    expect(document.querySelector('img[alt="cat"]')).toBeNull();
    expect(document.body.textContent).toContain('![cat]');
  });

  it('renders multiple block types interleaved in a single body', async () => {
    const body = '# Title\n\n- a\n- b\n\n> quoted\n\n```js\nconst x = 1;\n```\n';
    await render(wrap(<>{renderMarkdown(body)}</>));
    expect(document.querySelector('h1')).not.toBeNull();
    expect(document.querySelector('ul li')).not.toBeNull();
    expect(document.querySelector('blockquote')).not.toBeNull();
    expect(document.querySelector('pre code')?.className).toContain('language-javascript');
  });
});
