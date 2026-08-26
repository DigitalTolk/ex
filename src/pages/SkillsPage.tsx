import { useState } from 'react';
import { Check, Pencil, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { PageContainer } from '@/components/layout/PageContainer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/context/AuthContext';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import {
  useCreateSkill,
  useDeleteSkill,
  useSkills,
  useUpdateSkill,
  type Skill,
} from '@/hooks/useAgents';

// SkillsPage: workspace skill packs — named instruction sets any agent can
// pull in mid-run ("use the release-notes skill…"). Anyone can create one;
// only the author edits or deletes theirs.
export default function SkillsPage() {
  useDocumentTitle('Skills');
  const { data: skills, isLoading } = useSkills();
  const [creating, setCreating] = useState(false);

  return (
    <PageContainer
      title="Skills"
      description="Reusable instruction packs for agents. Ask an agent to “use the <name> skill” — or let it discover them itself mid-task."
    >
      <div className="mb-4">
        {creating ? (
          <SkillForm onDone={() => setCreating(false)} />
        ) : (
          <Button onClick={() => setCreating(true)}>
            <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
            New skill
          </Button>
        )}
      </div>

      {isLoading && (
        <div className="space-y-3" data-testid="skills-loading">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      )}

      {!isLoading && (skills?.length ?? 0) === 0 && !creating && (
        <div className="py-12 text-center text-muted-foreground" data-testid="skills-empty">
          <Sparkles className="mx-auto mb-3 h-8 w-8" />
          <p>No skills yet. Create one — e.g. a “release-notes” pack with your team’s format.</p>
        </div>
      )}

      <div className="space-y-3">
        {skills?.map((sk) => <SkillCard key={sk.id} skill={sk} />)}
      </div>
    </PageContainer>
  );
}

// SkillForm creates a new skill, or edits an existing one when passed in.
function SkillForm({ skill, onDone }: { skill?: Skill; onDone: () => void }) {
  const create = useCreateSkill();
  const update = useUpdateSkill();
  const [name, setName] = useState(skill?.name ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [instructions, setInstructions] = useState(skill?.instructions ?? '');
  const pending = create.isPending || update.isPending;
  const valid = name.trim() && description.trim() && instructions.trim();

  const save = () => {
    const done = { onSuccess: onDone };
    if (skill) {
      update.mutate({ id: skill.id, patch: { name, description, instructions } }, done);
    } else {
      create.mutate({ name, description, instructions }, done);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border p-4" data-testid="skill-form">
      <div className="flex flex-wrap gap-3">
        <div className="min-w-48 flex-1">
          <Label htmlFor="skill-name">Name</Label>
          <Input
            id="skill-name"
            className="mt-1"
            value={name}
            placeholder="release-notes"
            maxLength={64}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="min-w-64 flex-[2]">
          <Label htmlFor="skill-desc">Description</Label>
          <Input
            id="skill-desc"
            className="mt-1"
            value={description}
            placeholder="When and why an agent should reach for this skill"
            maxLength={256}
            onChange={(e) => setDescription(e.target.value)}
          />
          <p className="mt-0.5 text-xs text-muted-foreground">
            Agents pick skills by this description — write it for them.
          </p>
        </div>
      </div>
      <div>
        <Label htmlFor="skill-instructions">Instructions</Label>
        <textarea
          id="skill-instructions"
          className="mt-1 min-h-32 w-full rounded-md border bg-transparent p-2 font-mono text-sm"
          value={instructions}
          placeholder={'Step-by-step instructions the agent follows when this skill is invoked…'}
          maxLength={8192}
          onChange={(e) => setInstructions(e.target.value)}
        />
        <p className="mt-0.5 text-xs text-muted-foreground">{instructions.length}/8192</p>
      </div>
      {(create.isError || update.isError) && (
        <p className="text-sm text-destructive">
          Save failed
          {create.error instanceof Error
            ? `: ${create.error.message}`
            : update.error instanceof Error
              ? `: ${update.error.message}`
              : ''}
          .
        </p>
      )}
      <div className="flex gap-2">
        <Button onClick={save} disabled={!valid || pending}>
          <Check className="mr-1 h-4 w-4" aria-hidden="true" />
          {pending ? 'Saving…' : skill ? 'Save changes' : 'Create skill'}
        </Button>
        <Button variant="outline" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function SkillCard({ skill }: { skill: Skill }) {
  const { user } = useAuth();
  const del = useDeleteSkill();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const own = skill.createdBy === user?.id;

  if (editing) {
    return <SkillForm skill={skill} onDone={() => setEditing(false)} />;
  }

  return (
    <div className="rounded-lg border p-4" data-testid={`skill-card-${skill.name}`}>
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-semibold">{skill.name}</span>
            <span className="text-xs text-muted-foreground">
              updated {new Date(skill.updatedAt).toLocaleDateString()}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">{skill.description}</p>
          <details className="mt-2">
            <summary className="cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground">
              Instructions
            </summary>
            <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2.5 font-mono text-xs leading-relaxed">
              {skill.instructions}
            </pre>
          </details>
        </div>
        {own && (
          <div className="flex shrink-0 items-center gap-1">
            {confirmDelete ? (
              <>
                <button
                  type="button"
                  disabled={del.isPending}
                  onClick={() => del.mutate(skill.id)}
                  className="rounded-md border border-red-500/40 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"
                >
                  Delete “{skill.name}”?
                </button>
                <button
                  type="button"
                  aria-label="Cancel delete"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  aria-label={`Edit ${skill.name}`}
                  onClick={() => setEditing(true)}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${skill.name}`}
                  onClick={() => setConfirmDelete(true)}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-red-500"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
