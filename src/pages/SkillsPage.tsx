import { useState } from 'react';
import { Check, Eye, EyeOff, Globe, Lock, Pencil, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { PageContainer } from '@/components/layout/PageContainer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { useAuth } from '@/context/AuthContext';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import {
  isSkillPublished,
  useCreateSkill,
  useDeleteSkill,
  useSkills,
  useUpdateSkill,
  type Skill,
  type SkillVisibility,
} from '@/hooks/useAgents';
import { useSetSkillHidden, useUserState } from '@/hooks/useUserState';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { showToast } from '@/lib/toast';

// SkillsPage: instruction packs agents pull in mid-run ("use the release-notes
// skill…"). A skill belongs to whoever made it: private by default (only you),
// or published for the whole workspace to USE — but never to edit. Your own
// skills group first; the team's published ones follow.
export default function SkillsPage() {
  useDocumentTitle('Skills');
  const { data: skills, isLoading } = useSkills();
  const { user } = useAuth();
  const [creating, setCreating] = useState(false);

  const all = skills ?? [];
  const mine = all.filter((s) => s.createdBy === user?.id);
  const theirs = all.filter((s) => s.createdBy !== user?.id);
  // Who added each shared skill, and which ones this user hid from their
  // agents' discovery index.
  const { map: authors } = useUsersBatch(theirs.map((s) => s.createdBy));
  // useUserState carries placeholderData, so data is never undefined.
  const { data: userState } = useUserState();
  const hiddenSkills = new Set(userState!.hiddenSkills);

  return (
    <PageContainer
      title="Skills"
      description="Reusable instruction packs for agents. The switch on each row sets whether YOUR agents discover it on their own — an explicit /skill pick always works."
      actions={
        !creating && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" />
            New skill
          </Button>
        )
      }
    >
      {creating && (
        <div className="mb-5">
          <SkillForm onDone={() => setCreating(false)} />
        </div>
      )}

      {isLoading && (
        <div className="space-y-2" data-testid="skills-loading">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[68px] w-full rounded-xl" />
          ))}
        </div>
      )}

      {!isLoading && all.length === 0 && !creating && (
        <div className="py-12 text-center text-muted-foreground" data-testid="skills-empty">
          <Sparkles className="mx-auto mb-3 h-8 w-8" />
          <p>No skills yet. Create one — e.g. a “release-notes” pack with your team’s format.</p>
        </div>
      )}

      <div className="space-y-6">
        {mine.length > 0 && (
          <Section title="Your skills" count={mine.length}>
            {mine.map((sk) => (
              <SkillRow key={sk.id} skill={sk} own hidden={hiddenSkills.has(sk.id)} />
            ))}
          </Section>
        )}
        {theirs.length > 0 && (
          <Section title="Shared by the team" count={theirs.length}>
            {theirs.map((sk) => (
              <SkillRow
                key={sk.id}
                skill={sk}
                own={false}
                hidden={hiddenSkills.has(sk.id)}
                addedBy={authors.get(sk.createdBy)?.displayName}
              />
            ))}
          </Section>
        )}
      </div>
    </PageContainer>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 px-1 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
        {title} <span className="text-muted-foreground/60">({count})</span>
      </h2>
      <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
        {children}
      </div>
    </section>
  );
}

// SkillForm creates a new skill (with a visibility choice) or edits an existing
// one. Editing never touches visibility — publishing is a separate, explicit
// toggle on the row — so the edit patch stays name/description/instructions.
function SkillForm({ skill, onDone }: { skill?: Skill; onDone: () => void }) {
  const create = useCreateSkill();
  const update = useUpdateSkill();
  const [name, setName] = useState(skill?.name ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [instructions, setInstructions] = useState(skill?.instructions ?? '');
  const [visibility, setVisibility] = useState<SkillVisibility>('private');
  const pending = create.isPending || update.isPending;
  const valid = name.trim() && description.trim() && instructions.trim();

  const save = () => {
    const done = { onSuccess: onDone };
    if (skill) {
      update.mutate({ id: skill.id, patch: { name, description, instructions } }, done);
    } else {
      create.mutate({ name, description, instructions, visibility }, done);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-border/60 bg-card p-4" data-testid="skill-form">
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
      {!skill && (
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">Visibility</legend>
          <div className="flex flex-wrap gap-2">
            <VisibilityChoice
              active={visibility === 'private'}
              onClick={() => setVisibility('private')}
              icon={<Lock className="h-3.5 w-3.5" aria-hidden="true" />}
              title="Private"
              blurb="Only you can see and use it"
            />
            <VisibilityChoice
              active={visibility === 'published'}
              onClick={() => setVisibility('published')}
              icon={<Globe className="h-3.5 w-3.5" aria-hidden="true" />}
              title="Published"
              blurb="The whole workspace can use it"
            />
          </div>
        </fieldset>
      )}
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
          <Check aria-hidden="true" />
          {pending ? 'Saving…' : skill ? 'Save changes' : 'Create skill'}
        </Button>
        <Button variant="ghost" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// VisibilityChoice is one option in the create form's Private/Published picker.
function VisibilityChoice({
  active,
  onClick,
  icon,
  title,
  blurb,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  blurb: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={
        'flex min-w-52 flex-1 items-start gap-2 rounded-lg border p-2.5 text-left transition-colors ' +
        (active ? 'border-primary/60 bg-primary/5' : 'border-border/60 hover:bg-muted')
      }
    >
      <span className={'mt-0.5 ' + (active ? 'text-primary' : 'text-muted-foreground')}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{blurb}</span>
      </span>
    </button>
  );
}

// VisibilityBadge names a skill's current state: a lock for private, a globe
// for published. Shown on your own skills (the team's are all published).
function VisibilityBadge({ published }: { published: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      {published ? (
        <Globe className="h-3 w-3" aria-hidden="true" />
      ) : (
        <Lock className="h-3 w-3" aria-hidden="true" />
      )}
      {published ? 'Published' : 'Private'}
    </span>
  );
}

function SkillRow({ skill, own, hidden, addedBy }: { skill: Skill; own: boolean; hidden: boolean; addedBy?: string }) {
  const del = useDeleteSkill();
  const update = useUpdateSkill();
  const setHidden = useSetSkillHidden();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const published = isSkillPublished(skill);

  if (editing) {
    return (
      <div className="p-4">
        <SkillForm skill={skill} onDone={() => setEditing(false)} />
      </div>
    );
  }

  const togglePublish = () =>
    update.mutate(
      { id: skill.id, patch: { visibility: published ? 'private' : 'published' } },
      { onError: () => showToast("Couldn't change who can use that skill — try again.") },
    );

  const toggleDiscovery = () =>
    setHidden.mutate(
      { id: skill.id, hidden: !hidden },
      { onError: () => showToast("Couldn't change skill discovery — try again.") },
    );

  return (
    <div className="px-4 py-3" data-testid={`skill-card-${skill.name}`}>
      <div className="flex items-start gap-3">
        <div
          aria-hidden="true"
          className={
            'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground' +
            (hidden ? ' opacity-50' : '')
          }
        >
          {hidden ? <EyeOff className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          {/* Line 1: identity left, controls right — one action cluster, no
              text buttons. The discovery switch is the row's ONE always-on
              control; owner actions are compact icons behind tooltips. */}
          <div className="flex items-center gap-2">
            <span className={'truncate font-medium' + (hidden ? ' text-muted-foreground' : '')}>{skill.name}</span>
            {own && <VisibilityBadge published={published} />}
            {!confirmDelete && (
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <TooltipIconButton
                  label={
                    hidden
                      ? `Hidden from your agents — show ${skill.name} again`
                      : `Hide ${skill.name} from your agents (a /skill pick still works)`
                  }
                  pressed={!hidden}
                  testId={`skill-discovery-${skill.name}`}
                  disabled={setHidden.isPending}
                  onClick={toggleDiscovery}
                >
                  {hidden ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                </TooltipIconButton>
                {own && (
                  <>
                    <TooltipIconButton
                      label={published ? 'Make private' : 'Publish'}
                      disabled={update.isPending}
                      onClick={togglePublish}
                    >
                      {published ? <Lock aria-hidden="true" /> : <Globe aria-hidden="true" />}
                    </TooltipIconButton>
                    <TooltipIconButton label={`Edit ${skill.name}`} onClick={() => setEditing(true)}>
                      <Pencil aria-hidden="true" />
                    </TooltipIconButton>
                    <TooltipIconButton
                      label={`Delete ${skill.name}`}
                      className="hover:text-destructive"
                      onClick={() => setConfirmDelete(true)}
                    >
                      <Trash2 aria-hidden="true" />
                    </TooltipIconButton>
                  </>
                )}
              </div>
            )}
            {own && confirmDelete && (
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  disabled={del.isPending}
                  onClick={() =>
                    del.mutate(skill.id, {
                      onError: () => showToast("Couldn't delete that skill — try again."),
                    })
                  }
                  className="rounded-md border border-destructive/40 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                >
                  Delete “{skill.name}”?
                </button>
                <TooltipIconButton label="Cancel delete" onClick={() => setConfirmDelete(false)}>
                  <X aria-hidden="true" />
                </TooltipIconButton>
              </div>
            )}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">{skill.description}</p>
          {/* Line 3: quiet provenance, out of the title line's way. */}
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground/80">
            {!own && addedBy && (
              <>
                <span data-testid={`skill-author-${skill.name}`}>added by {addedBy}</span>
                <span aria-hidden="true">·</span>
              </>
            )}
            <span>updated {new Date(skill.updatedAt).toLocaleDateString()}</span>
            {hidden && (
              <>
                <span aria-hidden="true">·</span>
                <span>hidden from your agents</span>
              </>
            )}
          </p>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">
              Instructions
            </summary>
            <pre className="mt-1.5 max-h-64 overflow-auto rounded bg-muted/50 p-2.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
              {skill.instructions}
            </pre>
          </details>
        </div>
      </div>
    </div>
  );
}
