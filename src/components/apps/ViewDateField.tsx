import { useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { CalendarDays, X } from 'lucide-react';
import { Calendar } from '@/components/ui/calendar';
import { FIELD_CLASS } from '@/components/ui/field-class';
import { dayKey, formatDay, parseDay } from '@/lib/app-view-form';
import { cn } from '@/lib/utils';

interface ViewDateFieldProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  clearable: boolean;
  invalid: boolean;
  describedBy?: string;
}

// A form's date field: shaped like every other field (FIELD_CLASS), it opens
// ex's calendar under it. Picking a day closes it; an optional field can be
// cleared.
export function ViewDateField({ id, value, onChange, placeholder, clearable, invalid, describedBy }: ViewDateFieldProps) {
  const [open, setOpen] = useState(false);
  const selected = parseDay(value);
  return (
    <div className="relative">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          id={id}
          className={cn(FIELD_CLASS, 'flex cursor-pointer items-center gap-2 text-left', clearable && value && 'pr-9', !value && 'text-muted-foreground')}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          data-testid={`${id}-trigger`}
        >
          <CalendarDays className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{value ? formatDay(value) : (placeholder ?? 'Pick a date')}</span>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="start" sideOffset={6} className="isolate z-50">
            <Popover.Popup
              className="origin-(--transform-origin) rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none transition-[opacity,transform] duration-150 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0"
              data-testid={`${id}-calendar`}
            >
              <Calendar
                mode="single"
                selected={selected}
                defaultMonth={selected}
                onSelect={(day) => {
                  if (day) onChange(dayKey(day));
                  setOpen(false);
                }}
              />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {clearable && value && (
        <button
          type="button"
          className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground mobile:size-9"
          aria-label="Clear date"
          onClick={() => onChange('')}
          data-testid={`${id}-clear`}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}
