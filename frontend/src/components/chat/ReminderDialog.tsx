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

interface ReminderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // initialValue is a `YYYY-MM-DDTHH:mm` seed (computed by the opener so the
  // impure clock read happens in an event handler, never during render).
  initialValue: string;
  // onConfirm receives the chosen absolute time. The caller schedules it.
  onConfirm: (when: Date) => void;
}

// ReminderDialog is the "Custom…" reminder picker: a datetime-local input
// seeded by the opener, validated to a strictly-future instant before the
// caller schedules it. Mount it fresh per open so the seed re-applies.
export function ReminderDialog({ open, onOpenChange, initialValue, onConfirm }: ReminderDialogProps) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState('');

  const confirm = () => {
    const when = new Date(value);
    if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
      setError('Pick a time in the future.');
      return;
    }
    onConfirm(when);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" data-testid="reminder-dialog" mobileCloseLabel="Cancel">
        <DialogHeader>
          <DialogTitle>Remind me</DialogTitle>
          <DialogDescription>Choose when to be reminded about this message.</DialogDescription>
        </DialogHeader>
        <div className="px-1 py-2">
          <input
            type="datetime-local"
            aria-label="Reminder time"
            data-testid="reminder-datetime"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
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
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} data-testid="reminder-cancel">
            Cancel
          </Button>
          <Button onClick={confirm} data-testid="reminder-confirm">
            Set reminder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
