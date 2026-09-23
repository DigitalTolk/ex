import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Check, ChevronDown, ChevronRight } from 'lucide-react';
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

// The card is PROGRESSIVE, twice over: collapsed it is ONE row (name, status,
// what's customized), so the page reads as a roster; expanded it leads with
// the prompt (the thing people actually tweak) and folds everything else into
// "Advanced". The prompt editor holds the EFFECTIVE text — the workspace
// default appears as real, editable words, so personalizing is "change a
// sentence", not "write from scratch". An edit that lands back on the default
// is stored as inherit, so future default improvements keep flowing to users
// who never really diverged.
export function AgentCard({ agent }: { agent: AgentView }) {
  const [open, setOpen] = useState(false);
  const update = useUpdateAgentPrefs();
  const defaultPersona = agent.defaultPersona ?? agent.resolved.persona ?? '';
  // resolved.persona IS the effective prompt (the caller's override when one
  // exists, else the workspace default).
  const [persona, setPersona] = useState(agent.resolved.persona ?? '');
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

  // What the prompt editor would STORE: text matching the workspace default
  // means "inherit" — an explicit copy of the default is a trap that silently
  // pins the user to today's wording.
  const personaToStore = persona.trim() === defaultPersona.trim() ? '' : persona;
  const customized = personaToStore !== '';

  // Advanced opens itself when something in it is already customized — a
  // collapsed section must never hide active overrides.
  const overrideCount = useMemo(
    () =>
      [
        agent.prefs.harness,
        agent.prefs.model,
        agent.prefs.offlinePolicy,
        agent.prefs.followUpMode,
        agent.prefs.limits?.maxChainRounds ? 'rounds' : '',
        (agent.prefs.autoAllow ?? []).length > 0 ? 'allow' : '',
      ].filter(Boolean).length,
    [agent.prefs],
  );
  const [showAdvanced, setShowAdvanced] = useState(overrideCount > 0);

  const isBedrock = harness === 'bedrock';
  // The EFFECTIVE backend decides which controls make sense: with the select
  // on "default", the workspace default (resolved) is what actually runs.
  // Server-run bedrock agents have no desktop app to be offline and no local
  // harness tools to pre-approve — those controls would be noise-shaped lies.
  const effectiveBedrock = (harness || agent.resolved.harness) === 'bedrock';

  const dirty =
    personaToStore !== (agent.prefs.persona ?? '') ||
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
          persona: personaToStore,
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
    <div className="rounded-lg border" data-testid={`agent-card-${agent.slug}`}>
      <button
        type="button"
        className="flex w-full flex-wrap items-center gap-2 p-3 text-left hover:bg-accent/40"
        aria-expanded={open}
        aria-label={`Configure @${agent.displayName}`}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="font-semibold">@{agent.displayName}</span>
        {statusBadge(agent.status, agent.resolved.harness === 'bedrock')}
        {customized && <Badge variant="outline">custom prompt</Badge>}
        {overrideCount > 0 && <Badge variant="outline">{overrideCount} customized</Badge>}
        <span className="ml-auto text-xs text-muted-foreground">
          for you: {agent.resolved.harness}
          {agent.resolved.model ? ` · ${agent.resolved.model}` : ''}
        </span>
      </button>

      {/* CLI agents execute on the user's own computer — invisible mechanics
          from a browser or phone, so a non-active CLI agent explains itself
          and names the cloud alternative. */}
      {(agent.status === 'offline' || agent.status === 'needs_setup') && agent.resolved.harness !== 'bedrock' && (
        <p
          className="border-t bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-muted-foreground"
          data-testid={`agent-cli-note-${agent.slug}`}
        >
          @{agent.displayName} uses the <span className="font-medium">{agent.resolved.harness} CLI</span>, so it runs
          on <span className="font-medium">your own computer</span> — it needs the ex desktop app open and signed in,
          with the {agent.resolved.harness} CLI installed and logged in there.
          {agent.status === 'needs_setup'
            ? ' Your desktop app is online but that CLI is missing or not signed in.'
            : ' Your desktop app is not running right now.'}{' '}
          From the web or mobile, use the <span className="font-medium">Bedrock</span> agents instead — they run in
          the cloud and need no desktop app.
        </p>
      )}

      {open && (
      <div className="space-y-2.5 border-t p-3">
        <div>
          <div className="flex items-baseline justify-between gap-2">
            <Label htmlFor={`persona-${agent.slug}`}>Prompt for @{agent.displayName}</Label>
            {customized ? (
              <button
                type="button"
                className="text-xs text-muted-foreground underline hover:text-foreground"
                onClick={() => setPersona(defaultPersona)}
              >
                Reset to workspace default
              </button>
            ) : (
              <span className="text-xs text-muted-foreground">workspace default — edit to make it yours</span>
            )}
          </div>
          <textarea
            id={`persona-${agent.slug}`}
            className="mt-1 min-h-20 w-full rounded-md border bg-transparent p-2 text-sm"
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
          />
          {customized && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Your version — applies only when <em>you</em> invoke @{agent.displayName}, from your next
              task onward.
            </p>
          )}
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            Advanced
          </button>
          <Button onClick={save} disabled={!dirty || update.isPending} className="ml-auto">
            {saved ? <Check className="mr-1 h-4 w-4" /> : null}
            {saved ? 'Saved' : update.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>

        {showAdvanced && (
          <div className="space-y-3 rounded-md border bg-muted/20 p-3">
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
                <Label htmlFor={`model-${agent.slug}`}>Model</Label>
                <Input
                  id={`model-${agent.slug}`}
                  className={isBedrock ? 'mt-1 w-80' : 'mt-1 w-56'}
                  value={model}
                  placeholder={
                    isBedrock
                      ? agent.resolved.model || 'eu.anthropic.claude-opus-5'
                      : agent.resolved.model || 'harness default'
                  }
                  onChange={(e) => setModel(e.target.value)}
                />
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
            </div>

            {!effectiveBedrock && (
              <fieldset>
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

            {isBedrock && (
              <p className="text-xs text-muted-foreground">
                Runs via AWS Bedrock ON THE SERVER — no desktop app, CLI, or personal AWS
                credentials involved; the backend’s own AWS role makes the model calls. Bedrock
                agents use the chat, workspace, and connector tools — never anyone’s local shell or
                files. Enter a Bedrock model id or inference-profile ARN above (e.g. a Claude,
                Llama, or Mistral model).
              </p>
            )}
          </div>
        )}

        {update.isError && (
          <p className="text-sm text-destructive">
            Save failed{update.error instanceof Error ? `: ${update.error.message}` : ''}.
          </p>
        )}

        <WatchedChannels agent={agent} />
      </div>
      )}
    </div>
  );
}

// WatchedChannels: this agent watches channels FOR YOU — matching human
// messages (or periodic check-ins) invoke it un-mentioned, on your machine
// and quota.
