import { useState } from 'react';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCreateAgent } from '@/hooks/useAgents';

// starterPersona is a REAL, editable starting prompt — not a ghost
// placeholder. New agents begin from working words the creator tweaks
// gradually, instead of a blank box and a blinking cursor.
function starterPersona(name: string) {
  return (
    `You are @${name || 'this-agent'}, a helpful teammate in this workspace. ` +
    `Answer with what the thread actually needs — concise, concrete, with links to your sources. ` +
    `Read the referenced threads and documents before answering, and say plainly what you could not ` +
    `verify instead of guessing.`
  );
}

// Progressive: handle, name and the prompt are the whole form; backend and
// model live behind Advanced (the defaults — Claude Code, backend-default
// model — are right for almost every new agent).
export function NewAgentForm({ onDone }: { onDone: () => void }) {
  const create = useCreateAgent();
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [harness, setHarness] = useState('claude');
  const [model, setModel] = useState('');
  // The prompt tracks the handle while untouched ("You are @researcher…"),
  // then becomes the creator's own the moment they edit it.
  const [personaEdit, setPersonaEdit] = useState<string | null>(null);
  const persona = personaEdit ?? starterPersona(slug);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const isBedrock = harness === 'bedrock';
  const valid = /^[a-z][a-z0-9-]{1,31}$/.test(slug) && persona.trim().length > 0;

  const save = () => {
    create.mutate(
      {
        slug,
        displayName,
        harness,
        model,
        // Bedrock agents always run server-side; nothing to choose.
        executionMode: '',
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
      </div>
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <Label htmlFor="new-agent-persona">Prompt (persona)</Label>
          {personaEdit !== null ? (
            <button
              type="button"
              className="text-xs text-muted-foreground underline hover:text-foreground"
              onClick={() => setPersonaEdit(null)}
            >
              Reset to starter
            </button>
          ) : (
            <span className="text-xs text-muted-foreground">starter prompt — tweak it to define this agent</span>
          )}
        </div>
        <textarea
          id="new-agent-persona"
          className="mt-1 min-h-28 w-full rounded-md border bg-transparent p-2 text-sm"
          value={persona}
          maxLength={8192}
          onChange={(e) => setPersonaEdit(e.target.value)}
        />
      </div>

      <button
        type="button"
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        aria-expanded={showAdvanced}
        onClick={() => setShowAdvanced((v) => !v)}
      >
        {showAdvanced ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        Advanced
      </button>
      {showAdvanced && (
        <div className="flex flex-wrap gap-3 rounded-md border bg-muted/20 p-3">
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
                isBedrock ? 'eu.anthropic.claude-opus-5' : 'backend default'
              }
              onChange={(e) => setModel(e.target.value)}
            />
          </div>
          {isBedrock && (
            <p className="self-end pb-2 text-xs text-muted-foreground">
              Runs on the server — no desktop app or personal AWS credentials needed.
            </p>
          )}
        </div>
      )}
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
