import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  type LucideIcon,
} from 'lucide-react';

export function isImageURL(name: string): boolean {
  return /\.(png|jpg|jpeg|gif|webp|bmp|svg)(\?|$)/i.test(name);
}

export function isImageContentType(ct: string): boolean {
  return /^image\//i.test(ct);
}

export function isImageAttachment(contentType: string, filename = ''): boolean {
  return isImageContentType(contentType) || isImageURL(filename);
}

// Max display box for an inline image thumbnail — shared by the chat
// message list and the message-link preview card so a shared image renders
// at the same size in both.
export const THUMBNAIL_MAX_WIDTH = 320;
export const THUMBNAIL_MAX_HEIGHT = 288;

// Scales intrinsic image dimensions into the thumbnail box, never upscaling.
// Returns {} when the dimensions are unknown so the caller falls back to its
// CSS max-width/height caps.
export function scaleToThumbnail(width?: number, height?: number): { width?: number; height?: number } {
  if (!width || !height) return {};
  const scale = Math.min(1, THUMBNAIL_MAX_WIDTH / width, THUMBNAIL_MAX_HEIGHT / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

// Resolves a Lucide icon component for a given attachment. Falls back to
// the generic File glyph when nothing matches. The mapping checks the
// MIME type first (more reliable when present) then the extension —
// some uploads come through with `application/octet-stream` and only
// the filename hints at the kind.
export function iconForAttachment(contentType: string, filename = ''): LucideIcon {
  const ct = contentType.toLowerCase();
  if (ct.startsWith('image/')) return FileImage;
  if (ct.startsWith('video/')) return FileVideo;
  if (ct.startsWith('audio/')) return FileAudio;
  if (ct === 'application/pdf') return FileText;
  if (ct.includes('word') || ct.includes('msword')) return FileText;
  if (ct.includes('sheet') || ct.includes('excel') || ct === 'text/csv') return FileSpreadsheet;
  if (ct.includes('presentation') || ct.includes('powerpoint')) return FileImage;
  if (ct.includes('zip') || ct.includes('rar') || ct.includes('tar') || ct.includes('gzip') || ct.includes('7z')) {
    return FileArchive;
  }
  if (ct.startsWith('text/') || ct.includes('json') || ct.includes('xml')) return FileCode;

  const ext = (filename.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
  switch (ext) {
    case 'pdf':
      return FileText;
    case 'doc':
    case 'docx':
    case 'odt':
    case 'rtf':
      return FileText;
    case 'xls':
    case 'xlsx':
    case 'ods':
    case 'csv':
    case 'tsv':
      return FileSpreadsheet;
    case 'ppt':
    case 'pptx':
    case 'odp':
      return FileImage;
    case 'zip':
    case 'rar':
    case 'tar':
    case 'gz':
    case '7z':
      return FileArchive;
    case 'mp4':
    case 'mov':
    case 'avi':
    case 'mkv':
    case 'webm':
      return FileVideo;
    case 'mp3':
    case 'wav':
    case 'flac':
    case 'ogg':
    case 'm4a':
      return FileAudio;
    case 'json':
    case 'xml':
    case 'yaml':
    case 'yml':
    case 'js':
    case 'ts':
    case 'tsx':
    case 'jsx':
    case 'go':
    case 'py':
    case 'rb':
    case 'java':
    case 'c':
    case 'h':
    case 'cpp':
    case 'cs':
    case 'rs':
    case 'sh':
    case 'md':
      return FileCode;
  }
  return File;
}
