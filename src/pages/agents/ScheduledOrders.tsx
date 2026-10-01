import { useState } from 'react';
import { CalendarClock, Pencil, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  useAgentSubscriptions,
  useDeleteAgentSubscription,
  type AgentView,
} from '@/hooks/useAgents';
import { useUserChannels } from '@/hooks/useChannels';
import { describeSchedule, localTimeZone, partsFromCron } from '@/lib/schedule';
import { showToast } from '@/lib/toast';
import { ScheduleForm } from './ScheduleForm';

// ScheduledOrders: standing orders an agent carries out on a clock rather
// than in reaction to a message — "every weekday at 08:00, post yesterday's
// numbers from metabase". Stored as a subscription with a cron spec, so the
// same row type powers watchers and schedules; the two triggers are
// exclusive (a scheduled row never fires on chat).
export function ScheduledOrders({ agent }: { agent: AgentView }) {
  const { data: subs } = useAgentSubscriptions(agent.slug);
  const { data: channels } = useUserChannels();
  const del = useDeleteAgentSubscription(agent.slug);

  const [adding, setAdding] = useState(false);
  const [editingID, setEditingID] = useState('');

  const scheduled = (subs ?? []).filter((s) => s.schedule);
  const channelName = (id: string) => channels?.find((c) => c.channelID === id)?.channelName ?? id;
  const tz = localTimeZone();
  // Scheduled work fires whether or not anyone is at their desk, so a CLI
  // agent — which runs on the creator's own machine — can only keep the
  // appointment when the desktop app happens to be open at that hour.
  const isCLI = agent.resolved.harness !== 'bedrock';

  return (
    <div className="border-t pt-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
        <CalendarClock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        Scheduled orders
      </div>
      <p className="mb-2 text-xs text-muted-foreground">
        @{agent.displayName} does these on a clock, without being asked — “every weekday at 08:00,
        summarise yesterday’s support tickets”. Each result lands where you choose: a private DM,
        or a channel{tz ? ` · times default to ${tz}` : ''}.
      </p>

      {isCLI && scheduled.length > 0 && (
        <p
          className="mb-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-muted-foreground"
          data-testid={`schedule-cli-warning-${agent.slug}`}
        >
          @{agent.displayName} runs on your own computer, so a scheduled order only fires if your ex
          desktop app is open and signed in at that time. For orders that must run unattended, use a
          Bedrock agent — those run in the cloud.
        </p>
      )}

      {scheduled.length > 0 && (
        <ul className="mb-2 space-y-1">
          {scheduled.map((sub) =>
            editingID === sub.id ? (
              <li key={sub.id}>
                <ScheduleForm
                  fixedAgent={agent}
                  editing={sub}
                  editingDestination={
                    sub.parentType === 'conversation' ? 'a DM' : `~${channelName(sub.parentID)}`
                  }
                  onDone={() => setEditingID('')}
                />
              </li>
            ) : (
            <li
              key={sub.id}
              className="flex items-start gap-2 rounded-md border px-2 py-1.5 text-xs"
              data-testid={`agent-schedule-${sub.id}`}
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium">{describeSchedule(sub.schedule, sub.scheduleTZ)}</div>
                <div className="text-muted-foreground">
                  {sub.parentType === 'conversation' ? 'as a DM' : `in ~${channelName(sub.parentID)}`} ·{' '}
                  {sub.instruction}
                </div>
              </div>
              {/* Only specs the form can express open in it; anything richer
                  would be flattened to the form's defaults on save. */}
              {partsFromCron(sub.schedule) && (
                <button
                  type="button"
                  aria-label={`Edit scheduled order for ${describeSchedule(sub.schedule, sub.scheduleTZ)}`}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={() => setEditingID(sub.id)}
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                aria-label={`Delete scheduled order for ${describeSchedule(sub.schedule, sub.scheduleTZ)}`}
                className="shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() =>
                  del.mutate(
                    { parentID: sub.parentID, id: sub.id },
                    { onError: () => showToast("Couldn't delete that order — try again.") },
                  )
                }
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </li>
            ),
          )}
        </ul>
      )}

      {!adding && (
        <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
          <Plus aria-hidden="true" />
          New scheduled order
        </Button>
      )}

      {adding && <ScheduleForm fixedAgent={agent} onDone={() => setAdding(false)} />}
    </div>
  );
}
