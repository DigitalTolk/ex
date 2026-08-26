import { Eye, Loader2, Play, X } from 'lucide-react';
import { useState } from 'react';
import { useAgents, useDecideCatchUp, useParentWatchers } from '@/hooks/useAgents';
import { useAuth } from '@/context/AuthContext';
import { formatRelative } from '@/lib/format';

interface Props {
  parentID?: string;
  parentType: 'channel' | 'conversation';
}

// WatcherCatchUpCard: shown when one of YOUR watchers accumulated a backlog
// while you were offline and its agent runs on your local CLI — the backend
// won't burn your machine/tokens without a go-ahead. Process = one coalesced
// catch-up run covering everything missed; Dismiss = drop the backlog.
export function WatcherCatchUpCard({ parentID, parentType }: Props) {
  const { user } = useAuth();
  const { data: watchers } = useParentWatchers(parentType, parentID);
  const { data: agents } = useAgents();
  const decide = useDecideCatchUp();
  const [busy, setBusy] = useState<string | null>(null);

  const asks = (watchers ?? []).filter(
    (w) => w.creatorID === user?.id && w.pendingCatchUp && w.pendingOffline,
  );
  if (!parentID || asks.length === 0) return null;

  const act = (id: string, process: boolean) => {
    setBusy(id);
    decide.mutate(
      { parentID, id, process },
      { onSettled: () => setBusy(null) },
    );
  };

  return (
    <div className="pointer-events-auto mb-1 ml-1 flex w-fit max-w-xl flex-col gap-2" aria-live="polite">
      {asks.map((w) => {
        const agent = agents?.find((a) => a.id === w.agentID);
        const isBusy = busy === w.id;
        return (
          <div
            key={w.id}
            data-testid="watcher-catchup-card"
            className="w-full overflow-hidden rounded-xl border border-primary/30 bg-background/95 shadow-lg backdrop-blur"
          >
            <div className="flex items-center gap-2 border-b border-primary/20 bg-primary/10 px-3 py-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/20">
                <Eye className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
              </span>
              <span className="text-xs font-semibold">
                {agent?.displayName ?? 'A watcher'}
                <span className="font-normal text-muted-foreground"> has a backlog to catch up on</span>
              </span>
            </div>
            <div className="px-3 py-2.5">
              <p className="text-xs leading-relaxed text-muted-foreground">
                Messages arrived{w.pendingSince ? ` ${formatRelative(w.pendingSince)}` : ''} while you were
                away{w.instruction ? <> — standing order: <span className="italic">“{w.instruction}”</span></> : ''}.
                Processing runs once on your machine and covers everything missed.
              </p>
              <div className="mt-2.5 flex items-center gap-2">
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => act(w.id, true)}
                  data-testid="catchup-process"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {isBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Play className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  Process now
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => act(w.id, false)}
                  data-testid="catchup-dismiss"
                  className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
