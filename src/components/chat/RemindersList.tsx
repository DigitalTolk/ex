import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlarmClock, Pencil, StickyNote, Trash2, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { LazyReminderDialog as ReminderDialog } from '@/components/chat/LazyReminderDialog';
import type { DateTimeDialogCopy } from '@/components/chat/ReminderDialog';
import { useUserChannels } from '@/hooks/useChannels';
import { useUserConversations } from '@/hooks/useConversations';
import { useCancelReminder, useReminders, useUpdateReminder } from '@/hooks/useActivity';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { toPlainTextPreview } from '@/lib/message-preview';
import { toLocalInputValue } from '@/lib/reminder-times';
import { formatScheduleTime } from '@/lib/schedule-times';
import type { Reminder } from '@/types';

const EDIT_COPY: DateTimeDialogCopy = {
  title: 'Edit reminder',
  inputLabel: 'Reminder time',
  confirm: 'Save',
  confirming: 'Saving…',
  failed: "Couldn't save the reminder — please try again.",
  previewVerb: 'Reminds you',
};

// RemindersList is the Drafts page's "Reminders" tab: every reminder you have
// set, soonest first — the message it's about, your note, when, and who else
// it tags — to edit (time, people and note) or cancel. When one comes due the reminder bot
// DMs you, or, with people added, replies to the message tagging you all.
export function RemindersList() {
  const { data: reminders, isLoading } = useReminders();
  const { data: channels } = useUserChannels();
  const { data: conversations } = useUserConversations();
  const update = useUpdateReminder();
  const cancel = useCancelReminder();
  const [editing, setEditing] = useState<Reminder | null>(null);
  const [cancelling, setCancelling] = useState<Reminder | null>(null);
  // Read once per render pass for the relative labels ("Tomorrow at 9:00 AM").
  const [now] = useState(() => new Date());

  const peopleIDs = useMemo(() => (reminders ?? []).flatMap((r) => [...(r.userIDs ?? []), ...(r.excludedUserIDs ?? [])]), [reminders]);
  const { data: people } = useUsersBatch(peopleIDs);
  const nameOf = (id: string) => people?.find((u) => u.id === id)?.displayName ?? 'Someone';

  const where = (r: Reminder) =>
    r.parentType === 'channel'
      ? `~${channels?.find((c) => c.channelID === r.parentID)?.channelName ?? r.channelSlug ?? 'channel'}`
      : (conversations?.find((c) => c.conversationID === r.parentID)?.displayName ?? 'Conversation');

  if (isLoading) {
    return (
      <div className="space-y-3" data-testid="reminders-loading">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }
  if (!reminders?.length) {
    return (
      <p className="py-12 text-center text-muted-foreground" data-testid="reminders-empty">
        No reminders. Use &ldquo;Remind me&rdquo; on a message to set one.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {reminders.map((r) => (
        <article key={r.id} className="flex items-start gap-3 rounded-lg border bg-card p-3" data-testid="reminder-row">
          <Link to={messageHref(r)} className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <span className="truncate">{where(r)}</span>
              {r.parentMessageID && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">thread</span>
              )}
            </div>
            <p className="mt-1 truncate text-sm text-muted-foreground">{toPlainTextPreview(r.messagePreview ?? '') || 'A message'}</p>
            {r.note && (
              <p className="mt-1 flex items-start gap-1 text-sm text-foreground" data-testid="reminder-row-note">
                <StickyNote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="line-clamp-2 whitespace-pre-line break-words">{r.note}</span>
              </p>
            )}
            <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <AlarmClock className="h-3.5 w-3.5" aria-hidden />
                {formatScheduleTime(new Date(r.remindAt), now)}
              </span>
              {(r.everyone || (r.userIDs?.length ?? 0) > 0) && (
                <span className="flex items-center gap-1" data-testid="reminder-row-people">
                  <Users className="h-3.5 w-3.5" aria-hidden />
                  {r.everyone
                    ? `Everyone${(r.excludedUserIDs?.length ?? 0) > 0 ? ` except ${r.excludedUserIDs!.map(nameOf).join(', ')}` : ''}`
                    : `With ${r.userIDs!.map(nameOf).join(', ')}`}
                </span>
              )}
            </p>
          </Link>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button variant="ghost" size="icon" className="h-8 w-8 mobile:h-9 mobile:w-9" aria-label="Edit reminder" onClick={() => setEditing(r)}>
              <Pencil className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8 mobile:h-9 mobile:w-9" aria-label="Cancel reminder" onClick={() => setCancelling(r)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </article>
      ))}
      {editing && (
        <ReminderDialog
          open
          onOpenChange={() => setEditing(null)}
          initialValue={toLocalInputValue(new Date(editing.remindAt))}
          copy={EDIT_COPY}
          people={{
            parentID: editing.parentID,
            parentType: editing.parentType,
            initial: { everyone: !!editing.everyone, userIDs: editing.userIDs ?? [], excludedUserIDs: editing.excludedUserIDs ?? [] },
          }}
          note={editing.note ?? ''}
          onConfirm={(when, audience, note) =>
            update
              .mutateAsync({ id: editing.id, remindAt: when.toISOString(), ...audience, note })
              .then(() => undefined)
          }
        />
      )}
      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={() => setCancelling(null)}
        title="Cancel reminder?"
        description="It won't remind anyone."
        confirmLabel="Cancel reminder"
        destructive
        testIDPrefix="cancel-reminder-dialog"
        onConfirm={() => {
          cancel.mutate(cancelling!.id);
        }}
      />
    </div>
  );
}

// messageHref opens the reminded message (inside its thread for a reply).
function messageHref(r: Reminder): string {
  const base = r.parentType === 'channel' ? `/channel/${r.channelSlug || r.parentID}` : `/conversation/${r.parentID}`;
  return `${base}${r.parentMessageID ? `?thread=${r.parentMessageID}` : ''}#msg-${r.messageID}`;
}
