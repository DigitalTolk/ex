import { describe, expect, it } from 'vitest';
import { canPreviewHtml, HTML_PREVIEW_MAX_BYTES, htmlPreviewURL, isHtmlAttachment } from './html-attachment';

describe('htmlPreviewURL', () => {
  it('serves the same media token from the preview route, grant included', () => {
    expect(htmlPreviewURL('/api/v1/media/tok/mockup.html')).toBe('/api/v1/html-preview/tok/mockup.html');
    expect(htmlPreviewURL('/api/v1/media/tok/My%20Mockup.html?g=abc.def')).toBe('/api/v1/html-preview/tok/My%20Mockup.html?g=abc.def');
  });

  it('has no preview for a URL that is not one of our media URLs', () => {
    // A presigned object-store URL (the media cache was down) cannot carry
    // the preview's own policy.
    expect(htmlPreviewURL('https://bucket.s3.example.com/attachments/a?X-Amz-Signature=x')).toBeNull();
    expect(htmlPreviewURL('https://evil.test/api/v1/media/tok/mockup.html')).toBeNull();
    expect(htmlPreviewURL('/api/v1/media/tok')).toBeNull();
    expect(htmlPreviewURL('/api/v1/media/tok/a.html#frag')).toBeNull();
  });
});

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
    expect(canPreviewHtml({ ...html, url: 'https://bucket.s3.example.com/attachments/a' })).toBe(false);
    expect(canPreviewHtml({ ...html, contentType: 'application/pdf', filename: 'a.pdf' })).toBe(false);
  });
});
