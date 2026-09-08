import { useState } from 'react';
import { Eye, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  useAgentSubscriptions,
  useCreateAgentSubscription,
  useDeleteAgentSubscription,
  type AgentView,
} from '@/hooks/useAgents';
import { useUserChannels } from '@/hooks/useChannels';
import { showToast } from '@/lib/toast';

export function WatchedChannels({ agent }: { agent: AgentView }) {
  const { data: subs } = useAgentSubscriptions(agent.slug);
  const { data: channels } = useUserChannels();
  const create = useCreateAgentSubscription(agent.slug);
  const del = useDeleteAgentSubscription(agent.slug);
  const [channelID, setChannelID] = useState('');
  const [keywords, setKeywords] = useState('');
  const [heartbeat, setHeartbeat] = useState('0');

  const channelName = (id: string) =>
    channels?.find((c) => c.channelID === id)?.channelName ?? id;

  const add = () => {
    if (!channelID) return;
    create.mutate(
      {
        parentID: channelID,
        parentType: 'channel',
        keywords: keywords
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean),
        heartbeatMins: Number(heartbeat) || 0,
      },
      {
        onSuccess: () => {
          setChannelID('');
          setKeywords('');
          setHeartbeat('0');
        },
      },
    );
  };

  return (
    <div className="border-t pt-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
        <Eye className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        Watched channels
      </div>
      <p className="mb-2 text-xs text-muted-foreground">
        @{agent.displayName} reacts to matching messages in these channels without being mentioned — on
        your machine, with your access. Keywords empty = every message; check-ins post only when
        something needs attention.
      </p>
      {(subs?.length ?? 0) > 0 && (
        <ul className="mb-2 space-y-1">
          {subs?.map((sub) => (
            <li
              key={sub.id}
              className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs"
              data-testid={`agent-sub-${sub.id}`}
            >
              <span className="font-medium">~{channelName(sub.parentID)}</span>
              <span className="text-muted-foreground">
                {sub.keywords?.length ? `keywords: ${sub.keywords.join(', ')}` : 'all messages'}
                {sub.heartbeatMins ? ` · check-in every ${sub.heartbeatMins}m` : ''}
              </span>
              <button
                type="button"
                aria-label="Stop watching"
                onClick={() =>
                  del.mutate(
                    { parentID: sub.parentID, id: sub.id },
                    { onError: () => showToast("Couldn't stop that watcher — try again.") },
                  )
                }
                className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Channel to watch"
          className="rounded-md border bg-transparent p-1.5 text-xs"
          value={channelID}
          onChange={(e) => setChannelID(e.target.value)}
        >
          <option value="">choose channel…</option>
          {channels?.map((c) => (
            <option key={c.channelID} value={c.channelID}>
              ~{c.channelName}
            </option>
          ))}
        </select>
        <Input
          className="h-8 w-48 text-xs"
          placeholder="keywords, comma-separated"
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
        />
        <select
          aria-label="Check-in interval"
          className="rounded-md border bg-transparent p-1.5 text-xs"
          value={heartbeat}
          onChange={(e) => setHeartbeat(e.target.value)}
        >
          <option value="0">no check-ins</option>
          <option value="30">check in every 30m</option>
          <option value="60">check in hourly</option>
          <option value="240">check in every 4h</option>
        </select>
        <Button size="sm" variant="outline" disabled={!channelID || create.isPending} onClick={add}>
          Watch
        </Button>
      </div>
    </div>
  );
}
