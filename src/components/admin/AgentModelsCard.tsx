import { useState } from 'react';
import { Cpu, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useAgentModels, useSetAgentModels } from '@/hooks/useAgentModels';
import { useWorkspaceSettings } from '@/hooks/useSettings';
import type { AgentModelOption } from '@/types';

// The engines that pick their model from a list, in the order shown, with the
// form an id must take (the server checks the same).
const ENGINES = [
  {
    harness: 'claude',
    title: 'Claude Code',
    hint: 'Claude model ids, as Claude Code takes them.',
    placeholder: 'claude-opus-5-5',
    valid: /^claude-[a-z0-9][a-z0-9.-]*$/,
  },
  {
    harness: 'bedrock',
    title: 'AWS Bedrock (EU)',
    hint: 'EU cross-region inference profiles for Claude, so runs stay in the EU.',
    placeholder: 'eu.anthropic.claude-opus-5',
    valid: /^eu\.anthropic\.claude-[a-z0-9][a-z0-9.:-]*$/,
  },
] as const;

// AgentModelsCard is the list of models agents may run on: what the agents
// page and the agent defaults above offer in their Model dropdowns. Edits stay
// on the card until Save, which sends the whole list.
export function AgentModelsCard() {
  const { isLoading } = useWorkspaceSettings();
  const saved = useAgentModels();
  // null: showing the saved list; an array: the admin's unsaved edit of it.
  const [draft, setDraft] = useState<AgentModelOption[] | null>(null);
  const save = useSetAgentModels();
  const list = draft ?? saved;

  return (
    <section className="space-y-4 rounded-lg border bg-card p-5" data-testid="agent-models-card">
      <div>
        <h2 className="flex items-center gap-1.5 text-base font-semibold">
          <Cpu className="h-4 w-4" aria-hidden="true" />
          Models
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The models agents may run on. People pick from these on the Agents page; an agent already on a model you
          remove keeps it until someone changes it.
        </p>
      </div>

      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        ENGINES.map((engine) => (
          <EngineModels
            key={engine.harness}
            engine={engine}
            models={list.filter((m) => m.harness === engine.harness)}
            onRemove={(id) => setDraft(list.filter((m) => !(m.harness === engine.harness && m.id === id)))}
            onAdd={(model) => setDraft([...list, model])}
          />
        ))
      )}

      {save.error && (
        <p className="text-sm text-destructive" role="alert">
          Couldn't save: {save.error.message}
        </p>
      )}
      {draft && (
        <div className="flex gap-2">
          <Button
            onClick={() => save.mutate(draft, { onSuccess: () => setDraft(null) })}
            disabled={save.isPending}
            data-testid="agent-models-save"
          >
            {save.isPending ? 'Saving…' : 'Save models'}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              save.reset();
              setDraft(null);
            }}
            disabled={save.isPending}
          >
            Cancel
          </Button>
        </div>
      )}
    </section>
  );
}

function EngineModels({
  engine,
  models,
  onRemove,
  onAdd,
}: {
  engine: (typeof ENGINES)[number];
  models: AgentModelOption[];
  onRemove: (id: string) => void;
  onAdd: (model: AgentModelOption) => void;
}) {
  const [id, setID] = useState('');
  const [label, setLabel] = useState('');
  const trimmed = id.trim();
  const duplicate = models.some((m) => m.id === trimmed);
  const canAdd = engine.valid.test(trimmed) && !duplicate;

  const add = () => {
    onAdd({ harness: engine.harness, id: trimmed, label: label.trim() || undefined });
    setID('');
    setLabel('');
  };

  return (
    <div className="space-y-2" data-testid={`agent-models-${engine.harness}`}>
      <div>
        <h3 className="text-sm font-semibold">{engine.title}</h3>
        <p className="text-xs text-muted-foreground">{engine.hint}</p>
      </div>
      <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60">
        {models.map((m) => (
          <li key={m.id} className="flex items-center gap-3 px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-sm">{m.label || m.id}</span>
            <code className="truncate text-xs text-muted-foreground">{m.id}</code>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${m.label || m.id}`}
              // The last one stays: a dropdown with nothing in it would leave no
              // way to pick a model.
              disabled={models.length === 1}
              onClick={() => onRemove(m.id)}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label htmlFor={`agent-model-id-${engine.harness}`} className="text-xs">
            Model id
          </Label>
          <Input
            id={`agent-model-id-${engine.harness}`}
            className="mt-1 w-72"
            value={id}
            placeholder={engine.placeholder}
            onChange={(e) => setID(e.target.value)}
            aria-invalid={trimmed !== '' && !canAdd}
          />
        </div>
        <div>
          <Label htmlFor={`agent-model-label-${engine.harness}`} className="text-xs">
            Name (optional)
          </Label>
          <Input
            id={`agent-model-label-${engine.harness}`}
            className="mt-1 w-48"
            value={label}
            maxLength={60}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <Button variant="outline" onClick={add} disabled={!canAdd} data-testid={`agent-models-add-${engine.harness}`}>
          <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
          Add
        </Button>
      </div>
      {duplicate && <p className="text-xs text-muted-foreground">{trimmed} is already listed.</p>}
    </div>
  );
}
