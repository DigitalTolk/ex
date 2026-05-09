import { createElement, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useSwipeable } from 'react-swipeable';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { getInitials, formatLongDateTime, formatBytes } from '@/lib/format';
import { iconForAttachment, isImageContentType } from '@/lib/file-helpers';
import { useTransientOverlayCleanup } from '@/hooks/useTransientOverlayCleanup';
import { useIsMobile } from '@/hooks/useIsMobile';

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
  const isMobile = useIsMobile();
  const safeIndex = total === 0 ? 0 : ((index % total) + total) % total;
  const current = images[safeIndex];
  const isImage = current ? isImageContentType(current.contentType) : false;
  const lightboxRef = useRef<HTMLDivElement>(null);
  const imageKey = current ? `${current.url}\u0000${safeIndex}` : '';
  const [zoomState, setZoomState] = useState({ key: '', value: 1 });
  const [panState, setPanState] = useState({ key: '', x: 0, y: 0 });
  const [swipeDrag, setSwipeDrag] = useState({ x: 0, y: 0 });
  const panGestureRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const swipeGestureRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
  } | null>(null);
  const activePointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchGestureRef = useRef<{
    startDistance: number;
    startZoom: number;
    centerX: number;
    centerY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const zoom = zoomState.key === imageKey ? zoomState.value : 1;
  const pan = panState.key === imageKey && zoom > 1 ? panState : { key: imageKey, x: 0, y: 0 };
  useTransientOverlayCleanup(open, { rootRef: lightboxRef, lockScroll: true });

  function setCurrentZoom(update: (value: number) => number) {
    const next = Math.min(6, Math.max(1, update(zoom)));
    setZoomState({ key: imageKey, value: next });
    if (next <= 1) {
      setPanState({ key: imageKey, x: 0, y: 0 });
      panGestureRef.current = null;
      pinchGestureRef.current = null;
    }
  }

  function toggleMobileDoubleTapZoom() {
    if (zoom > 1 || pan.x !== 0 || pan.y !== 0) {
      setZoomState({ key: imageKey, value: 1 });
      setPanState({ key: imageKey, x: 0, y: 0 });
      return;
    }
    setZoomState({ key: imageKey, value: 2 });
    setPanState({ key: imageKey, x: 0, y: 0 });
  }

  function handleMobileTap(x: number, y: number) {
    if (!isMobile || !isImage) return false;
    const now = Date.now();
    const previous = lastTapRef.current;
    if (previous && now - previous.time <= 450 && Math.hypot(x - previous.x, y - previous.y) <= 56) {
      lastTapRef.current = null;
      toggleMobileDoubleTapZoom();
      return true;
    }
    lastTapRef.current = { time: now, x, y };
    return false;
  }

  const imageTapHandlers = useSwipeable({
    delta: 24,
    trackMouse: false,
    preventScrollOnSwipe: false,
    touchEventOptions: { passive: true },
    onTap: ({ event }) => {
      const touchEvent = event as TouchEvent;
      const touch = touchEvent.changedTouches?.[0];
      if (!touch) return;
      if (handleMobileTap(touch.clientX, touch.clientY)) {
        event.stopPropagation();
      }
    },
  });

  const handleClose = useCallback(() => {
    setZoomState({ key: '', value: 1 });
    setPanState({ key: '', x: 0, y: 0 });
    activePointersRef.current.clear();
    pinchGestureRef.current = null;
    panGestureRef.current = null;
    swipeGestureRef.current = null;
    lastTapRef.current = null;
    setSwipeDrag({ x: 0, y: 0 });
    onClose();
  }, [onClose]);

  function pointerDistance(points: Array<{ x: number; y: number }>) {
    const [a, b] = points;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function pointerCenter(points: Array<{ x: number; y: number }>) {
    const [a, b] = points;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

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

  const iconType = iconForAttachment(current.contentType, current.filename);
  const swipeStageStyle = swipeDrag.x !== 0 || swipeDrag.y !== 0
    ? { transform: `translate3d(${Math.round(swipeDrag.x)}px, ${Math.round(swipeDrag.y)}px, 0)`, transition: 'none' }
    : undefined;

  function handleLightboxPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // Synthetic browser-test PointerEvents are not active pointers.
    }
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pointers = Array.from(activePointersRef.current.values());
    if (isImage && pointers.length >= 2) {
      const two = pointers.slice(0, 2);
      const center = pointerCenter(two);
      pinchGestureRef.current = {
        startDistance: Math.max(1, pointerDistance(two)),
        startZoom: zoom,
        centerX: center.x,
        centerY: center.y,
        originX: pan.x,
        originY: pan.y,
      };
      panGestureRef.current = null;
      swipeGestureRef.current = null;
      setSwipeDrag({ x: 0, y: 0 });
      return;
    }
    if (isImage && zoom > 1) {
      panGestureRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        originX: pan.x,
        originY: pan.y,
      };
      swipeGestureRef.current = null;
      setSwipeDrag({ x: 0, y: 0 });
      return;
    }
    if (isMobile) {
      swipeGestureRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
      };
    }
  }

  function handleLightboxPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (activePointersRef.current.has(e.pointerId)) {
      activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    const pointers = Array.from(activePointersRef.current.values());
    const pinch = pinchGestureRef.current;
    if (isImage && pinch && pointers.length >= 2) {
      e.preventDefault();
      e.stopPropagation();
      const two = pointers.slice(0, 2);
      const distance = Math.max(1, pointerDistance(two));
      const center = pointerCenter(two);
      const nextZoom = Math.min(6, Math.max(1, Math.round((pinch.startZoom * distance / pinch.startDistance) * 100) / 100));
      setZoomState({ key: imageKey, value: nextZoom });
      setPanState({
        key: imageKey,
        x: pinch.originX + center.x - pinch.centerX,
        y: pinch.originY + center.y - pinch.centerY,
      });
      return;
    }
    const panGesture = panGestureRef.current;
    if (isImage && panGesture?.pointerId === e.pointerId) {
      e.preventDefault();
      e.stopPropagation();
      setPanState({
        key: imageKey,
        x: panGesture.originX + e.clientX - panGesture.startX,
        y: panGesture.originY + e.clientY - panGesture.startY,
      });
      return;
    }
    if (!isMobile) return;
    const swipe = swipeGestureRef.current;
    if (!swipe || swipe.pointerId !== e.pointerId || (isImage && zoom > 1) || pinchGestureRef.current) return;
    swipe.lastX = e.clientX;
    swipe.lastY = e.clientY;
    const dx = e.clientX - swipe.startX;
    const dy = e.clientY - swipe.startY;
    if (Math.max(Math.abs(dx), Math.abs(dy)) > 12) {
      e.preventDefault();
      e.stopPropagation();
      const horizontal = Math.abs(dx) > Math.abs(dy) * 1.15;
      const vertical = dy > 0 && Math.abs(dy) > Math.abs(dx) * 1.15;
      setSwipeDrag({
        x: horizontal ? dx : 0,
        y: vertical ? Math.max(0, dy) : 0,
      });
    }
  }

  function handleLightboxPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const swipe = isMobile ? swipeGestureRef.current : null;
    const panGesture = panGestureRef.current;
    activePointersRef.current.delete(e.pointerId);
    if (activePointersRef.current.size < 2) {
      pinchGestureRef.current = null;
    }
    if (swipe?.pointerId === e.pointerId) {
      const dx = e.clientX - swipe.startX;
      const dy = e.clientY - swipe.startY;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      swipeGestureRef.current = null;
      setSwipeDrag({ x: 0, y: 0 });
      if (!(isImage && zoom > 1) && absY >= 70 && dy > 0 && absY > absX * 1.15) {
        e.preventDefault();
        e.stopPropagation();
        handleClose();
        return;
      }
      if (!(isImage && zoom > 1) && total > 1 && absX >= 70 && absX > absY * 1.15) {
        e.preventDefault();
        e.stopPropagation();
        onIndexChange(dx < 0 ? (safeIndex + 1) % total : (safeIndex - 1 + total) % total);
        return;
      }
    }
    if (panGesture?.pointerId === e.pointerId) {
      e.stopPropagation();
      panGestureRef.current = null;
    }
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      // Pointer capture may not have been acquired.
    }
  }

  function handleLightboxPointerCancel(e: ReactPointerEvent<HTMLDivElement>) {
    activePointersRef.current.delete(e.pointerId);
    if (swipeGestureRef.current?.pointerId === e.pointerId) {
      swipeGestureRef.current = null;
      setSwipeDrag({ x: 0, y: 0 });
    }
    if (activePointersRef.current.size < 2) {
      pinchGestureRef.current = null;
    }
    if (panGestureRef.current?.pointerId === e.pointerId) {
      panGestureRef.current = null;
    }
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      // Pointer capture may not have been acquired.
    }
  }

  function handleImageStageDoubleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!isMobile || !isImage) return;
    e.preventDefault();
    e.stopPropagation();
    toggleMobileDoubleTapZoom();
  }

  return createPortal(
    <div
      ref={lightboxRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Attachment preview: ${current.filename}`}
      data-testid="image-lightbox"
      className="fixed inset-0 isolate z-[100] flex items-center justify-center bg-black/80 p-6 pt-[calc(2.75rem+1.5rem)] max-md:px-3 max-md:pb-[calc(env(safe-area-inset-bottom)+0.75rem)] max-md:pt-[calc(env(safe-area-inset-top)+4.5rem)]"
      onClick={handleClose}
    >
      <div
        className="fixed inset-x-0 top-11 flex items-center gap-3 bg-gradient-to-b from-black/70 to-transparent px-4 pb-3 pt-3 text-white max-md:top-0 max-md:pt-[calc(env(safe-area-inset-top)+0.75rem)]"
        style={{ zIndex: 130 }}
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
                setCurrentZoom((value) => Math.round((value - 0.75) * 10) / 10);
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
                setCurrentZoom((value) => Math.round((value + 0.75) * 10) / 10);
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
          onDoubleClick={() => setCurrentZoom((value) => (value > 1 ? 1 : 2))}
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
            className="fixed left-3 top-1/2 -translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60"
            style={{ zIndex: 130 }}
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
            className="fixed right-3 top-1/2 -translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60"
            style={{ zIndex: 130 }}
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        </>
      )}

      {isImage ? (
        <div
          className="fixed inset-0 flex items-center justify-center overflow-hidden touch-none overscroll-contain px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-[calc(env(safe-area-inset-top)+4.5rem)] md:p-16"
          style={{ zIndex: 110, ...swipeStageStyle }}
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
          onPointerDown={handleLightboxPointerDown}
          onPointerMove={handleLightboxPointerMove}
          onPointerUp={handleLightboxPointerUp}
          onPointerCancel={handleLightboxPointerCancel}
          onDoubleClick={handleImageStageDoubleClick}
          {...imageTapHandlers}
        >
          <img
            src={current.url}
            alt={current.filename}
            className={`pointer-events-none max-h-full max-w-full rounded-md object-contain shadow-2xl transition-transform ${zoom > 1 ? 'cursor-grab active:cursor-grabbing' : ''}`}
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
            data-testid="image-lightbox-image"
            data-zoom={zoom}
            data-pan-x={pan.x}
            data-pan-y={pan.y}
          />
        </div>
      ) : (
        <div
          className="fixed inset-0 flex touch-none items-center justify-center overscroll-contain px-4 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-[calc(env(safe-area-inset-top)+4.5rem)] md:p-16"
          style={{ zIndex: 110, ...swipeStageStyle }}
          data-testid="image-lightbox-attachment-stage"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={handleLightboxPointerDown}
          onPointerMove={handleLightboxPointerMove}
          onPointerUp={handleLightboxPointerUp}
          onPointerCancel={handleLightboxPointerCancel}
        >
        <div
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerMove={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onPointerCancel={(e) => e.stopPropagation()}
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
            onClick={(e) => e.stopPropagation()}
            data-testid="image-lightbox-file-download"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Download className="h-4 w-4" />
            Download
          </a>
        </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
