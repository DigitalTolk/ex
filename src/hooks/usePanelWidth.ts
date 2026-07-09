import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PANEL_WIDTHS_RESET_EVENT,
  clampPanelWidth,
  loadPanelWidth,
  savePanelWidth,
  type PanelWidthConfig,
} from '@/lib/panel-width';

// Keyboard resize step for the separator (arrow keys) — one spacing unit x4,
// small enough for fine placement, large enough to feel responsive.
const KEY_STEP = 16;

interface PanelResizeHandleProps {
  role: 'separator';
  'aria-orientation': 'vertical';
  'aria-label': string;
  'aria-valuenow': number;
  'aria-valuemin': number;
  'aria-valuemax': number;
  tabIndex: 0;
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  onDoubleClick: () => void;
}

// usePanelWidth drives one resizable layout panel: pointer-drag from its
// resize handle, arrow-key resize for keyboard users, double-click to reset,
// persistence across sessions and the global reset broadcast from profile
// settings. `grow` is the pointer direction that makes the panel WIDER:
// 'right' for the left sidebar (its handle sits on its right edge), 'left'
// for the right-hand panels (handle on their left edge).
export function usePanelWidth(cfg: PanelWidthConfig, grow: 'right' | 'left', label: string) {
  const [width, setWidth] = useState(() => loadPanelWidth(cfg));
  const widthRef = useRef(width);
  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  // Profile-settings reset (and any other tab's reset via the same event):
  // snap live panels back to their defaults.
  useEffect(() => {
    const onReset = () => setWidth(cfg.defaultWidth);
    window.addEventListener(PANEL_WIDTHS_RESET_EVENT, onReset);
    return () => window.removeEventListener(PANEL_WIDTHS_RESET_EVENT, onReset);
  }, [cfg]);

  const commit = useCallback(
    (next: number) => {
      const clamped = clampPanelWidth(cfg, next);
      setWidth(clamped);
      savePanelWidth(cfg, clamped);
      return clamped;
    },
    [cfg],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      // Primary button only — a right-click on the handle is a context menu,
      // not a resize.
      if (e.button !== 0) return;
      const startX = e.clientX;
      const startWidth = widthRef.current;
      // Drag state lives in this closure: the listeners are added and removed
      // as one unit, so their lifetime IS the drag lifetime — no shared ref,
      // no "is a drag active" bookkeeping. liveWidth tracks the latest
      // clamped value because React batches the state flush and a pointerup
      // in the same frame as the last move must not persist a stale width.
      let liveWidth = startWidth;
      const handle = e.currentTarget;
      // AbortController is the whole drag lifetime: one abort() detaches every
      // listener at once, so there's no forward-referential teardown to thread
      // through the move/up handlers.
      const drag = new AbortController();
      const stop = () => {
        savePanelWidth(cfg, liveWidth);
        drag.abort();
      };
      try {
        handle.setPointerCapture?.(e.pointerId);
      } catch {
        // Capture is a drag nicety (keeps events flowing outside the strip);
        // a pointer that can't be captured (synthetic, already released)
        // still resizes via the listeners below.
      }

      const onMove = (ev: PointerEvent) => {
        // Resize ONLY while the primary button is genuinely held. If a
        // pointerup was missed (released off-window, or the OS reclaimed the
        // pointer without firing pointercancel) the listeners stay attached;
        // the next buttonless move — i.e. a plain hover over the handle —
        // would otherwise resize the panel with no click at all. Treat that
        // move as the end of the drag instead. (bit 1 = primary button.)
        if ((ev.buttons & 1) === 0) {
          stop();
          return;
        }
        const delta = grow === 'right' ? ev.clientX - startX : startX - ev.clientX;
        liveWidth = clampPanelWidth(cfg, startWidth + delta);
        setWidth(liveWidth);
      };
      const opts = { signal: drag.signal };
      handle.addEventListener('pointermove', onMove, opts);
      handle.addEventListener('pointerup', stop, opts);
      handle.addEventListener('pointercancel', stop, opts);
      // A lost capture (window blur, OS gesture) never fires pointerup — end
      // the drag so no stray listener survives to hover-resize later.
      handle.addEventListener('lostpointercapture', stop, opts);
      e.preventDefault();
    },
    [cfg, grow],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      // Arrow semantics follow the SCREEN direction, not the grow direction:
      // ArrowRight always moves the handle right (wider for the left sidebar,
      // narrower for a right panel) so keyboard users get spatial consistency.
      let screenDelta: number;
      if (e.key === 'ArrowRight') screenDelta = KEY_STEP;
      else if (e.key === 'ArrowLeft') screenDelta = -KEY_STEP;
      else if (e.key === 'Home') {
        commit(cfg.defaultWidth);
        e.preventDefault();
        return;
      } else {
        return;
      }
      commit(widthRef.current + (grow === 'right' ? screenDelta : -screenDelta));
      e.preventDefault();
    },
    [cfg, commit, grow],
  );

  const onDoubleClick = useCallback(() => {
    commit(cfg.defaultWidth);
  }, [cfg, commit]);

  const handleProps: PanelResizeHandleProps = {
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': label,
    'aria-valuenow': width,
    'aria-valuemin': cfg.min,
    'aria-valuemax': cfg.max,
    tabIndex: 0,
    onPointerDown,
    onKeyDown,
    onDoubleClick,
  };

  return { width, handleProps };
}
