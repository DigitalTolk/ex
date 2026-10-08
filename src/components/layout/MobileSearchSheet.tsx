import { useCallback, useEffect, useRef, useState, type TouchEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft } from 'lucide-react';
import { SearchBar } from '@/components/SearchBar';
import { KEYBOARD_SETTLE_MS, useKeyboardInset } from '@/hooks/useKeyboardInset';

interface MobileSearchSheetProps {
  onClose: () => void;
}

// How far a finger has to travel before the sheet reacts.
const SWIPE_PX = 40;
// Open / close slide.
const OPEN_MS = 340;
const CLOSE_MS = 240;

// MobileSearchSheet opens from the tab bar's Search tab. It starts as a
// bottom sheet with the field and recent searches, and you search right
// there. Scrolling the results (or swiping up) grows it to the whole screen
// with a back button. Swiping down on the half sheet, or tapping outside it,
// closes it.
export function MobileSearchSheet({ onClose }: MobileSearchSheetProps) {
  const [expanded, setExpanded] = useState(false);
  // The sheet ends at the top of the on-screen keyboard (see
  // useKeyboardInset), so iOS can't push it past the top of the screen. With
  // the keyboard up there's less room, so the half sheet takes more of it.
  const keyboardInset = useKeyboardInset();
  const keyboardUp = keyboardInset > 0;
  const touchStart = useRef<number | null>(null);

  // Slide in after the first paint, and slide out before unmounting, so both
  // opening and closing glide (a plain unmount just vanished).
  const [shown, setShown] = useState(false);
  const closing = useRef(false);
  useEffect(() => {
    // Two frames: the off-screen start has to be painted before it can slide.
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setShown(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, []);
  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    // Drop the keyboard too, so it and the sheet go down together.
    (document.activeElement as HTMLElement).blur();
    setShown(false);
    window.setTimeout(onClose, CLOSE_MS);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const onTouchStart = (e: TouchEvent) => {
    touchStart.current = e.touches[0].clientY;
  };
  const onTouchMove = (e: TouchEvent) => {
    if (touchStart.current === null) return;
    const dy = e.touches[0].clientY - touchStart.current;
    if (dy < -SWIPE_PX && !expanded) {
      setExpanded(true);
      touchStart.current = null;
    } else if (dy > SWIPE_PX * 2 && !expanded) {
      touchStart.current = null;
      close();
    }
  };

  return createPortal(
    <div
      className="fixed inset-x-0 top-0 z-50"
      style={{ bottom: keyboardInset, transition: `bottom ${KEYBOARD_SETTLE_MS}ms cubic-bezier(0.25, 0.1, 0.25, 1)` }}
      data-testid="mobile-search-sheet"
    >
      <div
        className={`absolute inset-0 bg-black/40 transition-opacity ease-out motion-reduce:transition-none ${shown ? 'opacity-100' : 'opacity-0'}`}
        style={{ transitionDuration: `${shown ? OPEN_MS : CLOSE_MS}ms` }}
        onClick={close}
        aria-hidden="true"
        data-testid="mobile-search-backdrop"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className={`absolute inset-x-0 bottom-0 flex flex-col overflow-hidden bg-background text-foreground shadow-2xl motion-reduce:transition-none ${
          expanded ? 'h-full rounded-none pt-[env(safe-area-inset-top)]' : `${keyboardUp ? 'h-[85%]' : 'h-[62%]'} rounded-t-2xl`
        }`}
        style={{
          // Explicit transform (Tailwind's translate-* sets `translate`,
          // which the old transition list didn't cover, so it never slid).
          transform: shown ? 'translateY(0)' : 'translateY(100%)',
          transitionProperty: 'transform, height, border-radius',
          // iOS sheet feel: a soft deceleration in, a quicker ease out.
          transitionDuration: shown ? `${OPEN_MS}ms` : `${CLOSE_MS}ms`,
          transitionTimingFunction: shown ? 'cubic-bezier(0.32, 0.72, 0, 1)' : 'cubic-bezier(0.4, 0, 1, 1)',
        }}
        data-expanded={expanded ? 'true' : 'false'}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={() => {
          touchStart.current = null;
        }}
      >
        {!expanded && (
          <div className="flex shrink-0 justify-center pt-2 pb-1" aria-hidden="true">
            <span className="h-1 w-10 rounded-full bg-muted-foreground/30" />
          </div>
        )}
        <div
          className="min-h-0 flex-1 overflow-y-auto px-3 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]"
          onScroll={(e) => {
            if (e.currentTarget.scrollTop > 0) setExpanded(true);
          }}
        >
          <SearchBar
            variant="sheet"
            onDone={close}
            leading={
              expanded ? (
                <button
                  type="button"
                  onClick={close}
                  aria-label="Back"
                  className="-ml-1 inline-flex h-11 w-9 shrink-0 items-center justify-center text-foreground"
                  data-testid="mobile-search-back"
                >
                  <ChevronLeft className="h-6 w-6" />
                </button>
              ) : null
            }
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
