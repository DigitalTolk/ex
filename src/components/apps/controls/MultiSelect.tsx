import { useMemo, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FIELD_CLASS } from '@/components/ui/field-class';
import { cn } from '@/lib/utils';
import type { SelectOption } from '@/types';

// Lists longer than this get a search box.
const SEARCH_FROM = 8;

interface MultiSelectProps {
  id: string;
  label: string;
  options: SelectOption[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  max?: number;
  // In a message the choice is sent once, when the person applies it; in a
  // form every toggle simply updates the field.
  applyLabel?: string;
  size?: 'default' | 'sm';
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
}

// MultiSelect picks several options: chips for what is chosen, and a
// searchable checklist under the field. A max_selected_items cap disables
// the rest once reached, and says so.
export function MultiSelect({ id, label, options, value, onChange, placeholder, max, applyLabel, size = 'default', disabled, invalid, describedBy }: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<string[]>(value);
  const chosen = applyLabel ? draft : value;
  const set = applyLabel ? setDraft : onChange;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.text.text.toLowerCase().includes(q)) : options;
  }, [options, query]);
  const full = !!max && chosen.length >= max;
  const textOf = (v: string) => options.find((o) => o.value === v)?.text.text ?? v;

  // At the cap the unchosen options are disabled, so a toggle only ever adds below it.
  const toggle = (v: string) => set(chosen.includes(v) ? chosen.filter((x) => x !== v) : [...chosen, v]);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setDraft(value);
        else setQuery('');
      }}
    >
      <Popover.Trigger
        id={id}
        disabled={disabled}
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        data-testid={id}
        className={cn(
          FIELD_CLASS,
          'flex h-auto min-h-8 cursor-pointer flex-wrap items-center gap-1 py-1 pr-8 text-left mobile:min-h-11',
          size === 'sm' && 'min-h-7 w-auto max-w-full mobile:min-h-9',
          'relative',
        )}
      >
        {value.length === 0 ? (
          <span className="text-muted-foreground">{placeholder ?? 'Choose…'}</span>
        ) : (
          value.map((v) => (
            <span key={v} className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs">
              <span className="truncate">{textOf(v)}</span>
            </span>
          ))
        )}
        <ChevronDown className="absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} className="isolate z-50">
          <Popover.Popup
            className="flex max-h-80 w-(--anchor-width) min-w-56 origin-(--transform-origin) flex-col rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none transition-[opacity,transform] duration-150 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0"
            data-testid={`${id}-list`}
          >
            {options.length > SEARCH_FROM && (
              <div className="relative m-1">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search"
                  aria-label={`Search ${label}`}
                  className={cn(FIELD_CLASS, 'pl-8')}
                  data-testid={`${id}-search`}
                />
              </div>
            )}
            <div role="listbox" aria-multiselectable aria-label={label} className="min-h-0 flex-1 overflow-y-auto py-1">
              {shown.map((o) => {
                const on = chosen.includes(o.value);
                return (
                  <button
                    key={o.value}
                    type="button"
                    role="option"
                    aria-selected={on}
                    disabled={!on && full}
                    onClick={() => toggle(o.value)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50 mobile:min-h-11"
                  >
                    <span className={cn('flex size-4 shrink-0 items-center justify-center rounded border border-border-strong', on && 'border-primary bg-primary text-primary-foreground')}>
                      {on && <Check className="size-3" aria-hidden />}
                    </span>
                    <span className="truncate">{o.text.text}</span>
                  </button>
                );
              })}
              {shown.length === 0 && <p className="px-2 py-1.5 text-sm text-muted-foreground">No matches</p>}
            </div>
            {(full || chosen.length > 0 || applyLabel) && (
              <div className="flex items-center justify-between gap-2 border-t px-2 pt-1.5 pb-1">
                <span className="text-xs text-muted-foreground">{full ? `Up to ${max}` : `${chosen.length} chosen`}</span>
                <div className="flex gap-1">
                  {chosen.length > 0 && (
                    <Button type="button" size="xs" variant="ghost" onClick={() => set([])}>
                      <X aria-hidden />
                      Clear
                    </Button>
                  )}
                  {applyLabel && (
                    <Button
                      type="button"
                      size="xs"
                      onClick={() => {
                        setOpen(false);
                        onChange(draft);
                      }}
                      data-testid={`${id}-apply`}
                    >
                      {applyLabel}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
