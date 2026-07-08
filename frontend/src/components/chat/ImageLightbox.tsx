import { createElement, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, X, ZoomIn, ZoomOut } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { getInitials, formatLongDateTime, formatBytes } from '@/lib/format';
import { iconForAttachment, isImageContentType } from '@/lib/file-helpers';
import { useTransientOverlayCleanup } from '@/hooks/useTransientOverlayCleanup';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useMobileBackClose } from '@/hooks/useMobileBackClose';
import {
  type GestureState,
  idleGesture,
  onPointerDown as gestureOnPointerDown,
  readPanUpdate,
  readPinchUpdate,
  readSwipeDrag,
  trackSwipe,
  tryInvalidateTap,
  isTapRelease,
  classifyDoubleTap,
  classifySwipe,
} from './lightbox-gestures';

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
  // Back on mobile closes the lightbox instead of leaving the channel.
  useMobileBackClose(open, onClose);
  const safeIndex = total === 0 ? 0 : ((index % total) + total) % total;
  const current = images[safeIndex];
  const isImage = current ? isImageContentType(current.contentType) : false;
  const lightboxRef = useRef<HTMLDivElement>(null);
  const imageKey = current ? `${current.url}\u0000${safeIndex}` : '';
  const [zoomState, setZoomState] = useState({ key: '', value: 1 });
  const [panState, setPanState] = useState({ key: '', x: 0, y: 0 });
  const [swipeDrag, setSwipeDrag] = useState({ x: 0, y: 0 });
  // gestureRef holds the active gesture as a tagged union — only one
  // of pinch/pan/swipe can be active at a time, by definition. The
  // mutual exclusivity that was previously enforced by manual null-
  // outs across the three legacy refs is now structural. See
  // ./lightbox-gestures.ts for the state machine.
  const gestureRef = useRef<GestureState>(idleGesture);
  const activePointersRef = useRef(new Map<number, { x: number; y: number }>());
  // tap-pending lives alongside `gestureRef` rather than inside it
  // because a single touch is simultaneously a candidate tap AND a
  // candidate swipe — we don't know which until the pointer either
  // moves (swipe) or releases stationary (tap).
  const tapStartRef = useRef<GestureState | null>(null);
  // Last completed tap, used to chain into a double-tap zoom toggle.
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const zoom = zoomState.key === imageKey ? zoomState.value : 1;
  const pan = panState.key === imageKey && zoom > 1 ? panState : { key: imageKey, x: 0, y: 0 };
  useTransientOverlayCleanup(open, { rootRef: lightboxRef, lockScroll: true });

  function setCurrentZoom(update: (value: number) => number) {
    const next = Math.min(6, Math.max(1, update(zoom)));
    setZoomState({ key: imageKey, value: next });
    if (next <= 1) {
      setPanState({ key: imageKey, x: 0, y: 0 });
      // Zooming back out cancels any in-flight pan/pinch — the
      // tagged-union state machine doesn't allow them to apply
      // anyway once zoom == 1, but the explicit reset keeps the
      // gesture lifecycle deterministic.
      const g = gestureRef.current;
      /* istanbul ignore next -- setCurrentZoom only runs from the zoom buttons/wheel/double-click, none of which can fire while a pointer-held pan/pinch is active, so g is always idle here. */
      if (g.kind === 'pan' || g.kind === 'pinch') gestureRef.current = idleGesture;
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
    /* v8 ignore next 3 -- unreachable double-check: lightbox-gestures' onPointerDown only issues a tapStart when isImage && isMobile (tapEligible), and isTapRelease is false without one, so this call never sees the other combinations; kept because the invariant lives in a separate module and could drift */
    /* istanbul ignore next -- see v8 note above */
    if (!isMobile || !isImage) return false;
    const now = Date.now();
    if (classifyDoubleTap(lastTapRef.current, { time: now, x, y })) {
      lastTapRef.current = null;
      toggleMobileDoubleTapZoom();
      return true;
    }
    lastTapRef.current = { time: now, x, y };
    return false;
  }

  const handleClose = useCallback(() => {
    setZoomState({ key: '', value: 1 });
    setPanState({ key: '', x: 0, y: 0 });
    activePointersRef.current.clear();
    gestureRef.current = idleGesture;
    lastTapRef.current = null;
    tapStartRef.current = null;
    setSwipeDrag({ x: 0, y: 0 });
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
        /* istanbul ignore else -- document.activeElement defaults to <body> (an HTMLElement) and is never a non-HTMLElement/null in this browser, so the else arm is unreachable. */
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

  function activePointers() {
    return Array.from(activePointersRef.current.entries()).map(([pointerId, p]) => ({
      pointerId,
      x: p.x,
      y: p.y,
    }));
  }

  function handleLightboxPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // Synthetic browser-test PointerEvents are not active pointers.
    }
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const { state, tapStart } = gestureOnPointerDown(
      gestureRef.current,
      { pointerId: e.pointerId, x: e.clientX, y: e.clientY, pointerType: e.pointerType, time: Date.now() },
      activePointers(),
      { isImage, isMobile, zoom, panX: pan.x, panY: pan.y },
    );
    gestureRef.current = state;
    tapStartRef.current = tapStart;
    if (state.kind !== 'idle') {
      setSwipeDrag({ x: 0, y: 0 });
    }
  }

  function handleLightboxPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (activePointersRef.current.has(e.pointerId)) {
      activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    const pointer = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    tapStartRef.current = tryInvalidateTap(tapStartRef.current, pointer);

    const pinch = readPinchUpdate(gestureRef.current, activePointers());
    if (pinch) {
      e.preventDefault();
      e.stopPropagation();
      setZoomState({ key: imageKey, value: pinch.zoom });
      setPanState({ key: imageKey, x: pinch.panX, y: pinch.panY });
      return;
    }
    const panUpdate = readPanUpdate(gestureRef.current, pointer);
    if (panUpdate && isImage) {
      e.preventDefault();
      e.stopPropagation();
      setPanState({ key: imageKey, x: panUpdate.panX, y: panUpdate.panY });
      return;
    }
    if (!isMobile) return;
    // Pan/pinch already won — no swipe processing.
    /* istanbul ignore next -- an active pan returns at readPanUpdate above and an active pinch returns at readPinchUpdate, so by here the gesture is never pan/pinch; this is a belt-and-braces guard. */
    if (gestureRef.current.kind === 'pan' || gestureRef.current.kind === 'pinch') return;
    const drag = readSwipeDrag(gestureRef.current, pointer);
    if (drag) {
      e.preventDefault();
      e.stopPropagation();
      setSwipeDrag({ x: drag.dx, y: drag.dy });
    }
    gestureRef.current = trackSwipe(gestureRef.current, pointer);
  }

  function handleLightboxPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const tapStart = tapStartRef.current;
    tapStartRef.current = null;
    activePointersRef.current.delete(e.pointerId);
    const remaining = activePointers();
    const pointer = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };

    // Pinch ends when fewer than 2 pointers remain. Drop the active
    // gesture back to idle (subsequent drags will start fresh).
    if (gestureRef.current.kind === 'pinch' && remaining.length < 2) {
      gestureRef.current = idleGesture;
    }

    // Tap release: chain with previous tap into a double-tap.
    if (
      isTapRelease(tapStart, { ...pointer, time: Date.now() }, remaining) &&
      gestureRef.current.kind !== 'pinch' &&
      handleMobileTap(e.clientX, e.clientY)
    ) {
      e.stopPropagation();
      gestureRef.current = idleGesture;
      setSwipeDrag({ x: 0, y: 0 });
      try {
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      } catch { /* pointer capture may not have been acquired */ }
      return;
    }

    // Swipe completion: classify into close / next / prev / none.
    if (gestureRef.current.kind === 'swipe' && gestureRef.current.pointerId === e.pointerId) {
      const outcome = classifySwipe(
        gestureRef.current,
        pointer,
        isImage && zoom > 1,
        total > 1,
      );
      gestureRef.current = idleGesture;
      setSwipeDrag({ x: 0, y: 0 });
      if (outcome.kind === 'close') {
        e.preventDefault();
        e.stopPropagation();
        handleClose();
        return;
      }
      if (outcome.kind === 'next') {
        e.preventDefault();
        e.stopPropagation();
        onIndexChange((safeIndex + 1) % total);
        return;
      }
      if (outcome.kind === 'prev') {
        e.preventDefault();
        e.stopPropagation();
        onIndexChange((safeIndex - 1 + total) % total);
        return;
      }
    }

    if (gestureRef.current.kind === 'pan' && gestureRef.current.pointerId === e.pointerId) {
      e.stopPropagation();
      gestureRef.current = idleGesture;
    }
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch { /* pointer capture may not have been acquired */ }
  }

  function handleLightboxPointerCancel(e: ReactPointerEvent<HTMLDivElement>) {
    activePointersRef.current.delete(e.pointerId);
    if (
      tapStartRef.current?.kind === 'tap-pending' &&
      tapStartRef.current.pointerId === e.pointerId
    ) {
      tapStartRef.current = null;
    }
    const remaining = activePointers();
    const g = gestureRef.current;
    if (g.kind === 'swipe' && g.pointerId === e.pointerId) {
      gestureRef.current = idleGesture;
      setSwipeDrag({ x: 0, y: 0 });
    } else if (g.kind === 'pan' && g.pointerId === e.pointerId) {
      gestureRef.current = idleGesture;
    } else if (g.kind === 'pinch' && remaining.length < 2) {
      gestureRef.current = idleGesture;
    }
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch { /* pointer capture may not have been acquired */ }
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
      className="fixed inset-0 isolate z-[100] flex items-center justify-center bg-black/80 p-6 pt-[calc(2.75rem+1.5rem)] mobile:px-3 mobile:pb-[calc(env(safe-area-inset-bottom)+0.75rem)] mobile:pt-[calc(env(safe-area-inset-top)+4.5rem)]"
      onClick={handleClose}
    >
      <div
        className="fixed inset-x-0 top-11 flex items-center gap-3 bg-gradient-to-b from-black/70 to-transparent px-4 pb-3 pt-3 text-white mobile:top-0 mobile:pt-[calc(env(safe-area-inset-top)+0.75rem)]"
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
