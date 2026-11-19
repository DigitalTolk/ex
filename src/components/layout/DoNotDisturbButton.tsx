import { memo } from 'react';
import { BellOff, BellRing } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useDoNotDisturb } from '@/hooks/useDoNotDisturb';
import { describeSnoozeEnd, INDEFINITE_SNOOZE_MINUTES, minutesUntilTomorrow } from '@/lib/notification-snooze';

const CHOICES: { label: string; minutes: () => number; testID: string }[] = [
  { label: 'For 30 minutes', minutes: () => 30, testID: 'dnd-30m' },
  { label: 'For 1 hour', minutes: () => 60, testID: 'dnd-1h' },
  { label: 'For 2 hours', minutes: () => 120, testID: 'dnd-2h' },
  { label: 'Until tomorrow morning', minutes: () => minutesUntilTomorrow(), testID: 'dnd-tomorrow' },
  { label: 'Until I turn it back on', minutes: () => INDEFINITE_SNOOZE_MINUTES, testID: 'dnd-indefinite' },
];

// DoNotDisturbButton sits above the account on the rail: one click to pause
// every alert (popups, sounds, phone pushes) for a while, and to bring them
// back. While paused it stays lit, and its menu says until when. Nothing is
// lost meanwhile: Activity and the badges keep counting.
export const DoNotDisturbButton = memo(function DoNotDisturbButton() {
  const { until, snooze } = useDoNotDisturb();
  const paused = until !== null;
  const state = paused ? `Notifications paused ${describeSnoozeEnd(until)}` : 'Pause notifications';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={state}
        title={state}
        data-testid="dnd-trigger"
        data-paused={paused ? 'true' : 'false'}
        className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring ${
          paused
            ? 'bg-brand/15 text-brand hover:bg-brand/25'
            : 'text-muted-foreground hover:bg-sidebar-foreground/10 hover:text-sidebar-foreground data-[popup-open]:bg-sidebar-foreground/10 data-[popup-open]:text-sidebar-foreground'
        }`}
      >
        {paused ? <BellOff className="h-5 w-5" aria-hidden="true" /> : <BellRing className="h-5 w-5" aria-hidden="true" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end" sideOffset={10} className="w-64">
        <div className="px-2 py-1.5">
          <p className="text-sm font-semibold">{paused ? 'Notifications are paused' : 'Pause notifications'}</p>
          <p className="text-xs text-muted-foreground" data-testid="dnd-state">
            {paused ? `Paused ${describeSnoozeEnd(until)}.` : 'No popups, sounds or phone alerts. Nothing is lost: it all waits in Activity.'}
          </p>
        </div>
        {paused && (
          <DropdownMenuItem onClick={() => void snooze(0)} data-testid="dnd-resume">
            <BellRing className="mr-2 h-4 w-4" aria-hidden="true" />
            Resume notifications
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        {CHOICES.map((choice) => (
          <DropdownMenuItem key={choice.testID} onClick={() => void snooze(choice.minutes())} data-testid={choice.testID}>
            {choice.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
