import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/useIsMobile';

interface ReminderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // initialValue is a `YYYY-MM-DDTHH:mm` seed (computed by the opener so the
  // impure clock read happens in an event handler, never during render).
  initialValue: string;
  // onConfirm schedules the reminder for the chosen time. It resolves on success
  // (the dialog then closes) and rejects on failure (the dialog stays open and
  // surfaces the error) — so scheduling is never silent.
  onConfirm: (when: Date) => Promise<void>;
  // copy rewords the dialog for another "pick a future time" use (scheduling
  // a message); reminders use the default.
  copy?: DateTimeDialogCopy;
}

export interface DateTimeDialogCopy {
  title: string;
  description: string;
  inputLabel: string;
  confirm: string;
  confirming: string;
  failed: string;
}

const REMINDER_COPY: DateTimeDialogCopy = {
  title: 'Remind me',
  description: 'Choose when to be reminded about this message.',
  inputLabel: 'Reminder time',
  confirm: 'Set reminder',
  confirming: 'Setting…',
  failed: "Couldn't set the reminder — please try again.",
};

// ReminderDialog is the "Custom…" reminder picker: a datetime-local input
// seeded by the opener, validated to a strictly-future instant before the
// caller schedules it. Mount it fresh per open so the seed re-applies.
export function ReminderDialog({ open, onOpenChange, initialValue, onConfirm, copy = REMINDER_COPY }: ReminderDialogProps) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const isMobile = useIsMobile();

  const confirm = async () => {
    const when = new Date(value);
    if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
      setError('Pick a time in the future.');
      return;
    }
    setPending(true);
    setError('');
    try {
      await onConfirm(when);
      onOpenChange(false);
    } catch {
      setError(copy.failed);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Mobile: the confirm moves to the top-right header — the iOS date
          wheel covers the bottom half of the screen, hiding a footer button. */}
      <DialogContent
        size="md"
        data-testid="reminder-dialog"
        mobileCloseLabel="Cancel"
        mobileAction={
          isMobile
            ? { label: pending ? copy.confirming : copy.confirm, onClick: () => void confirm(), disabled: pending }
            : undefined
        }
      >
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <div className="px-1 py-2">
          <input
            type="datetime-local"
            aria-label={copy.inputLabel}
            data-testid="reminder-datetime"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-base md:text-sm mobile:h-11"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError('');
            }}
          />
          {error && (
            <p className="mt-2 text-xs text-destructive" data-testid="reminder-error">
              {error}
            </p>
          )}
        </div>
        {!isMobile && (
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)} data-testid="reminder-cancel">
              Cancel
            </Button>
            <Button onClick={confirm} disabled={pending} data-testid="reminder-confirm">
              {pending ? copy.confirming : copy.confirm}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
