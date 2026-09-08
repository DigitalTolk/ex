import { Eye, Loader2, Play, X } from 'lucide-react';
import { useState } from 'react';
import { agentByID, useAgents, useDecideCatchUp, useParentWatchers } from '@/hooks/useAgents';
import { showToast } from '@/lib/toast';
import { NoticeCard, noticeStackClass } from './NoticeCardChrome';
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
      {
        // A failure here left the card sitting there with no explanation, so
        // the backlog looked ignored. Say so; the card stays for a retry.
        onError: () => showToast("Couldn't send that — try again."),
        onSettled: () => setBusy(null),
      },
    );
  };

  return (
    <div className={noticeStackClass} aria-live="polite">
      {asks.map((w) => {
        const agent = agentByID(agents, w.agentID);
        const isBusy = busy === w.id;
        return (
          <NoticeCard
            key={w.id}
            accent="catchup"
            testID="watcher-catchup-card"
            header={
              <>
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/20">
                  <Eye className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                </span>
                <span className="text-xs font-semibold">
                  {agent?.displayName ?? 'A watcher'}
                  <span className="font-normal text-muted-foreground"> has a backlog to catch up on</span>
                </span>
              </>
            }
          >
            <>
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
            </>
          </NoticeCard>
        );
      })}
    </div>
  );
}
