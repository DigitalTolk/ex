import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, X, ZoomIn, ZoomOut } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { getInitials, formatLongDateTime, formatBytes } from '@/lib/format';
import { iconForAttachment, isImageContentType } from '@/lib/file-helpers';
import { useTransientOverlayCleanup } from '@/hooks/useTransientOverlayCleanup';

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
  const lightboxRef = useRef<HTMLDivElement>(null);
  const imageKey = current ? `${current.url}\u0000${safeIndex}` : '';
  const [zoomState, setZoomState] = useState({ key: '', value: 1 });
  const [panState, setPanState] = useState({ key: '', x: 0, y: 0 });
  const panGestureRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const zoom = zoomState.key === imageKey ? zoomState.value : 1;
  const pan = panState.key === imageKey && zoom > 1 ? panState : { key: imageKey, x: 0, y: 0 };
  useTransientOverlayCleanup(open, { rootRef: lightboxRef, lockScroll: true });

  function setCurrentZoom(update: (value: number) => number) {
    const next = update(zoom);
    setZoomState({ key: imageKey, value: next });
    if (next <= 1) {
      setPanState({ key: imageKey, x: 0, y: 0 });
      panGestureRef.current = null;
    }
  }

  const handleClose = useCallback(() => {
    setZoomState({ key: '', value: 1 });
    setPanState({ key: '', x: 0, y: 0 });
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        handleClose();
        // Esc is a keyboard interaction, which flips :focus-visible on
        // for whatever element holds focus next — usually the
        // attachment-trigger button that opened the lightbox. Blur it
        // so the trigger doesn't end up wearing a keyboard-focus ring
        // after a mouse-click → Esc round-trip.
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
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
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [open, handleClose, onIndexChange, safeIndex, total]);

  if (!open || typeof document === 'undefined' || !current) return null;

  const isImage = isImageContentType(current.contentType);
  const iconType = iconForAttachment(current.contentType, current.filename);

  return createPortal(
    <div
      ref={lightboxRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Attachment preview: ${current.filename}`}
      data-testid="image-lightbox"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-6 pt-[calc(2.75rem+1.5rem)] max-md:px-3 max-md:pb-[calc(env(safe-area-inset-bottom)+0.75rem)] max-md:pt-[calc(env(safe-area-inset-top)+4.5rem)]"
      onClick={handleClose}
    >
      <div
        className="absolute inset-x-0 top-11 flex items-center gap-3 bg-gradient-to-b from-black/70 to-transparent px-4 pb-3 pt-3 text-white max-md:top-0 max-md:pt-[calc(env(safe-area-inset-top)+0.75rem)]"
        data-testid="image-lightbox-toolbar"
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
        {isImage && (
          <div className="flex items-center gap-1" role="group" aria-label="Image zoom controls">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setCurrentZoom((value) => Math.max(1, Math.round((value - 0.5) * 10) / 10));
              }}
              aria-label="Zoom out"
              data-testid="image-lightbox-zoom-out"
              className="flex h-9 w-9 items-center justify-center rounded-md text-white/80 hover:bg-white/15 hover:text-white disabled:opacity-40"
              disabled={zoom <= 1}
            >
              <ZoomOut className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setCurrentZoom((value) => Math.min(4, Math.round((value + 0.5) * 10) / 10));
              }}
              aria-label="Zoom in"
              data-testid="image-lightbox-zoom-in"
              className="flex h-9 w-9 items-center justify-center rounded-md text-white/80 hover:bg-white/15 hover:text-white"
            >
              <ZoomIn className="h-4 w-4" />
            </button>
          </div>
        )}
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
          onClick={handleClose}
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
        <div
          className="flex max-h-full max-w-full items-center justify-center overflow-auto touch-none overscroll-contain"
          data-testid="image-lightbox-zoom-stage"
          onClick={(e) => e.stopPropagation()}
          onWheel={(e) => {
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();
            setCurrentZoom((value) => {
              const next = e.deltaY < 0 ? value + 0.25 : value - 0.25;
              return Math.min(4, Math.max(1, Math.round(next * 100) / 100));
            });
          }}
          onPointerDown={(e) => {
            if (zoom <= 1) return;
            e.stopPropagation();
            e.currentTarget.setPointerCapture?.(e.pointerId);
            panGestureRef.current = {
              pointerId: e.pointerId,
              startX: e.clientX,
              startY: e.clientY,
              originX: pan.x,
              originY: pan.y,
            };
          }}
          onPointerMove={(e) => {
            const gesture = panGestureRef.current;
            if (!gesture || gesture.pointerId !== e.pointerId) return;
            e.preventDefault();
            e.stopPropagation();
            setPanState({
              key: imageKey,
              x: gesture.originX + e.clientX - gesture.startX,
              y: gesture.originY + e.clientY - gesture.startY,
            });
          }}
          onPointerUp={(e) => {
            if (panGestureRef.current?.pointerId === e.pointerId) {
              e.stopPropagation();
              panGestureRef.current = null;
              e.currentTarget.releasePointerCapture?.(e.pointerId);
            }
          }}
          onPointerCancel={(e) => {
            if (panGestureRef.current?.pointerId === e.pointerId) {
              panGestureRef.current = null;
              e.currentTarget.releasePointerCapture?.(e.pointerId);
            }
          }}
        >
          <img
            src={current.url}
            alt={current.filename}
            className={`max-h-[88vh] max-w-[92vw] rounded-md object-contain shadow-2xl transition-transform max-md:max-h-[calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom)-6rem)] ${zoom > 1 ? 'cursor-grab active:cursor-grabbing' : ''}`}
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
            onDoubleClick={() => setCurrentZoom((value) => (value > 1 ? 1 : 2))}
            data-testid="image-lightbox-image"
            data-zoom={zoom}
            data-pan-x={pan.x}
            data-pan-y={pan.y}
          />
        </div>
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
