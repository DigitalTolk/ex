import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { MenuOption } from '@lexical/react/LexicalTypeaheadMenuPlugin';
import { pickPlacement, type Placement } from './typeaheadPlacement';

// Shared popup chrome for the @ / ~ / : typeaheads. Lexical drives
// keyboard navigation (arrow keys, Enter, Tab, Esc) — this component
// renders the list and forwards mousedown back through the plugin.
//
// Portals into Lexical's `anchorElementRef.current` (a div Lexical
// positions just under the trigger character and re-positions on
// scroll/resize). Rendering into Lexical's anchor — the same path
// Lexical's default menu takes — means the popup tracks the caret
// automatically and avoids a double-counted anchor-height bug we hit
// when computing our own coordinates.

interface TypeaheadMenuProps<T extends MenuOption> {
  testId: string;
  emptyLabel?: string;
  options: T[];
  selectedIndex: number | null;
  setHighlightedIndex: (i: number) => void;
  selectOptionAndCleanUp: (option: T) => void;
  anchorElementRef: RefObject<HTMLElement | null>;
  renderRow: (option: T, isActive: boolean) => ReactNode;
}

export function TypeaheadMenu<T extends MenuOption>({
  testId,
  emptyLabel,
  options,
  selectedIndex,
  setHighlightedIndex,
  selectOptionAndCleanUp,
  anchorElementRef,
  renderRow,
}: TypeaheadMenuProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<Placement>('below');

  useEffect(() => {
    if (selectedIndex == null) return;
    const list = containerRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-typeahead-row="${selectedIndex}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // Flip the menu above the anchor when its bottom edge would clip
  // the viewport. Lexical's own positioner only flips when there's
  // room above the EDITOR root — useless for a chat input pinned to
  // the bottom of the screen. Re-runs whenever the option count or
  // selected row changes (both can shift the menu's measured height).
  useLayoutEffect(() => {
    const menu = containerRef.current;
    if (!menu) return;
    const anchor = menu.parentElement;
    if (!anchor) return;
    const next = pickPlacement(
      anchor.getBoundingClientRect(),
      menu.getBoundingClientRect(),
      window.innerHeight,
    );
    setPlacement((prev) => (prev === next ? prev : next));
  }, [options.length, selectedIndex]);

  // Lexical owns the anchor element's lifecycle. `menuRenderFn` is
  // only called after Lexical has populated `anchorElementRef.current`
  // and our component is freshly mounted per popup cycle, so reading
  // the ref during render is safe and necessary — caching the value
  // would freeze the portal target across menu close/reopen cycles
  // when Lexical recreates the anchor div.
  // eslint-disable-next-line react-hooks/refs
  const anchorEl = anchorElementRef.current;
  // eslint-disable-next-line react-hooks/refs
  if (!anchorEl) return null;
  if (options.length === 0 && !emptyLabel) return null;

  // For "above" placement we need the menu's top edge to sit at
  // (anchorTop - menuHeight - lineHeight - margin). The anchor div is
  // sized to one line height, so `bottom: 100% + lineHeight` works:
  // 100% lifts the menu fully above the anchor, plus a small offset
  // so the menu doesn't visually crowd the trigger character.
  const positionClass =
    placement === 'above' ? 'absolute left-0 bottom-full mb-2' : 'absolute left-0 top-full mt-1';

  return createPortal(
    <div
      ref={containerRef}
      role="listbox"
      data-testid={testId}
      className={`${positionClass} z-50 max-h-72 w-72 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md`}
    >
      {options.length === 0 ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">{emptyLabel}</div>
      ) : (
        options.map((option, i) => {
          const isActive = i === selectedIndex;
          return (
            <div
              key={option.key}
              role="option"
              aria-selected={isActive}
              data-typeahead-row={i}
              ref={option.setRefElement}
              onMouseDown={(e) => {
                e.preventDefault();
                selectOptionAndCleanUp(option);
              }}
              onMouseEnter={() => setHighlightedIndex(i)}
              className={
                'cursor-pointer rounded-sm px-2 py-1.5 text-sm ' +
                (isActive ? 'bg-accent text-accent-foreground' : '')
              }
            >
              {renderRow(option, isActive)}
            </div>
          );
        })
      )}
    </div>,
    anchorEl,
  );
}
