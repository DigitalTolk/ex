import { describe, it, expect } from 'vitest';
import { htmlToMarkdown, markdownToEditableHtml } from '@/lib/wysiwyg';

function fromHtml(html: string): HTMLDivElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

describe('wysiwyg — mention pill round-trip', () => {
  it('serialises a mention span back to @[id|name]', () => {
    const md = htmlToMarkdown(
      fromHtml(
        'hi <span class="mention" data-user-id="u-1" data-mention-name="Alice" contenteditable="false">@Alice</span> bye',
      ),
    );
    expect(md).toContain('@[u-1|Alice]');
  });

  it('falls back to span textContent when data-mention-name is missing', () => {
    const md = htmlToMarkdown(
      fromHtml(
        '<span class="mention" data-user-id="u-9" contenteditable="false">@Bob</span>',
      ),
    );
    expect(md).toBe('@[u-9|Bob]');
  });

  it('skips a malformed mention span (no user id) and inlines the text', () => {
    const md = htmlToMarkdown(fromHtml('<span class="mention">@Ghost</span>'));
    expect(md).toBe('@Ghost');
  });

  it('hydrates @[id|name] markdown into a contenteditable mention pill', () => {
    const html = markdownToEditableHtml('hi @[u-1|Alice]');
    expect(html).toContain('class="mention"');
    expect(html).toContain('data-user-id="u-1"');
    expect(html).toContain('data-mention-name="Alice"');
    expect(html).toContain('contenteditable="false"');
    expect(html).toContain('@Alice');
  });

  it('round-trips a complex message with bold + mention + link', () => {
    const md = '**hi** @[u-1|Alice] check [docs](https://x)';
    const root = fromHtml(markdownToEditableHtml(md));
    const back = htmlToMarkdown(root);
    expect(back).toContain('@[u-1|Alice]');
    expect(back).toContain('**hi**');
    expect(back).toContain('[docs](https://x)');
  });

  it('does not interpret @[name|email] inside text without the brackets as a mention', () => {
    // Plain "@bob" without brackets is not a pill in storage — only
    // group mentions (@all/@here) are pills implicitly.
    const md = htmlToMarkdown(fromHtml('<p>@bob hi</p>'));
    expect(md).toBe('@bob hi');
  });

  it('serialises a channel-mention span back to ~[id|slug]', () => {
    const md = htmlToMarkdown(
      fromHtml(
        'see <span class="mention channel-mention" data-channel-id="c-1" data-channel-slug="general" contenteditable="false">~general</span> for details',
      ),
    );
    expect(md).toContain('~[c-1|general]');
  });

  it('hydrates ~[id|slug] markdown into a contenteditable channel pill', () => {
    const html = markdownToEditableHtml('open ~[c-1|general]');
    expect(html).toContain('class="mention channel-mention"');
    expect(html).toContain('data-channel-id="c-1"');
    expect(html).toContain('data-channel-slug="general"');
    expect(html).toContain('~general');
  });

  it('round-trips a channel mention through HTML and back', () => {
    const md = 'check ~[c-9|random] please';
    const root = fromHtml(markdownToEditableHtml(md));
    expect(htmlToMarkdown(root)).toContain('~[c-9|random]');
  });
});
