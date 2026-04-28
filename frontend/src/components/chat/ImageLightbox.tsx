import { createElement, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { getInitials, formatLongDateTime, formatBytes } from '@/lib/format';
import { iconForAttachment, isImageContentType } from '@/lib/file-helpers';

export interface LightboxImage {
  url: string;
  downloadURL?: string;
  filename: string;
  contentType: string;
  size: number;
}

interface ImageLightboxProps {
  open: boolean;
  onClose: () => void;
  images: LightboxImage[];
  index: number;
  // Caller owns the index so the modal stays a controlled component —
  // left/right arrow + chevron buttons all route through here.
  onIndexChange: (next: number) => void;
  authorName: string;
  authorAvatarURL?: string;
  // Human-readable parent label, e.g. "~general" or "Direct message".
  postedIn?: string;
  postedAt: string;
}

export function ImageLightbox({
  open,
  onClose,
  images,
  index,
  onIndexChange,
  authorName,
  authorAvatarURL,
  postedIn,
  postedAt,
}: ImageLightboxProps) {
  const total = images.length;
  const safeIndex = total === 0 ? 0 : ((index % total) + total) % total;
  const current = images[safeIndex];

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (total <= 1) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        onIndexChange((safeIndex + 1) % total);
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        onIndexChange((safeIndex - 1 + total) % total);
        return;
      }
    }
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose, onIndexChange, safeIndex, total]);

  if (!open || typeof document === 'undefined' || !current) return null;

  const isImage = isImageContentType(current.contentType);
  const iconType = iconForAttachment(current.contentType, current.filename);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Attachment preview: ${current.filename}`}
      data-testid="image-lightbox"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-6"
      onClick={onClose}
    >
      <div
        className="absolute inset-x-0 top-0 flex items-center gap-3 bg-gradient-to-b from-black/70 to-transparent px-4 py-3 text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <Avatar className="h-8 w-8 ring-2 ring-white/30">
          {authorAvatarURL && <AvatarImage src={authorAvatarURL} alt="" />}
          <AvatarFallback className="bg-white/20 text-xs text-white">
            {getInitials(authorName || '?')}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{authorName}</p>
          <p className="truncate text-xs text-white/70">
            {postedIn ? `${postedIn} · ` : ''}
            {formatLongDateTime(postedAt)}
            {total > 1 ? ` · ${safeIndex + 1} / ${total}` : ''}
          </p>
        </div>
        <a
          href={current.downloadURL ?? current.url}
          download={current.filename}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Download ${current.filename}`}
          data-testid="image-lightbox-download"
          className="flex h-9 w-9 items-center justify-center rounded-md text-white/80 hover:bg-white/15 hover:text-white"
        >
          <Download className="h-4 w-4" />
        </a>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close attachment preview"
          data-testid="image-lightbox-close"
          className="flex h-9 w-9 items-center justify-center rounded-md text-white/80 hover:bg-white/15 hover:text-white"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {total > 1 && (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onIndexChange((safeIndex - 1 + total) % total);
            }}
            aria-label="Previous attachment"
            data-testid="image-lightbox-prev"
            className="absolute left-3 top-1/2 -translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onIndexChange((safeIndex + 1) % total);
            }}
            aria-label="Next attachment"
            data-testid="image-lightbox-next"
            className="absolute right-3 top-1/2 -translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        </>
      )}

      {isImage ? (
        <img
          src={current.url}
          alt={current.filename}
          className="max-h-[88vh] max-w-[92vw] rounded-md object-contain shadow-2xl"
          onClick={(e) => e.stopPropagation()}
          data-testid="image-lightbox-image"
        />
      ) : (
        <div
          onClick={(e) => e.stopPropagation()}
          data-testid="image-lightbox-fileinfo"
          className="flex flex-col items-center gap-4 rounded-lg bg-card p-8 text-card-foreground shadow-2xl"
        >
          {createElement(iconType, { className: 'h-20 w-20 text-muted-foreground' })}
          <div className="text-center">
            <p className="break-all text-sm font-semibold">{current.filename}</p>
            <p className="mt-1 text-xs text-muted-foreground">{formatBytes(current.size)}</p>
          </div>
          <a
            href={current.downloadURL ?? current.url}
            download={current.filename}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Download className="h-4 w-4" />
            Download
          </a>
        </div>
      )}
    </div>,
    document.body,
  );
}
