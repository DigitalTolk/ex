import { useState } from 'react';
import { Bot, CalendarClock, Pencil, Plus, Trash2 } from 'lucide-react';
import { PageContainer } from '@/components/layout/PageContainer';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import {
  useAgents,
  useAllAgentSchedules,
  useDeleteAgentSubscription,
  type AgentSubscription,
  type AgentView,
} from '@/hooks/useAgents';
import { useUserChannels } from '@/hooks/useChannels';
import { describeSchedule, partsFromCron } from '@/lib/schedule';
import { showToast } from '@/lib/toast';
import { ScheduleForm } from './agents/ScheduleForm';

// SchedulesPage: every standing order you've given any agent, in one list.
// The same orders are editable from each agent's own card, but "what have I
// got running, and when" is a question about the SET — answering it by
// expanding agents one at a time was the gap this page fills.
export default function SchedulesPage() {
  useDocumentTitle('Schedules');
  const { data: agents, isLoading: agentsLoading } = useAgents();
  const { rows, isLoading: rowsLoading } = useAllAgentSchedules(agents);
  const { data: channels } = useUserChannels();
  const [adding, setAdding] = useState(false);

  const channelName = (id: string) => channels?.find((c) => c.channelID === id)?.channelName ?? id;
  const isLoading = agentsLoading || rowsLoading;

  return (
    <PageContainer
      title="Schedules"
      description="Standing orders your agents carry out on a clock — “every weekday at 08:00, summarise yesterday’s support tickets”. Each result lands where you choose: a private DM, or a channel."
      actions={
        !adding && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" />
            New schedule
          </Button>
        )
      }
    >
      {adding && (
        <div className="mb-5">
          <ScheduleForm agents={agents} onDone={() => setAdding(false)} />
        </div>
      )}

      {isLoading && (
        <div className="space-y-2" data-testid="schedules-loading">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[64px] w-full rounded-xl" />
          ))}
        </div>
      )}

      {!isLoading && rows.length === 0 && !adding && (
        <div className="py-12 text-center text-muted-foreground" data-testid="schedules-empty">
          <CalendarClock className="mx-auto mb-3 h-8 w-8" />
          <p>
            No schedules yet. Create one — e.g. “every weekday at 08:00, post yesterday’s revenue
            from metabase”.
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
          {rows.map(({ agent, sub }) => (
            <ScheduleRow
              key={sub.id}
              agent={agent}
              sub={sub}
              destination={
                sub.parentType === 'conversation' ? 'as a DM' : `~${channelName(sub.parentID)}`
              }
            />
          ))}
        </div>
      )}
    </PageContainer>
  );
}

function ScheduleRow({
  agent,
  sub,
  destination,
}: {
  agent: AgentView;
  sub: AgentSubscription;
  destination: string;
}) {
  const del = useDeleteAgentSubscription(agent.slug);
  const [editing, setEditing] = useState(false);
  const when = describeSchedule(sub.schedule, sub.scheduleTZ);
  const isCLI = agent.resolved.harness !== 'bedrock';

  if (editing) {
    return (
      <div className="p-3" data-testid={`schedule-row-${sub.id}`}>
        <ScheduleForm
          fixedAgent={agent}
          editing={sub}
          editingDestination={sub.parentType === 'conversation' ? 'a DM' : destination}
          onDone={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div className="px-4 py-3" data-testid={`schedule-row-${sub.id}`}>
      <div className="flex items-start gap-3">
        <div
          aria-hidden="true"
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
        >
          <CalendarClock className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium">{when}</span>
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Bot className="h-3 w-3" aria-hidden="true" />@{agent.displayName} · {destination}
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {/* Only specs the form can express open in it; anything richer
                  would be flattened to the form's defaults on save. */}
              {partsFromCron(sub.schedule) && (
                <TooltipIconButton label={`Edit schedule: ${when}`} onClick={() => setEditing(true)}>
                  <Pencil aria-hidden="true" />
                </TooltipIconButton>
              )}
              <TooltipIconButton
                label={`Delete schedule: ${when}`}
                className="hover:text-destructive"
                onClick={() =>
                  del.mutate(
                    { parentID: sub.parentID, id: sub.id },
                    { onError: () => showToast("Couldn't delete that schedule — try again.") },
                  )
                }
              >
                <Trash2 aria-hidden="true" />
              </TooltipIconButton>
            </div>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">{sub.instruction}</p>
          {isCLI && (
            <p className="mt-1 text-xs text-muted-foreground/80" data-testid={`schedule-row-cli-${sub.id}`}>
              Runs on your computer — needs the ex desktop app open at that time.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
