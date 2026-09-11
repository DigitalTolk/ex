import { useEffect, useRef, useState } from 'react';
import { Bot, Check } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  useUpdateAgentPrefs,
  type AgentView,
  AUTO_ALLOW_CLASSES,
} from '@/hooks/useAgents';
import { WatchedChannels } from './WatchedChannels';

function statusBadge(status: string, serverRun: boolean) {
  switch (status) {
    case 'active':
      // Bedrock agents execute in the backend — "your machine" would be a lie.
      return <Badge variant="secondary">{serverRun ? 'ready — runs on the server' : 'ready on your machine'}</Badge>;
    case 'needs_setup':
      return <Badge variant="destructive">CLI missing on your machine</Badge>;
    case 'offline':
      return <Badge variant="outline">desktop app not running</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export function AgentCard({ agent }: { agent: AgentView }) {
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
  const initialAutoAllow = [...(agent.prefs.autoAllow ?? [])].sort().join(',');
  const [autoAllow, setAutoAllow] = useState<string[]>(agent.prefs.autoAllow ?? []);
  const [saved, setSaved] = useState(false);
  // The saved-flash timer must die with the card, or it fires into a torn-down tree.
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(savedTimer.current), []);

  const isBedrock = harness === 'bedrock';
  // The EFFECTIVE backend decides which controls make sense: with the select
  // on "default", the workspace default (resolved) is what actually runs.
  // Server-run bedrock agents have no desktop app to be offline and no local
  // harness tools to pre-approve — those controls would be noise-shaped lies.
  const effectiveBedrock = (harness || agent.resolved.harness) === 'bedrock';

  const dirty =
    persona !== (agent.prefs.persona ?? '') ||
    harness !== (agent.prefs.harness ?? '') ||
    model !== (agent.prefs.model ?? '') ||
    offlinePolicy !== (agent.prefs.offlinePolicy ?? '') ||
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
          // Bedrock agents always run server-side; the field is cleared so
          // stale "runner" prefs from before that decision can't linger.
          executionMode: '',
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
          clearTimeout(savedTimer.current);
          savedTimer.current = setTimeout(() => setSaved(false), 2000);
        },
      },
    );
  };

  return (
    <div className="rounded-lg border p-4" data-testid={`agent-card-${agent.slug}`}>
      <div className="mb-3 flex items-center gap-2">
        <Bot className="h-5 w-5 text-muted-foreground" />
        <span className="font-semibold">@{agent.displayName}</span>
        {statusBadge(agent.status, agent.resolved.harness === 'bedrock')}
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
          {!effectiveBedrock && (
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
          )}
          <div>
            <Label htmlFor={`model-${agent.slug}`}>Model</Label>
            <Input
              id={`model-${agent.slug}`}
              className={isBedrock ? 'mt-1 w-80' : 'mt-1 w-56'}
              value={model}
              placeholder={
                isBedrock
                  ? agent.resolved.model || 'eu.anthropic.claude-haiku-4-5-20251001-v1:0'
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
          {!effectiveBedrock && (
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
          )}
          <Button onClick={save} disabled={!dirty || update.isPending} className="ml-auto">
            {saved ? <Check className="mr-1 h-4 w-4" /> : null}
            {saved ? 'Saved' : update.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>

        {isBedrock && (
          <p className="text-xs text-muted-foreground">
            Runs via AWS Bedrock ON THE SERVER — no desktop app, CLI, or personal AWS
            credentials involved; the backend’s own AWS role makes the model calls. Bedrock
            agents use the chat, workspace, and connector tools — never anyone’s local shell or
            files. Enter a Bedrock model id or inference-profile ARN above (e.g. a Claude,
            Llama, or Mistral model).
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
