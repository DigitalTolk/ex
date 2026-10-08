import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, CalendarClock, Paperclip, Pencil, Send, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useUserChannels } from '@/hooks/useChannels';
import { useUserConversations } from '@/hooks/useConversations';
import {
  useDeleteScheduledMessage,
  useScheduledMessages,
  useSendScheduledNow,
  useUpdateScheduledMessage,
} from '@/hooks/useScheduledMessages';
import { slugify } from '@/lib/format';
import { toPlainTextPreview } from '@/lib/message-preview';
import { toLocalInputValue } from '@/lib/reminder-times';
import { formatScheduleTime } from '@/lib/schedule-times';
import { showToast } from '@/lib/toast';
import type { ScheduledMessage } from '@/types';

// ScheduledMessagesList is the Drafts page's "Scheduled" tab: every message
// set to send later — where it goes, when, and its text — editable, sendable
// right away, or deletable. One that couldn't be delivered says why.
export function ScheduledMessagesList() {
  const { data: scheduled, isLoading } = useScheduledMessages();
  const { data: channels } = useUserChannels();
  const { data: conversations } = useUserConversations();
  const sendNow = useSendScheduledNow();
  const remove = useDeleteScheduledMessage();
  const [editing, setEditing] = useState<ScheduledMessage | null>(null);
  const [deleting, setDeleting] = useState<ScheduledMessage | null>(null);
  // Read once per render pass for the relative labels ("Tomorrow at 9:00 AM").
  const [now] = useState(() => new Date());

  const channelName = (id: string) => channels?.find((c) => c.channelID === id)?.channelName ?? '';
  const destination = (m: ScheduledMessage) =>
    m.parentType === 'channel'
      ? `~${channelName(m.parentID) || 'channel'}`
      : (conversations?.find((c) => c.conversationID === m.parentID)?.displayName ?? 'Conversation');

  if (isLoading) {
    return (
      <div className="space-y-3" data-testid="scheduled-loading">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }
  if (!scheduled?.length) {
    return (
      <p className="py-12 text-center text-muted-foreground" data-testid="scheduled-empty">
        No scheduled messages. Use the ⌄ next to Send to send one later.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {scheduled.map((m) => {
        const failed = m.state === 'failed';
        return (
          <article key={m.id} className="flex items-start gap-3 rounded-lg border bg-card p-3" data-testid="scheduled-row">
            <Link to={chatHref(m, channelName(m.parentID))} className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <span className="truncate">{destination(m)}</span>
                {m.parentMessageID && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">thread</span>
                )}
              </div>
              <p className="mt-1 truncate text-sm text-muted-foreground">
                {toPlainTextPreview(m.body) || 'Attachment'}
              </p>
              <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {failed ? (
                  <span className="flex items-center gap-1 font-medium text-destructive" data-testid="scheduled-failed">
                    <AlertCircle className="h-3.5 w-3.5" aria-hidden />
                    Not sent: {m.failReason}
                  </span>
                ) : (
                  <span className="flex items-center gap-1">
                    <CalendarClock className="h-3.5 w-3.5" aria-hidden />
                    Sends {formatScheduleTime(new Date(m.sendAt), now)}
                  </span>
                )}
                {(m.attachmentIDs?.length ?? 0) > 0 && (
                  <span className="flex items-center gap-1">
                    <Paperclip className="h-3.5 w-3.5" aria-hidden />
                    {m.attachmentIDs!.length}
                  </span>
                )}
              </p>
            </Link>
            <div className="flex shrink-0 items-center gap-0.5">
              <Button variant="ghost" size="icon" className="h-8 w-8 mobile:h-9 mobile:w-9" aria-label="Edit scheduled message" onClick={() => setEditing(m)}>
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 mobile:h-9 mobile:w-9"
                aria-label={failed ? 'Try sending again' : 'Send now'}
                disabled={sendNow.isPending}
                onClick={() =>
                  sendNow.mutate(m.id, {
                    onSuccess: () => showToast('Sent', 'success'),
                    onError: () => showToast(failed ? "Still couldn't send it." : "Couldn't send it right now — try again in a moment."),
                  })
                }
              >
                <Send className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8 mobile:h-9 mobile:w-9" aria-label="Delete scheduled message" onClick={() => setDeleting(m)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </article>
        );
      })}
      {editing && <EditScheduledDialog message={editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={() => setDeleting(null)}
        title="Delete scheduled message?"
        description="It won't be sent."
        confirmLabel="Delete"
        destructive
        testIDPrefix="delete-scheduled-dialog"
        onConfirm={() => {
          remove.mutate(deleting!.id);
        }}
      />
    </div>
  );
}

// EditScheduledDialog changes a scheduled message's text and send time (a
// new time also schedules a failed one again).
function EditScheduledDialog({ message, onClose }: { message: ScheduledMessage; onClose: () => void }) {
  const update = useUpdateScheduledMessage();
  const [body, setBody] = useState(message.body);
  const [when, setWhen] = useState(() => toLocalInputValue(new Date(message.sendAt)));
  const [error, setError] = useState('');

  const save = () => {
    const sendAt = new Date(when);
    if (Number.isNaN(sendAt.getTime()) || sendAt.getTime() <= Date.now()) {
      setError('Pick a time in the future.');
      return;
    }
    if (!body.trim() && !message.attachmentIDs?.length) {
      setError('The message is empty.');
      return;
    }
    update.mutate(
      { id: message.id, body, sendAt },
      { onSuccess: onClose, onError: () => setError("Couldn't save — please try again.") },
    );
  };

  return (
    // No trigger: the dialog only ever asks to close.
    <Dialog open onOpenChange={onClose}>
      <DialogContent size="md" data-testid="edit-scheduled-dialog">
        <DialogHeader>
          <DialogTitle>Edit scheduled message</DialogTitle>
          <DialogDescription>Change the text or when it&apos;s sent.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-1 py-2">
          <textarea
            aria-label="Message"
            className="min-h-28 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-base md:text-sm"
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              setError('');
            }}
          />
          <input
            type="datetime-local"
            aria-label="Send time"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-base md:text-sm mobile:h-11"
            value={when}
            onChange={(e) => {
              setWhen(e.target.value);
              setError('');
            }}
          />
          {error && (
            <p className="text-xs text-destructive" data-testid="edit-scheduled-error">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={update.isPending}>
            {update.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function chatHref(m: ScheduledMessage, channelName: string): string {
  const base = m.parentType === 'channel' ? `/channel/${slugify(channelName) || m.parentID}` : `/conversation/${m.parentID}`;
  return m.parentMessageID ? `${base}?thread=${m.parentMessageID}#msg-${m.parentMessageID}` : base;
}
