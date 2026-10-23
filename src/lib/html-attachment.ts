// Which attachments offer the in-app HTML preview. Kept apart from
// lib/html-preview.ts (the frame's security machinery) because every message
// row imports this, while the preview itself is a lazy chunk.

// Larger files are download-only: a mockup is never this big.
export const HTML_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

// The server serves the file behind a media URL's token from its own preview
// route, as a document with its own policy (internal/handler/html_preview.go).
// Only our own media URLs have one: a presigned object-store URL does not.
const MEDIA_URL = /^\/api\/v1\/media\/([^/?#]+)\/([^?#]+)(\?[^#]*)?$/;

export function htmlPreviewURL(mediaURL: string): string | null {
  const m = MEDIA_URL.exec(mediaURL);
  return m ? `/api/v1/html-preview/${m[1]}/${m[2]}${m[3] ?? ''}` : null;
}

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
  return (
    !!att.url &&
    htmlPreviewURL(att.url) !== null &&
    att.size <= HTML_PREVIEW_MAX_BYTES &&
    isHtmlAttachment(att.contentType, att.filename)
  );
}
