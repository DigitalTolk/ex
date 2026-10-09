import { useCallback, useEffect, useRef, useState } from 'react';
import { Drawer } from '@base-ui/react/drawer';
import { ChevronLeft } from 'lucide-react';
import { SearchBar } from '@/components/SearchBar';
import { KEYBOARD_SETTLE_MS, useKeyboardInset } from '@/hooks/useKeyboardInset';
import { useMobileBackClose } from '@/hooks/useMobileBackClose';
import { blurActiveInput } from '@/lib/blur-input';

interface MobileSearchSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// How far a finger has to travel up before the half sheet grows.
const SWIPE_UP_PX = 40;

// MobileSearchSheet opens from the tab bar's Search tab: a bottom sheet with
// the field and recent searches, where you search right there. Scrolling the
// results (or swiping up) grows it to the whole screen with a back button.
// Swiping the half sheet down, tapping outside it, Escape and the system Back
// close it. A Base UI Drawer: it owns focus (into the sheet, back to the tab
// on close), the scroll lock behind it, and the swipe-to-dismiss.
export function MobileSearchSheet({ open, onOpenChange }: MobileSearchSheetProps) {
  const [expanded, setExpanded] = useState(false);
  // The sheet ends at the top of the on-screen keyboard (see
  // useKeyboardInset), so iOS can't push it past the top of the screen. With
  // the keyboard up there's less room, so the half sheet takes more of it.
  const keyboardInset = useKeyboardInset();
  const popupRef = useRef<HTMLDivElement>(null);

  // Drop the keyboard too, so it and the sheet go down together.
  const close = useCallback(() => {
    blurActiveInput();
    onOpenChange(false);
  }, [onOpenChange]);
  useMobileBackClose(open, close);

  // Swiping up on the half sheet grows it. The Drawer claims vertical touch
  // moves over the sheet (a document capture listener) for its own
  // swipe-to-dismiss before React's handlers would see them, so this listens
  // on the window, which sees them first.
  useEffect(() => {
    if (!open || expanded) return;
    let startY: number | null = null;
    const onStart = (e: TouchEvent) => {
      startY = popupRef.current?.contains(e.target as Node) ? e.touches[0].clientY : null;
    };
    const onMove = (e: TouchEvent) => {
      if (startY !== null && e.touches[0].clientY - startY < -SWIPE_UP_PX) {
        startY = null;
        setExpanded(true);
      }
    };
    const options = { capture: true, passive: true } as const;
    window.addEventListener('touchstart', onStart, options);
    window.addEventListener('touchmove', onMove, options);
    return () => {
      window.removeEventListener('touchstart', onStart, options);
      window.removeEventListener('touchmove', onMove, options);
    };
  }, [open, expanded]);

  return (
    <Drawer.Root
      open={open}
      // The sheet opens from the tab bar (no Drawer trigger), so the Drawer
      // only ever asks to close it.
      onOpenChange={close}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) setExpanded(false);
      }}
      swipeDirection="down"
    >
      <Drawer.Portal>
        <Drawer.Backdrop
          className="fixed inset-0 z-50 bg-black/40 opacity-[calc(1-var(--drawer-swipe-progress,0))] transition-opacity duration-300 ease-out data-starting-style:opacity-0 data-ending-style:opacity-0 data-swiping:duration-0 motion-reduce:transition-none"
          data-testid="mobile-search-backdrop"
        />
        <Drawer.Viewport
          className="fixed inset-x-0 top-0 z-50 flex items-end"
          style={{ bottom: keyboardInset, transition: `bottom ${KEYBOARD_SETTLE_MS}ms cubic-bezier(0.25, 0.1, 0.25, 1)` }}
          data-testid="mobile-search-sheet"
        >
          <Drawer.Popup
            ref={popupRef}
            // Focus moves into the sheet without raising the keyboard; the
            // field is one tap away.
            initialFocus={popupRef}
            className={`flex w-full flex-col overflow-hidden bg-background text-foreground shadow-2xl outline-none [transform:translateY(var(--drawer-swipe-movement-y,0px))] transition-[transform,height,border-radius] duration-[340ms] ease-[cubic-bezier(0.32,0.72,0,1)] data-starting-style:[transform:translateY(100%)] data-ending-style:[transform:translateY(100%)] data-ending-style:duration-[240ms] data-swiping:duration-0 motion-reduce:transition-none ${
              expanded ? 'h-full rounded-none pt-[env(safe-area-inset-top)]' : `${keyboardInset > 0 ? 'h-[85%]' : 'h-[62%]'} rounded-t-2xl`
            }`}
            data-expanded={expanded ? 'true' : 'false'}
            data-testid="mobile-search-panel"
          >
            <Drawer.Title className="sr-only">Search</Drawer.Title>
            {!expanded && (
              <div className="flex shrink-0 justify-center pt-2 pb-1" aria-hidden="true">
                <span className="h-1 w-10 rounded-full bg-muted-foreground/30" />
              </div>
            )}
            <Drawer.Content
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]"
              // Full screen, a downward swipe scrolls the results; only the
              // half sheet swipes away.
              data-base-ui-swipe-ignore={expanded || undefined}
              onScroll={(e) => {
                if (e.currentTarget.scrollTop > 0) setExpanded(true);
              }}
              data-testid="mobile-search-scroll"
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
                      className="-ml-1 inline-flex h-11 w-11 shrink-0 items-center justify-center text-foreground"
                      data-testid="mobile-search-back"
                    >
                      <ChevronLeft className="h-6 w-6" />
                    </button>
                  ) : null
                }
              />
            </Drawer.Content>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
