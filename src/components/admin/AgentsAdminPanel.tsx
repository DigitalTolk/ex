import { useState } from 'react';
import { Bot, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useAgentOverrides,
  useAgents,
  useResetAgentOverrides,
  useUpdateAgentTemplate,
  type AgentView,
} from '@/hooks/useAgents';

// AgentsAdminPanel edits the WORKSPACE DEFAULT for every shared agent — the
// config a member inherits unless they have set their own on the Agents page.
//
// It lives here rather than on the agent cards because the two operations look
// identical and do opposite things: the card's Advanced section writes the
// caller's personal prefs, this writes the template. On the card, an admin
// could reasonably save Advanced and believe they had changed it for the team.
//
// It reads `default*` rather than `resolved`: resolved is the CALLER's
// effective config, so an admin who has customised an agent would otherwise be
// shown their own values labelled as everyone's.
export function AgentsAdminPanel() {
  const { data: agents, isLoading } = useAgents();

  return (
    <section className="space-y-4 rounded-lg border bg-card p-5">
      <div>
        <h2 className="flex items-center gap-1.5 text-base font-semibold">
          <Bot className="h-4 w-4" aria-hidden="true" />
          Agents
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The prompt, backend and model each shared agent uses by default. Anyone who has set
          their own on the Agents page keeps theirs — the count under each agent says how many
          that is.
        </p>
      </div>

      {isLoading && <Skeleton className="h-16 w-full" />}

      {!isLoading && !agents?.length && (
        <p className="text-sm text-muted-foreground">No shared agents yet.</p>
      )}

      <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60">
        {(agents ?? []).map((agent) => (
          <AgentTemplateRow key={agent.slug} agent={agent} />
        ))}
      </div>
    </section>
  );
}

// One agent, collapsed to a summary line until opened — a workspace with a
// dozen agents should read as a roster, not a wall of forms.
function AgentTemplateRow({ agent }: { agent: AgentView }) {
  const [open, setOpen] = useState(false);
  const update = useUpdateAgentTemplate();
  const reset = useResetAgentOverrides();
  // Only counted while the row is open: server-side this walks the roster,
  // because agent prefs are partitioned by user and have no index by agent.
  const { data: overrides, isLoading: counting } = useAgentOverrides(agent.slug, open);

  const [harness, setHarness] = useState(agent.defaultHarness || 'claude');
  const [model, setModel] = useState(agent.defaultModel ?? '');
  const [persona, setPersona] = useState(agent.defaultPersona ?? '');
  const [confirming, setConfirming] = useState(false);

  const isBedrock = harness === 'bedrock';
  const blankPersona = persona.trim() === '';
  const dirty =
    harness !== (agent.defaultHarness || 'claude') ||
    model !== (agent.defaultModel ?? '') ||
    persona.trim() !== (agent.defaultPersona ?? '').trim();

  function save() {
    update.mutate({
      slug: agent.slug,
      patch: {
        // harness must ride along: the handler skips the engine block without
        // it, so a model sent alone is accepted and silently ignored.
        harness,
        model: model.trim(),
        executionMode: isBedrock ? 'server' : '',
        persona: persona.trim(),
      },
    });
  }

  return (
    <div data-testid={`admin-agent-${agent.slug}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-muted/40"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />
        )}
        <span className="font-medium">@{agent.slug}</span>
        <span className="ml-auto truncate text-xs text-muted-foreground">
          {agent.defaultHarness || 'claude'}
          {agent.defaultModel ? ` · ${agent.defaultModel}` : ''}
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-border/60 bg-muted/20 px-3 py-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor={`admin-harness-${agent.slug}`}>Backend</Label>
              <select
                id={`admin-harness-${agent.slug}`}
                value={harness}
                onChange={(e) => setHarness(e.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="claude">Claude Code (each person’s machine)</option>
                <option value="codex">Codex (each person’s machine)</option>
                <option value="bedrock">AWS Bedrock (server)</option>
              </select>
            </div>
            <div>
              <Label htmlFor={`admin-model-${agent.slug}`}>Model</Label>
              <Input
                id={`admin-model-${agent.slug}`}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={isBedrock ? 'eu.anthropic.claude-opus-5' : 'claude-opus-5'}
                className="mt-1"
              />
            </div>
          </div>

          {isBedrock && (
            <p className="text-xs text-muted-foreground">
              Bedrock ids are not validated here — a wrong one fails at run time as
              “bedrock_error”. Paste the inference-profile id exactly as Bedrock lists it for the
              backend’s region. Bedrock agents always run on the server.
            </p>
          )}

          <div>
            <Label htmlFor={`admin-persona-${agent.slug}`}>Prompt</Label>
            <textarea
              id={`admin-persona-${agent.slug}`}
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              rows={6}
              className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs leading-relaxed"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {/* The agents page pre-fills each member's editor with the
                  EFFECTIVE prompt and stores "inherit" when an edit lands back
                  on this text — so improving it here reaches everyone who
                  never really diverged, not only people who never opened it. */}
              Inherited by anyone who has not written their own. It cannot be left empty.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={save} disabled={update.isPending || !dirty || blankPersona}>
              {update.isPending ? 'Saving…' : 'Save default'}
            </Button>
            {update.isSuccess && !update.isPending && !dirty && (
              <span className="text-xs text-muted-foreground" aria-live="polite">
                Saved.
              </span>
            )}
            {update.isError && (
              <span className="text-xs text-destructive" role="alert">
                {update.error instanceof Error ? update.error.message : 'Save failed'}
              </span>
            )}
          </div>

          <p className="text-xs text-muted-foreground" data-testid={`admin-overrides-${agent.slug}`}>
            {counting
              ? 'Checking who has their own settings…'
              : overrides === undefined
                ? 'Could not check who has their own settings.'
                : overrides === 0
                  ? 'Nobody has their own settings — this default reaches everyone.'
                  : `${overrides} ${overrides === 1 ? 'person has' : 'people have'} their own settings, which win over this default.`}
          </p>

          {!!overrides && !confirming && (
            <Button
              size="sm"
              variant="outline"
              className="text-destructive hover:bg-destructive/10"
              onClick={() => setConfirming(true)}
            >
              Reset everyone’s settings…
            </Button>
          )}

          {confirming && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2">
              {/* Spelled out because a prefs row is ONE document: an admin here
                  to standardise a model would not expect to wipe people's
                  prompts and pre-approved tool classes as well. */}
              <p className="text-xs">
                This clears each person’s prompt, model, limits, follow-up settings and
                pre-approved tool classes for @{agent.slug}. It cannot be undone.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={reset.isPending}
                  onClick={() => reset.mutate(agent.slug, { onSuccess: () => setConfirming(false) })}
                >
                  {reset.isPending ? 'Resetting…' : `Reset ${overrides} people’s settings`}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
              {reset.isError && (
                <p className="mt-1 text-xs text-destructive" role="alert">
                  {reset.error instanceof Error ? reset.error.message : 'Reset failed'}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
