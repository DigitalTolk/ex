import { describe, it, expect } from 'vitest';
import { htmlToMarkdown, markdownToEditableHtml } from '@/lib/wysiwyg';

function toMd(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return htmlToMarkdown(div);
}

describe('wysiwyg markdown ↔ HTML bridge', () => {
  it('converts inline marks back to markdown', () => {
    expect(toMd('<p>Hello <strong>world</strong></p>')).toBe('Hello **world**');
    expect(toMd('<p><em>fancy</em></p>')).toBe('*fancy*');
    expect(toMd('<p><s>old</s></p>')).toBe('~~old~~');
    expect(toMd('<p>see <code>x</code> here</p>')).toBe('see `x` here');
  });

  it('converts links and bare URLs', () => {
    expect(toMd('<p><a href="https://x.com">link</a></p>')).toBe('[link](https://x.com)');
    expect(toMd('<p><a href="https://x.com">https://x.com</a></p>')).toBe('https://x.com');
  });

  it('converts unordered and ordered lists', () => {
    expect(toMd('<ul><li>one</li><li>two</li></ul>').trim()).toBe('- one\n- two');
    expect(toMd('<ol><li>alpha</li><li>beta</li></ol>').trim()).toBe('1. alpha\n2. beta');
  });

  it('converts blockquotes preserving newlines', () => {
    expect(toMd('<blockquote>line one<br>line two</blockquote>').trim()).toBe(
      '> line one\n> line two',
    );
  });

  it('round-trips simple markdown via markdownToEditableHtml + htmlToMarkdown', () => {
    const md = 'Hello **bold** and *italic* and ~~strike~~ and `code`.';
    const div = document.createElement('div');
    div.innerHTML = markdownToEditableHtml(md);
    expect(htmlToMarkdown(div)).toBe(md);
  });

  it('round-trips a list', () => {
    const md = '- one\n- two';
    const div = document.createElement('div');
    div.innerHTML = markdownToEditableHtml(md);
    expect(htmlToMarkdown(div)).toBe(md);
  });

  it('round-trips a blockquote', () => {
    const md = '> hello\n> world';
    const div = document.createElement('div');
    div.innerHTML = markdownToEditableHtml(md);
    expect(htmlToMarkdown(div)).toBe(md);
  });

  it('escapes HTML in source markdown so user input cannot inject tags', () => {
    const md = '<script>alert(1)</script>';
    const html = markdownToEditableHtml(md);
    // The dangerous tags must be escaped in the produced HTML.
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
