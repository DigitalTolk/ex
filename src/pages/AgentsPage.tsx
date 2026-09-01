import { useState } from 'react';
import { Bot, Check, Eye, Plus, X } from 'lucide-react';
import { PageContainer } from '@/components/layout/PageContainer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/context/AuthContext';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import {
  useAgentSubscriptions,
  useAgents,
  useCreateAgent,
  useCreateAgentSubscription,
  useDeleteAgentSubscription,
  useUpdateAgentPrefs,
  type AgentView,
  AUTO_ALLOW_CLASSES,
} from '@/hooks/useAgents';
import { useUserChannels } from '@/hooks/useChannels';

// AgentsPage: the shared workspace agents (@gg, @qib — they belong to no
// one) with YOUR settings for them. Mentioning an agent runs it on YOUR
// machine via the desktop app, using your local Claude Code / Codex install
// and the prompt/pin you set here.
export default function AgentsPage() {
  useDocumentTitle('Agents');
  const { data: agents, isLoading } = useAgents();
  const { user } = useAuth();
  const isAdmin = user?.systemRole === 'admin';
  const [creating, setCreating] = useState(false);

  return (
    <PageContainer
      title="Agents"
      description="Shared agents anyone can @mention. When you invoke one, it runs on your machine through the desktop app — with your settings below."
    >
      {isAdmin && (
        <div className="mb-4">
          {creating ? (
            <NewAgentForm onDone={() => setCreating(false)} />
          ) : (
            <Button onClick={() => setCreating(true)}>
              <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
              New agent
            </Button>
          )}
        </div>
      )}

      {isLoading && (
        <div className="space-y-3" data-testid="agents-loading">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-48 w-full" />
          ))}
        </div>
      )}

      {!isLoading && (agents?.length ?? 0) === 0 && (
        <div className="py-12 text-center text-muted-foreground" data-testid="agents-empty">
          <Bot className="mx-auto mb-3 h-8 w-8" />
          <p>No agents configured in this workspace.</p>
        </div>
      )}

      <div className="space-y-4">
        {agents?.map((agent) => (
          // Key includes the server-side pref values so a successful save (or
          // an update from another tab) remounts the card with fresh form
          // state — no sync effect needed.
          <AgentCard
            key={`${agent.slug}:${agent.prefs.persona ?? ''}:${agent.prefs.harness ?? ''}:${agent.prefs.model ?? ''}:${agent.prefs.executionMode ?? ''}:${agent.prefs.offlinePolicy ?? ''}:${agent.prefs.limits?.maxChainRounds ?? ''}:${agent.prefs.followUpMode ?? ''}:${agent.prefs.followUpMins ?? ''}:${agent.prefs.followUpAsk ?? ''}`}
            agent={agent}
          />
        ))}
      </div>
    </PageContainer>
  );
}

// NewAgentForm defines a new shared agent (admin-only). The agent becomes
// mentionable workspace-wide immediately; per-user prefs still override.
function NewAgentForm({ onDone }: { onDone: () => void }) {
  const create = useCreateAgent();
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [harness, setHarness] = useState('claude');
  const [model, setModel] = useState('');
  const [execMode, setExecMode] = useState('runner');
  const [persona, setPersona] = useState('');
  const isBedrock = harness === 'bedrock';
  const valid = /^[a-z][a-z0-9-]{1,31}$/.test(slug) && persona.trim().length > 0;

  const save = () => {
    create.mutate(
      {
        slug,
        displayName,
        harness,
        model,
        executionMode: isBedrock ? execMode : '',
        persona,
      },
      { onSuccess: onDone },
    );
  };

  return (
    <div className="space-y-3 rounded-lg border p-4" data-testid="new-agent-form">
      <div className="flex flex-wrap gap-3">
        <div>
          <Label htmlFor="new-agent-slug">Handle</Label>
          <div className="mt-1 flex items-center gap-1">
            <span className="text-muted-foreground">@</span>
            <Input
              id="new-agent-slug"
              className="w-40"
              value={slug}
              placeholder="researcher"
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
            />
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">Lowercase, how people @mention it.</p>
        </div>
        <div>
          <Label htmlFor="new-agent-name">Display name</Label>
          <Input
            id="new-agent-name"
            className="mt-1 w-40"
            value={displayName}
            placeholder={slug || 'Researcher'}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="new-agent-harness">Backend</Label>
          <select
            id="new-agent-harness"
            className="mt-1 block rounded-md border bg-transparent p-2 text-sm"
            value={harness}
            onChange={(e) => setHarness(e.target.value)}
          >
            <option value="claude">Claude Code (CLI)</option>
            <option value="codex">Codex (CLI)</option>
            <option value="bedrock">AWS Bedrock (API)</option>
          </select>
        </div>
        <div>
          <Label htmlFor="new-agent-model">Model</Label>
          <Input
            id="new-agent-model"
            className={isBedrock ? 'mt-1 w-72' : 'mt-1 w-48'}
            value={model}
            placeholder={
              isBedrock ? 'anthropic.claude-3-5-sonnet-20241022-v2:0' : 'backend default'
            }
            onChange={(e) => setModel(e.target.value)}
          />
        </div>
        {isBedrock && (
          <div>
            <Label htmlFor="new-agent-exec">Runs on</Label>
            <select
              id="new-agent-exec"
              className="mt-1 block rounded-md border bg-transparent p-2 text-sm"
              value={execMode}
              onChange={(e) => setExecMode(e.target.value)}
            >
              <option value="runner">the invoker’s machine</option>
              <option value="server" disabled>
                the server — coming soon
              </option>
            </select>
          </div>
        )}
      </div>
      <div>
        <Label htmlFor="new-agent-persona">Prompt (persona)</Label>
        <textarea
          id="new-agent-persona"
          className="mt-1 min-h-28 w-full rounded-md border bg-transparent p-2 text-sm"
          value={persona}
          placeholder="You are Researcher, a… — what this agent is for and how it should behave."
          maxLength={8192}
          onChange={(e) => setPersona(e.target.value)}
        />
      </div>
      {create.isError && (
        <p className="text-sm text-destructive">
          Create failed
          {create.error instanceof Error ? `: ${create.error.message}` : ''}.
        </p>
      )}
      <div className="flex gap-2">
        <Button onClick={save} disabled={!valid || create.isPending}>
          <Check className="mr-1 h-4 w-4" aria-hidden="true" />
          {create.isPending ? 'Creating…' : 'Create agent'}
        </Button>
        <Button variant="outline" onClick={onDone} disabled={create.isPending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function statusBadge(status: string) {
  switch (status) {
    case 'active':
      return <Badge variant="secondary">ready on your machine</Badge>;
    case 'needs_setup':
      return <Badge variant="destructive">CLI missing on your machine</Badge>;
    case 'offline':
      return <Badge variant="outline">desktop app not running</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function AgentCard({ agent }: { agent: AgentView }) {
  const update = useUpdateAgentPrefs();
  // Form state mirrors YOUR pref fields; placeholder shows the inherited
  // workspace default so "blank = inherit" is visible, not implied.
  const [persona, setPersona] = useState(agent.prefs.persona ?? '');
  const [harness, setHarness] = useState(agent.prefs.harness ?? '');
  const [model, setModel] = useState(agent.prefs.model ?? '');
  const [offlinePolicy, setOfflinePolicy] = useState(agent.prefs.offlinePolicy ?? '');
  const [chainRounds, setChainRounds] = useState(
    agent.prefs.limits?.maxChainRounds ? String(agent.prefs.limits.maxChainRounds) : '',
  );
  // Follow-up select folds mode+minutes into one value: "" (off), "window:N",
  // "always" — decoded back into the two pref fields on save.
  const initialFollowUp =
    agent.prefs.followUpMode === 'always'
      ? 'always'
      : agent.prefs.followUpMode === 'window'
        ? `window:${agent.prefs.followUpMins || 10}`
        : '';
  const [followUp, setFollowUp] = useState(initialFollowUp);
  const [followUpAsk, setFollowUpAsk] = useState(agent.prefs.followUpAsk ?? false);
  const [execMode, setExecMode] = useState(agent.prefs.executionMode ?? '');
  const initialAutoAllow = [...(agent.prefs.autoAllow ?? [])].sort().join(',');
  const [autoAllow, setAutoAllow] = useState<string[]>(agent.prefs.autoAllow ?? []);
  const [saved, setSaved] = useState(false);

  const isBedrock = harness === 'bedrock';

  const dirty =
    persona !== (agent.prefs.persona ?? '') ||
    harness !== (agent.prefs.harness ?? '') ||
    model !== (agent.prefs.model ?? '') ||
    offlinePolicy !== (agent.prefs.offlinePolicy ?? '') ||
    execMode !== (agent.prefs.executionMode ?? '') ||
    followUp !== initialFollowUp ||
    followUpAsk !== (agent.prefs.followUpAsk ?? false) ||
    [...autoAllow].sort().join(',') !== initialAutoAllow ||
    chainRounds !==
      (agent.prefs.limits?.maxChainRounds ? String(agent.prefs.limits.maxChainRounds) : '');

  const save = () => {
    update.mutate(
      {
        slug: agent.slug,
        patch: {
          persona,
          harness,
          model,
          executionMode: isBedrock ? execMode : '',
          offlinePolicy,
          followUpMode: followUp === 'always' ? 'always' : followUp.startsWith('window:') ? 'window' : '',
          followUpMins: followUp.startsWith('window:') ? Number(followUp.slice(7)) : 0,
          followUpAsk,
          autoAllow,
          // Whole-struct semantics server-side: a number sets the override,
          // an empty struct resets to inherit.
          limits: chainRounds ? { maxChainRounds: Number(chainRounds) } : {},
        },
      },
      {
        onSuccess: () => {
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        },
      },
    );
  };

  return (
    <div className="rounded-lg border p-4" data-testid={`agent-card-${agent.slug}`}>
      <div className="mb-3 flex items-center gap-2">
        <Bot className="h-5 w-5 text-muted-foreground" />
        <span className="font-semibold">@{agent.displayName}</span>
        {statusBadge(agent.status)}
        <span className="ml-auto text-xs text-muted-foreground">
          for you: {agent.resolved.harness}
          {agent.resolved.model ? ` · ${agent.resolved.model}` : ''}
        </span>
      </div>

      <div className="space-y-3">
        <div>
          <Label htmlFor={`persona-${agent.slug}`}>Your prompt for @{agent.displayName}</Label>
          <textarea
            id={`persona-${agent.slug}`}
            className="mt-1 w-full rounded-md border bg-transparent p-2 text-sm min-h-24"
            value={persona}
            placeholder={agent.resolved.persona}
            onChange={(e) => setPersona(e.target.value)}
          />
          <p className="mt-0.5 text-xs text-muted-foreground">
            Applies only when <em>you</em> invoke @{agent.displayName}. Leave empty to use the workspace
            default. Changes apply to your next task, never a running one.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor={`harness-${agent.slug}`}>Backend</Label>
            <select
              id={`harness-${agent.slug}`}
              className="mt-1 block rounded-md border bg-transparent p-2 text-sm"
              value={harness}
              onChange={(e) => setHarness(e.target.value)}
            >
              <option value="">default ({agent.resolved.harness})</option>
              <option value="claude">Claude Code (CLI)</option>
              <option value="codex">Codex (CLI)</option>
              <option value="bedrock">AWS Bedrock (API)</option>
            </select>
          </div>
          {isBedrock && (
            <div>
              <Label htmlFor={`exec-${agent.slug}`}>Runs on</Label>
              <select
                id={`exec-${agent.slug}`}
                className="mt-1 block rounded-md border bg-transparent p-2 text-sm"
                value={execMode || 'runner'}
                onChange={(e) => setExecMode(e.target.value)}
              >
                <option value="runner">my machine (AWS creds)</option>
                <option value="server" disabled>
                  the server — coming soon
                </option>
              </select>
            </div>
          )}
          <div>
            <Label htmlFor={`rounds-${agent.slug}`}>Discussion rounds</Label>
            <Input
              id={`rounds-${agent.slug}`}
              className="mt-1 w-28"
              type="number"
              min={1}
              max={50}
              value={chainRounds}
              placeholder={String(agent.resolved.limits.maxChainRounds ?? 12)}
              onChange={(e) => setChainRounds(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor={`offline-${agent.slug}`}>If your app is offline</Label>
            <select
              id={`offline-${agent.slug}`}
              className="mt-1 block rounded-md border bg-transparent p-2 text-sm"
              value={offlinePolicy}
              onChange={(e) => setOfflinePolicy(e.target.value)}
            >
              <option value="">fail fast (default)</option>
              <option value="queue">queue up to 1 hour</option>
            </select>
          </div>
          <div>
            <Label htmlFor={`model-${agent.slug}`}>Model</Label>
            <Input
              id={`model-${agent.slug}`}
              className={isBedrock ? 'mt-1 w-80' : 'mt-1 w-56'}
              value={model}
              placeholder={
                isBedrock
                  ? agent.resolved.model || 'anthropic.claude-3-5-sonnet-20241022-v2:0'
                  : agent.resolved.model || 'harness default'
              }
              onChange={(e) => setModel(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor={`followup-${agent.slug}`}>Thread follow-ups</Label>
            <select
              id={`followup-${agent.slug}`}
              className="mt-1 block rounded-md border bg-transparent p-2 text-sm"
              value={followUp}
              onChange={(e) => setFollowUp(e.target.value)}
              title="After it replies in a thread, your un-tagged replies there keep re-invoking it (on your quota)."
            >
              <option value="">off — mentions only</option>
              <option value="window:10">for 10 min after it replies</option>
              <option value="window:30">for 30 min after it replies</option>
              <option value="window:60">for 1 hour after it replies</option>
              <option value="always">always follow its threads</option>
            </select>
          </div>
          {followUp !== '' && (
            <label
              className="flex items-center gap-1.5 pb-2 text-sm text-muted-foreground"
              htmlFor={`followup-ask-${agent.slug}`}
            >
              <input
                id={`followup-ask-${agent.slug}`}
                type="checkbox"
                checked={followUpAsk}
                onChange={(e) => setFollowUpAsk(e.target.checked)}
              />
              ask me before it replies
            </label>
          )}
          <fieldset className="pb-2">
            <legend className="text-sm font-medium">Don’t ask me to approve</legend>
            <p className="mb-1 text-xs text-muted-foreground">
              Pre-approve harness tool classes for @{agent.displayName} on your machine. Everything
              else still shows an approval card; inside a coding task the workspace profile applies too.
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {AUTO_ALLOW_CLASSES.map((c) => (
                <label key={c.id} className="flex items-center gap-1.5 text-sm" title={c.hint}>
                  <input
                    type="checkbox"
                    checked={autoAllow.includes(c.id)}
                    onChange={(e) =>
                      setAutoAllow((prev) =>
                        e.target.checked ? [...prev.filter((x) => x !== c.id), c.id] : prev.filter((x) => x !== c.id),
                      )
                    }
                  />
                  {c.label}
                </label>
              ))}
            </div>
          </fieldset>
          <Button onClick={save} disabled={!dirty || update.isPending} className="ml-auto">
            {saved ? <Check className="mr-1 h-4 w-4" /> : null}
            {saved ? 'Saved' : update.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>

        {isBedrock && (
          <p className="text-xs text-muted-foreground">
            Runs via AWS Bedrock through your machine’s AWS credentials (no Claude/Codex CLI
            needed). Bedrock agents use the chat and workspace tools only — no local shell or
            files. Enter a Bedrock model id or inference-profile ARN above (e.g. a Claude, Llama,
            or Mistral model). Server-side runs (no desktop app needed) are coming next.
          </p>
        )}

        {update.isError && (
          <p className="text-sm text-destructive">
            Save failed{update.error instanceof Error ? `: ${update.error.message}` : ''}.
          </p>
        )}

        <WatchedChannels agent={agent} />
      </div>
    </div>
  );
}

// WatchedChannels: this agent watches channels FOR YOU — matching human
// messages (or periodic check-ins) invoke it un-mentioned, on your machine
// and quota.
function WatchedChannels({ agent }: { agent: AgentView }) {
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
                onClick={() => del.mutate({ parentID: sub.parentID, id: sub.id })}
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
