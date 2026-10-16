import { describe, expect, it } from 'vitest';
import { canPreviewHtml, HTML_PREVIEW_MAX_BYTES, isHtmlAttachment } from './html-attachment';

describe('isHtmlAttachment / canPreviewHtml', () => {
  it('recognises HTML by content type or extension', () => {
    expect(isHtmlAttachment('text/html')).toBe(true);
    expect(isHtmlAttachment('text/html; charset=utf-8')).toBe(true);
    expect(isHtmlAttachment('TEXT/HTML')).toBe(true);
    expect(isHtmlAttachment('application/octet-stream', 'mockup.html')).toBe(true);
    expect(isHtmlAttachment('application/octet-stream', 'MOCKUP.HTM')).toBe(true);
    expect(isHtmlAttachment('text/plain', 'notes.txt')).toBe(false);
    expect(isHtmlAttachment('text/htmlx', 'a.txt')).toBe(false);
    expect(isHtmlAttachment('application/zip', 'site.html.zip')).toBe(false);
    expect(isHtmlAttachment('application/xhtml+xml')).toBe(false);
  });

  const html = { contentType: 'text/html', filename: 'mockup.html', size: 1000, url: '/api/v1/media/t/mockup.html' };

  it('offers Preview for a fetchable HTML file up to 2 MB', () => {
    expect(canPreviewHtml(html)).toBe(true);
    expect(canPreviewHtml({ ...html, size: HTML_PREVIEW_MAX_BYTES })).toBe(true);
    expect(HTML_PREVIEW_MAX_BYTES).toBe(2 * 1024 * 1024);
  });

  it('is download-only when oversized, unresolved, or not HTML', () => {
    expect(canPreviewHtml({ ...html, size: HTML_PREVIEW_MAX_BYTES + 1 })).toBe(false);
    expect(canPreviewHtml({ ...html, url: undefined })).toBe(false);
    expect(canPreviewHtml({ ...html, contentType: 'application/pdf', filename: 'a.pdf' })).toBe(false);
  });
});
