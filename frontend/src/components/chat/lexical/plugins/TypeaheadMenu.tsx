import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { MenuOption } from '@lexical/react/LexicalTypeaheadMenuPlugin';

// Shared popup chrome for the @ / ~ / : typeaheads. Lexical drives
// keyboard navigation (arrow keys, Enter, Tab, Esc) — this component
// renders the list and forwards mousedown back through the plugin.
// Portals into Lexical's `anchorElementRef.current` so the popup
// tracks the caret without us computing coordinates ourselves.
// Always opens above the trigger: the composer sits at the viewport
// bottom, so downward placement clips out of view.

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

  useEffect(() => {
    if (selectedIndex == null) return;
    const list = containerRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-typeahead-row="${selectedIndex}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

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

  return createPortal(
    <div
      ref={containerRef}
      role="listbox"
      data-testid={testId}
      className="absolute left-0 bottom-full mb-2 z-50 max-h-72 w-72 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
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
