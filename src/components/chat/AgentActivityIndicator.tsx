import { useEffect, useRef, useState } from 'react';
import { Bot, ChevronUp, Loader2 } from 'lucide-react';
import { useAgentRunsFor, type AgentRunActivity } from '@/stores/agent-runs';
import { openRunDrawer } from '@/stores/run-drawer';
import type { UserMapEntry } from './MessageList';

interface Props {
  parentID?: string;
  userMap?: Record<string, UserMapEntry>;
}

// AgentActivityIndicator: a floating chip above the composer showing what
// agents are doing in this channel, fed live by run.updated / run.progress.
//
// One agent → "⟳ gg · posting a reply…". Several → "⟳ 2 agents working"
// which opens a popover listing each agent, who invoked it, and its current
// action. This is the ONLY main-list surface for agent work (the orchestrator
// routes agent typing events to the thread bucket alone), so nothing stacks.
// Finished runs leave immediately — their drawer stays reachable via "Show
// activity" on the agent's messages.
//
// It renders inside MessageInput's aboveInput overlay, which is
// pointer-events-none by design (so the empty gap never blocks clicks on
// messages) — the chip itself restores pointer-events-auto to be clickable.
export function AgentActivityIndicator({ parentID, userMap }: Props) {
  const runs = useAgentRunsFor(parentID ?? '');
  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close the popover on outside click / Escape, like other transient
  // overlays. Listeners attach only while it's open.
  useEffect(() => {
    if (!expanded) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [expanded]);

  if (!parentID || runs.length === 0) return null;

  const agentName = (run: AgentRunActivity) => userMap?.[run.agentID]?.displayName ?? 'agent';
  const invokerName = (run: AgentRunActivity) =>
    run.invokerID ? userMap?.[run.invokerID]?.displayName : undefined;

  const single = runs.length === 1;

  return (
    <div
      ref={rootRef}
      data-testid="agent-activity-indicator"
      aria-live="polite"
      className="pointer-events-auto relative mb-1 ml-1 w-fit"
    >
      {expanded && !single && (
        <div
          data-testid="agent-activity-list"
          className="absolute bottom-full left-0 mb-1.5 max-h-56 w-72 overflow-y-auto rounded-lg border bg-popover p-1.5 text-popover-foreground shadow-lg"
          role="list"
        >
          {runs.map((run) => (
            <button
              key={run.runID}
              type="button"
              role="listitem"
              onClick={() => {
                setExpanded(false);
                openRunDrawer(run.runID);
              }}
              className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
              title="Open run activity"
            >
              <Bot className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5 text-xs">
                  <span className="font-semibold">{agentName(run)}</span>
                  {invokerName(run) && (
                    <span className="text-muted-foreground">for {invokerName(run)}</span>
                  )}
                </div>
                <div className="truncate text-xs text-muted-foreground">{run.action}</div>
              </div>
              <Loader2
                className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground"
                aria-hidden="true"
              />
            </button>
          ))}
        </div>
      )}

      <button
        type="button"
        data-testid="agent-activity-chip"
        // Single run → straight into its Activity Drawer; several → the
        // popover picks which one first.
        onClick={() => (single ? openRunDrawer(runs[0].runID) : setExpanded((v) => !v))}
        aria-expanded={single ? undefined : expanded}
        title={single ? 'Open run activity' : undefined}
        className="flex max-w-md cursor-pointer items-center gap-1.5 rounded-full border bg-background/95 px-2.5 py-1 text-xs shadow-sm backdrop-blur hover:bg-accent"
      >
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
        {single ? (
          <>
            <span className="shrink-0 font-medium">{agentName(runs[0])}</span>
            {invokerName(runs[0]) && (
              <span className="shrink-0 text-muted-foreground">for {invokerName(runs[0])}</span>
            )}
            <span className="truncate text-muted-foreground">{runs[0].action}</span>
          </>
        ) : (
          <>
            <span className="font-medium">{runs.length} agents working</span>
            <ChevronUp
              className={`h-3 w-3 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
          </>
        )}
      </button>
    </div>
  );
}
