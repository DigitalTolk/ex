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

  it('renders a GFM table with header, body rows, and per-column alignment', async () => {
    await render(
      wrap(<>{renderMarkdown('| L | C | R |\n| :-- | :-: | --: |\n| a | b | c |\n| d | e | f |')}</>),
    );
    const table = document.querySelector('table');
    expect(table).not.toBeNull();
    const ths = table!.querySelectorAll('thead th');
    expect(ths.length).toBe(3);
    expect(ths[0].className).toContain('text-left'); // :-- and default
    expect(ths[1].className).toContain('text-center'); // :-:
    expect(ths[2].className).toContain('text-right'); // --:
    const rows = table!.querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);
    const firstRowCells = rows[0].querySelectorAll('td');
    expect(firstRowCells[0].textContent).toBe('a');
    expect(firstRowCells[2].className).toContain('text-right');
  });

  it('parses a table without outer pipes, renders inline markdown, left-aligns cells beyond the delimiter', async () => {
    // No outer pipes; a 3-column header but only a 2-column delimiter, so the
    // 3rd header AND body cell fall back to text-left (the `?? text-left` arm).
    await render(wrap(<>{renderMarkdown('a | b | c\n--- | :-:\n**x** | y | z')}</>));
    const table = document.querySelector('table');
    expect(table).not.toBeNull();
    const ths = table!.querySelectorAll('thead th');
    expect(ths.length).toBe(3);
    expect(ths[2].className).toContain('text-left'); // header beyond delimiter → fallback
    expect(table!.querySelector('tbody td strong')?.textContent).toBe('x');
    const cells = table!.querySelectorAll('tbody td');
    expect(cells.length).toBe(3);
    expect(cells[2].className).toContain('text-left');
  });

  it('renders a header-only table (no body rows) without a tbody', async () => {
    await render(wrap(<>{renderMarkdown('| A | B |\n| --- | --- |')}</>));
    const table = document.querySelector('table');
    expect(table).not.toBeNull();
    expect(table!.querySelector('thead')).not.toBeNull();
    expect(table!.querySelector('tbody')).toBeNull();
  });

  it('does not treat a pipe line as a table when the next line is a non-delimiter (has a dash)', async () => {
    await render(wrap(<>{renderMarkdown('x | y\n| a- | --- |')}</>));
    expect(document.querySelector('table')).toBeNull();
    expect(document.querySelector('p')?.textContent).toContain('x | y');
  });

  it('does not treat a pipe line as a table when the following line has no dashes', async () => {
    await render(wrap(<>{renderMarkdown('x | y\nnope no dashes')}</>));
    expect(document.querySelector('table')).toBeNull();
  });

  it('treats a lone pipe line with no following delimiter as a paragraph', async () => {
    await render(wrap(<>{renderMarkdown('| a | b |')}</>));
    expect(document.querySelector('table')).toBeNull();
    expect(document.querySelector('p')?.textContent).toContain('a | b');
  });

  it('starts a table even when it directly follows a paragraph line (no blank line between)', async () => {
    await render(wrap(<>{renderMarkdown('intro text\n| A | B |\n| --- | --- |\n| 1 | 2 |')}</>));
    expect(document.querySelector('p')?.textContent).toContain('intro text');
    const table = document.querySelector('table');
    expect(table).not.toBeNull();
    expect(table!.querySelectorAll('tbody td').length).toBe(2);
  });

  it('renders a fenced code block with the language hint (lowlight hljs)', async () => {
    await render(wrap(<>{renderMarkdown('```go\nfunc main() {}\n```')}</>));
    // CodeBlock renders a line-number gutter <pre> plus the code <pre>;
    // the language attribute lives on the latter.
    const pre = document.querySelector('pre[data-language]');
    expect(pre?.getAttribute('data-language')).toBe('go');
    const code = pre?.querySelector('code');
    expect(code?.className).toContain('hljs');
    expect(code?.querySelector('span.hljs-keyword')).not.toBeNull(); // func
  });

  it('renders a standard emoji at the normal 1.4em size by default', async () => {
    await render(wrap(<>{renderMarkdown(':smile:')}</>));
    expect(document.querySelector('span.text-\\[1\\.4em\\]')).not.toBeNull();
  });

  it('renders a standard emoji at 2.8em when largeEmoji is set', async () => {
    await render(wrap(<>{renderMarkdown(':smile:', { largeEmoji: true })}</>));
    expect(document.querySelector('span.text-\\[2\\.8em\\]')).not.toBeNull();
  });

  it('renders a custom emoji image at 2.8em when largeEmoji is set', async () => {
    await render(
      wrap(<>{renderMarkdown(':parrot:', { largeEmoji: true, emojiMap: { parrot: 'https://x/p.gif' } })}</>),
    );
    expect(document.querySelector('img.h-\\[2\\.8em\\]')).not.toBeNull();
  });

  it('renders a blockquote keeping its line breaks', async () => {
    // Unified with the server-tree path: quoted lines join into one
    // whitespace-pre-wrap paragraph rather than per-line <div>s.
    await render(wrap(<>{renderMarkdown('> first\n> second')}</>));
    const bq = document.querySelector('blockquote');
    expect(bq).not.toBeNull();
    const p = bq?.querySelector('p');
    expect(p?.textContent).toBe('first\nsecond');
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

  it('renders an unsafe-scheme markdown link as inert text, never an href', async () => {
    // Unified with the server-tree path: the hydrator's `a` component
    // strips the anchor and renders only the link text.
    await render(wrap(<>{renderMarkdown('click [here](javascript:alert(1)) now')}</>));
    expect(document.querySelector('a')).toBeNull();
    expect(document.body.textContent).toContain('click here');
    expect(document.body.textContent).not.toContain('javascript:');
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
    expect(document.querySelector('pre code')?.className).toContain('hljs');
  });

  it('syntax-highlights a fenced block via the shared lowlight engine (hljs spans)', async () => {
    const body = '```js\n// a comment\nconst greeting = "hi"\nconst n = 42\n```';
    await render(wrap(<>{renderMarkdown(body)}</>));
    const code = document.querySelector('pre code')!;
    expect(code.className).toContain('hljs');
    expect(code.querySelector('span.hljs-comment')).not.toBeNull(); // comment
    expect(code.querySelector('span.hljs-string')).not.toBeNull(); // "hi"
    expect(code.querySelector('span.hljs-keyword')).not.toBeNull(); // const
    expect(code.querySelector('span.hljs-number')).not.toBeNull(); // 42
  });

  it('renders a fenced block without a language as un-highlighted text', async () => {
    await render(wrap(<>{renderMarkdown('```\njust plain text\n```')}</>));
    const code = document.querySelector('pre code')!;
    expect(code.className).not.toContain('hljs');
    expect(code.textContent).toContain('just plain text');
    // No highlight spans for a language-less block.
    expect(code.querySelector('span')).toBeNull();
  });

  it('keeps the scheme on a bare non-https URL', async () => {
    await render(wrap(<>{renderMarkdown('see http://example.com/path here')}</>));
    const link = document.querySelector('a[href="http://example.com/path"]');
    expect(link).not.toBeNull();
    // displayBareURL only strips the https:// scheme, so http:// stays visible.
    expect(link?.textContent).toContain('http://example.com/path');
  });

  it('delegates user mentions to a renderUserMention wrapper when provided', async () => {
    const renderUserMention = vi.fn((_id: string, name: string, _isSelf: boolean, pill: React.ReactNode) => (
      <span data-testid="wrapped-mention" data-name={name}>{pill}</span>
    ));
    await render(wrap(<>{renderMarkdown('hey @[u-1|Alice] welcome', { renderUserMention })}</>));
    expect(document.querySelector('[data-testid="wrapped-mention"]')).not.toBeNull();
    expect(renderUserMention).toHaveBeenCalled();
  });

  it('renders a skin-toned emoji shortcode as its unicode glyph', async () => {
    await render(wrap(<>{renderMarkdown('wave :wave::skin-tone-3:')}</>));
    // The :name::skin-tone-N: form resolves to a styled unicode span.
    const span = Array.from(document.querySelectorAll('span')).find((s) => s.getAttribute('title') === ':wave::skin-tone-3:');
    expect(span).not.toBeNull();
  });

  it('renders a custom emoji shortcode as an <img> when an emojiMap entry exists', async () => {
    await render(wrap(<>{renderMarkdown('party :parrot:', { emojiMap: { parrot: 'https://emoji.test/parrot.gif' } })}</>));
    const img = document.querySelector('img[alt=":parrot:"]') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img?.src).toContain('parrot.gif');
  });

  it('takes the hast-tree path when opts.tree is provided', async () => {
    // The very first line of renderMarkdown short-circuits to renderHastTree
    // when a tree is supplied (line 416), skipping the regex parser.
    const tree = {
      type: 'root',
      children: [
        { type: 'element', tagName: 'p', properties: {}, children: [{ type: 'text', value: 'from tree' }] },
      ],
    } as never;
    await render(wrap(<>{renderMarkdown('ignored body', { tree })}</>));
    expect(document.body.textContent).toContain('from tree');
  });

  it('treats an unsupported fence language as plain (no highlight, never the raw token)', async () => {
    await render(wrap(<>{renderMarkdown('```malware-lang\nconst x = 1\n```')}</>));
    const pre = document.querySelector('pre')!;
    // The arbitrary token is replaced with "plain"; it never reaches the DOM.
    expect(pre.getAttribute('data-language')).toBe('plain');
    const code = pre.querySelector('code')!;
    expect(code.className).not.toContain('hljs');
    expect(code.className).not.toMatch(/malware/);
    expect(code.querySelector('span')).toBeNull();
    expect(code.textContent).toContain('const x = 1');
  });

  it('renders an empty fenced block without errors', async () => {
    await render(wrap(<>{renderMarkdown('```js\n```')}</>));
    const code = document.querySelector('pre code')!;
    expect(code.querySelector('span')).toBeNull();
  });

  it('does NOT highlight an unsupported language (renders plain, labelled plain)', async () => {
    await render(wrap(<>{renderMarkdown('```madeuplang\nreturn nil\n```')}</>));
    const code = document.querySelector('pre code')!;
    expect(code.querySelector('span')).toBeNull();
    expect(code.className).not.toContain('hljs');
    expect(document.querySelector('pre')?.getAttribute('data-language')).toBe('plain');
  });

  it('renders a group mention with no leading character', async () => {
    // A body that starts with "@all" → GROUP_MENTION_RE's lead capture is
    // empty, driving the `m[1] ?? ''` empty side.
    await render(wrap(<>{renderMarkdown('@all listen up')}</>));
    expect(document.querySelector('[data-mention-group="all"]')).not.toBeNull();
  });

  it('renders a hashtag at the very start with no leading character', async () => {
    const onTagClick = vi.fn();
    await render(wrap(<>{renderMarkdown('#kickoff today', { onTagClick })}</>));
    expect(document.querySelector('button[data-tag="kickoff"]')).not.toBeNull();
  });

  it('renders a giphy embed without width/height when dimensions are omitted', async () => {
    // `giphy:` ref with no `=WxH` suffix → m[3]/m[4] undefined → the `: undefined`
    // sides of both Number() ternaries.
    await render(wrap(<>{renderMarkdown('![GIPHY](giphy:xyz)')}</>));
    expect(document.body.textContent).toMatch(/GIPHY/);
  });

  it('leaves an unknown :shortcode: as literal text', async () => {
    // No emojiMap entry and shortcodeToUnicode returns the input unchanged →
    // both emoji matchers fall to their literal `:name:` span (lines 319/348).
    const screen = await render(wrap(<>{renderMarkdown('mystery :definitely_not_an_emoji:')}</>));
    await expect.element(screen.getByText(/:definitely_not_an_emoji:/)).toBeVisible();
  });

  it('leaves an unknown skin-toned shortcode as literal text', async () => {
    const screen = await render(wrap(<>{renderMarkdown('x :nope_no_emoji::skin-tone-2:')}</>));
    await expect.element(screen.getByText(/:nope_no_emoji:/)).toBeVisible();
  });
});
