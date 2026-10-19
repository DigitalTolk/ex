// Which attachments offer the in-app HTML preview. Kept apart from
// lib/html-preview.ts (the frame's security machinery) because every message
// row imports this, while the preview itself is a lazy chunk.

// Larger files are download-only: the preview holds the whole text in memory
// (twice, as the srcdoc attribute), and a mockup is never this big.
export const HTML_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

export function isHtmlAttachment(contentType: string, filename = ''): boolean {
  return /^text\/html\b/i.test(contentType.trim()) || /\.html?$/i.test(filename);
}

interface PreviewableAttachment {
  contentType: string;
  filename: string;
  size: number;
  url?: string;
}

// canPreviewHtml decides whether an attachment row offers "Preview".
export function canPreviewHtml<T extends PreviewableAttachment>(att: T): att is T & { url: string } {
  return !!att.url && att.size <= HTML_PREVIEW_MAX_BYTES && isHtmlAttachment(att.contentType, att.filename);
}
