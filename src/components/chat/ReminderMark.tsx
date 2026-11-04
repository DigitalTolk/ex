import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlarmClock } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { formatScheduleTime } from '@/lib/schedule-times';
import type { Reminder } from '@/types';

const NO_IDS: string[] = [];

// ReminderMark is the ⏰ on a message you have a reminder on. Hovering says
// when it's due and who else it tags; a click (or a tap, on a phone) opens
// the Reminders tab, where it can be changed or cancelled.
export function ReminderMark({ reminder }: { reminder: Reminder }) {
  const navigate = useNavigate();
  const people = reminder.userIDs ?? NO_IDS;
  const { data: users } = useUsersBatch(people);
  // Read once per mount for the relative label ("Tomorrow at 9:00 AM").
  const [now] = useState(() => new Date());
  const when = formatScheduleTime(new Date(reminder.remindAt), now);
  const names = people.map((id) => users?.find((u) => u.id === id)?.displayName ?? 'Someone');

  return (
    <Tooltip>
      <TooltipTrigger
        render={<button type="button" />}
        onClick={() => navigate('/drafts?tab=reminders')}
        aria-label={`Reminder, ${when}`}
        data-testid="message-reminder-mark"
        className="inline-flex shrink-0 items-center rounded text-muted-foreground hover:text-foreground"
      >
        <AlarmClock className="h-3.5 w-3.5" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent>
        <span className="flex flex-col">
          <span>Reminder · {when}</span>
          {names.length > 0 && <span>With {names.join(', ')}</span>}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
