import { ReminderDialog } from '@/components/chat/ReminderDialog';
import { useCreateReminder } from '@/hooks/useActivity';
import type { ActivityReminder } from '@/lib/activity-reminder';

interface ActivityReminderDialogProps {
  reminder: ActivityReminder | null;
  // The channel's slug, for the reminder's deep link; absent for a DM.
  channelSlug?: string;
  onClose: () => void;
}

// ActivityReminderDialog schedules a reminder on the message an Activity row
// points at, with the same dialog the message menu uses. Hosted by the
// Activity list and the bell's hover card, outside the row, so a dialog
// outlives the menu (and the card) that opened it.
export function ActivityReminderDialog({ reminder, channelSlug, onClose }: ActivityReminderDialogProps) {
  const createReminder = useCreateReminder();
  if (!reminder) return null;
  const { lead } = reminder.row;
  const confirm = (when: Date) =>
    createReminder
      .mutateAsync({
        messageID: lead.messageID,
        parentID: lead.parentID,
        parentType: lead.parentType === 'conversation' ? 'conversation' : 'channel',
        channelSlug,
        remindAt: when.toISOString(),
      })
      .then(() => undefined);
  return (
    <ReminderDialog
      key={reminder.row.key}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      initialValue={reminder.seed}
      onConfirm={confirm}
    />
  );
}
