import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

export interface NotificationOption {
  value: string;
  label: string;
}

interface NotificationOptionGroupProps {
  label: string;
  value: string;
  options: NotificationOption[];
  onChange: (value: string) => void;
  // Always-present helper line under the control (e.g. the inherited default).
  hint: string;
}

// NotificationOptionGroup is a small segmented button row shared by the
// account and per-channel notification dialogs. It mirrors the theme-selector
// pattern (a row of Buttons, the active one in the `default` variant) so the
// look stays consistent and design tokens are honoured.
export function NotificationOptionGroup({
  label,
  value,
  options,
  onChange,
  hint,
}: NotificationOptionGroupProps) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <Button
            key={o.value}
            type="button"
            size="sm"
            role="radio"
            aria-checked={value === o.value}
            variant={value === o.value ? 'default' : 'outline'}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
