import { Link } from 'react-router-dom';
import { Clock3, X } from 'lucide-react';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { useCancelReminder } from '@/hooks/useActivity';
import { formatLongDateTime } from '@/lib/format';
import type { Reminder } from '@/types';

interface PendingRemindersProps {
  reminders: Reminder[];
  hrefFor: (reminder: Reminder) => string;
  onNavigate?: () => void;
}

// PendingReminders lists the reminders that haven't fired yet, each a link to
// its message with a cancel button.
export function PendingReminders({ reminders, hrefFor, onNavigate }: PendingRemindersProps) {
  const cancelReminder = useCancelReminder();
  return (
    <section data-testid="pending-reminders" className="pb-1">
      <h3 className="px-2 pt-2 pb-1 text-xs font-semibold text-muted-foreground">Scheduled reminders</h3>
      {reminders.map((r) => (
        <div key={r.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-sidebar-accent/60" data-testid="pending-reminder">
          <Clock3 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Link to={hrefFor(r)} onClick={onNavigate} className="min-w-0 flex-1 truncate text-sm mobile:py-2.5">
            {r.messagePreview || 'A message'}
          </Link>
          <span className="shrink-0 text-xs text-muted-foreground">{formatLongDateTime(r.remindAt)}</span>
          <TooltipIconButton
            label="Cancel reminder"
            onClick={() => cancelReminder.mutate(r.id)}
            className="mobile:size-11"
            testId="cancel-reminder"
          >
            <X className="h-3.5 w-3.5" />
          </TooltipIconButton>
        </div>
      ))}
    </section>
  );
}
