import { useState } from 'react';
import { Clock } from 'lucide-react';
import { FIELD_CLASS } from '@/components/ui/field-class';
import { cn } from '@/lib/utils';

interface TimeFieldProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  // A message row sends a time once it is complete, not per keystroke.
  commitOnBlur?: boolean;
  size?: 'default' | 'sm';
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  label?: string;
}

// TimeField is a time of day (HH:MM): the platform's own time input — a
// wheel on phones, a typed field on desktops — dressed as an ex field.
export function TimeField({ id, value, onChange, commitOnBlur, size = 'default', disabled, invalid, describedBy, label }: TimeFieldProps) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
  }
  const commit = () => {
    if (draft !== value) onChange(draft);
  };
  return (
    <div className="relative">
      <Clock className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground mobile:left-4" aria-hidden />
      <input
        id={id}
        type="time"
        value={commitOnBlur ? draft : value}
        onChange={(e) => (commitOnBlur ? setDraft(e.target.value) : onChange(e.target.value))}
        onBlur={commitOnBlur ? commit : undefined}
        // The whole field opens the platform's time picker, not just its
        // own small icon (hidden: ours is on the left).
        onClick={(e) => {
          try {
            e.currentTarget.showPicker?.();
          } catch {
            // Not allowed here (an older browser, a sandboxed frame): typing still works.
          }
        }}
        onKeyDown={commitOnBlur ? (e) => e.key === 'Enter' && commit() : undefined}
        disabled={disabled}
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        data-testid={id}
        className={cn(FIELD_CLASS, 'pl-8 mobile:pl-11 [&::-webkit-calendar-picker-indicator]:hidden', size === 'sm' && 'h-7 w-36 mobile:h-9')}
      />
    </div>
  );
}
