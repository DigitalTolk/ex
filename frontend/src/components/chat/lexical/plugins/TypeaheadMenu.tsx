import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { MenuOption } from '@lexical/react/LexicalTypeaheadMenuPlugin';

// Shared popup chrome for the @ / ~ / : typeaheads. Lexical drives
// keyboard navigation (arrow keys, Enter, Tab, Esc) — this component
// renders the list and forwards mousedown back through the plugin.
// Portals to document.body and uses Lexical's anchor rect only for
// measurement. Keeping the fixed popup out of composer/anchor
// containers avoids mobile WebKit treating it as fixed relative to a
// transformed ancestor.
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
  // Optional section grouping. When provided, a non-selectable section
  // header is rendered before the first option whose header differs
  // from the previous option's. Options stay in one flat array so
  // Lexical's index-based keyboard navigation is unaffected.
  headerFor?: (option: T) => string | undefined;
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
  headerFor,
}: TypeaheadMenuProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<CSSProperties | null>(null);

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
  useTypeaheadPosition(anchorEl, setPosition);
  // eslint-disable-next-line react-hooks/refs
  if (!anchorEl) return null;

  if (options.length === 0 && !emptyLabel) return null;

  return createPortal(
    <div
      ref={containerRef}
      role="listbox"
      data-testid={testId}
      style={position ?? { visibility: 'hidden' }}
      className="z-50 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {options.length === 0 ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">{emptyLabel}</div>
      ) : (
        options.map((option, i) => {
          const isActive = i === selectedIndex;
          const header = headerFor?.(option);
          const prevHeader = i > 0 ? headerFor?.(options[i - 1]) : undefined;
          const showHeader = !!header && header !== prevHeader;
          return (
            <Fragment key={option.key}>
              {showHeader && (
                <div
                  role="presentation"
                  data-testid="typeahead-section-header"
                  className="px-2 pt-1.5 pb-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground select-none"
                >
                  {header}
                </div>
              )}
              <div
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
            </Fragment>
          );
        })
      )}
    </div>,
    document.body,
  );
}

function useTypeaheadPosition(anchorEl: HTMLElement | null, setPosition: (position: CSSProperties) => void) {
  useLayoutEffect(() => {
    if (!anchorEl) return;
    const target = anchorEl;
    function update() {
      const anchorRect = target.getBoundingClientRect();
      const composer = target.closest('[data-message-composer]');
      /* istanbul ignore next -- when the typeahead is open the focused element is always the contenteditable (an HTMLElement); the `: null` arm guards against a null/SVG activeElement that the open menu never produces. */
      const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const activeEditor =
        activeElement?.getAttribute('role') === 'textbox'
          ? activeElement
          : activeElement?.closest<HTMLElement>('[role="textbox"]');
      const editor =
        composer?.querySelector<HTMLElement>('[role="textbox"]') ??
        activeEditor ??
        document.querySelector<HTMLElement>('[data-message-composer] [role="textbox"]');
      const referenceTop = editor?.getBoundingClientRect().top ?? anchorRect.top;
      const visualViewport = window.visualViewport;
      const viewportTop = visualViewport?.offsetTop ?? 0;
      const viewportBottom = viewportTop + (visualViewport?.height ?? window.innerHeight);
      const visibleReferenceTop = Math.min(referenceTop, viewportBottom);
      const width = Math.min(288, window.innerWidth - 16);
      const left = Math.min(Math.max(anchorRect.left, 8), window.innerWidth - width - 8);
      const viewportOffsetBottom = Math.max(0, window.innerHeight - viewportBottom);
      const bottom = Math.max(8 + viewportOffsetBottom, window.innerHeight - visibleReferenceTop + 8);
      const availableAboveEditor = Math.max(32, visibleReferenceTop - viewportTop - 16);
      const maxHeight = Math.min(288, availableAboveEditor);

      setPosition({
        position: 'fixed',
        left,
        bottom,
        width,
        maxHeight,
      });
    }

    update();
    const frame = requestAnimationFrame(update);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, [anchorEl, setPosition]);
}
