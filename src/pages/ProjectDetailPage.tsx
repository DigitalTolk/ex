import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Check, ExternalLink, Plus, Trash2, X } from 'lucide-react';
import { PageContainer } from '@/components/layout/PageContainer';
import { ScreensTab } from '@/components/projects/ScreensTab';
import { ThemeCard, UiLibraryCard } from '@/components/projects/DesignSystemCards';
import { Button, buttonVariants } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useDeleteProject, useProject, useUpdateProject, type ProjectDetail } from '@/hooks/useProjects';
import { DESIGN_NOTES_TEMPLATE } from '@/lib/project-screens';
import { showToast } from '@/lib/toast';
import type { ProjectLink, ProjectRepo } from '@/types/generated';

// ProjectDetailPage is one product's design references
// (plan-projects-design.md §1): Overview (identity, app link, description,
// links), Screens (the screenshot gallery the design agent copies), Design
// notes (fonts, colors, gotchas) and Repos (what coding tasks clone).

const TABS = [
  { id: 'screens', label: 'Screens' },
  { id: 'notes', label: 'Design notes' },
  { id: 'overview', label: 'Overview' },
  { id: 'repos', label: 'Repos' },
] as const;
type TabID = (typeof TABS)[number]['id'];

export default function ProjectDetailPage() {
  const { key } = useParams<{ key: string }>();
  const { data, isLoading, isError } = useProject(key);
  const [tab, setTab] = useState<TabID>('screens');
  useDocumentTitle(data?.project.name ?? 'Project');

  if (isLoading) {
    return (
      <PageContainer title="Project">
        <Skeleton className="h-40 w-full rounded-xl" data-testid="project-loading" />
      </PageContainer>
    );
  }
  if (isError || !data) {
    return (
      <PageContainer title="Project not found">
        <p className="text-sm text-muted-foreground">
          This project doesn&apos;t exist or was deleted. <Link className="underline" to="/projects">Back to projects</Link>
        </p>
      </PageContainer>
    );
  }

  const { project } = data;
  return (
    <PageContainer
      title={project.name}
      description={project.description || undefined}
      actions={<HeaderActions detail={data} />}
    >
      <Link to="/projects" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        All projects
      </Link>
      <div role="tablist" aria-label="Project sections" className="mb-4 flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`project-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`project-panel-${t.id}`}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors ${
              tab === t.id
                ? 'border-primary font-semibold text-foreground'
                : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'
            }`}
          >
            {t.label}
            {t.id === 'screens' && <span className="ml-1 text-muted-foreground">({data.screens.length})</span>}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`project-panel-${tab}`} aria-labelledby={`project-tab-${tab}`}>
        {tab === 'screens' && <ScreensTab projectKey={project.key} screens={data.screens} />}
        {tab === 'notes' && <NotesTab detail={data} />}
        {tab === 'overview' && <OverviewTab detail={data} />}
        {tab === 'repos' && <ReposTab detail={data} />}
      </div>
    </PageContainer>
  );
}

function HeaderActions({ detail }: { detail: ProjectDetail }) {
  const { project, canManage } = detail;
  const del = useDeleteProject();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex items-center gap-1">
      {project.appURL && (
        <a
          href={project.appURL}
          target="_blank"
          rel="noreferrer noopener"
          className={buttonVariants({ variant: 'ghost', size: 'sm' })}
        >
          <ExternalLink aria-hidden="true" />
          Open app
        </a>
      )}
      {canManage && (
        <>
          <TooltipIconButton label="Delete project" onClick={() => setConfirming(true)} testId="project-delete">
            <Trash2 className="h-4 w-4" />
          </TooltipIconButton>
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title={`Delete ${project.name}?`}
            description="Its screenshots and notes are removed. Coding tasks already made for it keep their own copy."
            confirmLabel="Delete project"
            destructive
            onConfirm={() =>
              del.mutate(project.key, {
                onSuccess: () => navigate('/projects'),
                onError: (e) => showToast(e instanceof Error ? e.message : 'Delete failed'),
              })
            }
          />
        </>
      )}
    </div>
  );
}

function SaveRow({ pending, dirty, onSave, error }: { pending: boolean; dirty: boolean; onSave: () => void; error: unknown }) {
  return (
    <div className="flex items-center gap-3">
      <Button onClick={onSave} disabled={!dirty || pending}>
        <Check aria-hidden="true" />
        {pending ? 'Saving…' : 'Save'}
      </Button>
      {error != null && (
        <p className="text-sm text-destructive" role="alert">
          Save failed{error instanceof Error ? `: ${error.message}` : ''}.
        </p>
      )}
    </div>
  );
}

function NotesTab({ detail }: { detail: ProjectDetail }) {
  const { project } = detail;
  const update = useUpdateProject(project.key);
  const saved = project.designNotes ?? '';
  const [notes, setNotes] = useState(saved || DESIGN_NOTES_TEMPLATE);
  return (
    <div className="space-y-3">
      <UiLibraryCard detail={detail} />
      <ThemeCard detail={detail} />
      <p className="text-sm text-muted-foreground">
        What screenshots and the stylesheet can&apos;t say: rules, conventions, and what the agent keeps getting wrong.
      </p>
      <Label htmlFor="project-notes" className="sr-only">
        Design notes
      </Label>
      <textarea
        id="project-notes"
        className="min-h-72 w-full rounded-md border bg-transparent p-2 font-mono text-sm"
        value={notes}
        maxLength={8000}
        onChange={(e) => setNotes(e.target.value)}
      />
      <p className="text-sm text-muted-foreground">{notes.length}/8000</p>
      <SaveRow
        pending={update.isPending}
        dirty={notes.trim() !== saved.trim() && notes.trim() !== DESIGN_NOTES_TEMPLATE.trim()}
        onSave={() => update.mutate({ designNotes: notes }, { onSuccess: () => showToast('Design notes saved', 'success') })}
        error={update.error}
      />
    </div>
  );
}

function OverviewTab({ detail }: { detail: ProjectDetail }) {
  const { project, canManage } = detail;
  const update = useUpdateProject(project.key);
  const [name, setName] = useState(project.name);
  const [appURL, setAppURL] = useState(project.appURL ?? '');
  const [description, setDescription] = useState(project.description ?? '');
  const [links, setLinks] = useState<ProjectLink[]>(project.links ?? []);
  const dirty =
    name !== project.name ||
    appURL !== (project.appURL ?? '') ||
    description !== (project.description ?? '') ||
    JSON.stringify(links) !== JSON.stringify(project.links ?? []);

  const save = () => {
    const patch = { appURL, description, links: links.filter((l) => l.url.trim()) };
    update.mutate(canManage && name !== project.name ? { ...patch, name } : patch, {
      onSuccess: () => showToast('Project saved', 'success'),
    });
  };

  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <Label htmlFor="overview-name">Product name</Label>
        <Input
          id="overview-name"
          className="mt-1"
          value={name}
          maxLength={80}
          disabled={!canManage}
          onChange={(e) => setName(e.target.value)}
        />
        {!canManage && (
          <p className="mt-0.5 text-sm text-muted-foreground">Only the project&apos;s creator or an admin can rename it.</p>
        )}
      </div>
      <div>
        <Label htmlFor="overview-app-url">App link</Label>
        <Input
          id="overview-app-url"
          className="mt-1"
          value={appURL}
          placeholder="https://staging.example.com"
          onChange={(e) => setAppURL(e.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="overview-description">What it is and who uses it</Label>
        <textarea
          id="overview-description"
          className="mt-1 min-h-24 w-full rounded-md border bg-transparent p-2 text-sm"
          value={description}
          maxLength={2000}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Links (Figma, style guide, Storybook…)</legend>
        {links.map((l, i) => (
          <div key={i} className="flex gap-2">
            <Input
              aria-label={`Link ${i + 1} label`}
              className="w-40"
              value={l.label}
              placeholder="Figma"
              onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
            />
            <Input
              aria-label={`Link ${i + 1} URL`}
              className="flex-1"
              value={l.url}
              placeholder="https://"
              onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
            />
            <TooltipIconButton label={`Remove link ${i + 1}`} onClick={() => setLinks(links.filter((_, j) => j !== i))}>
              <X className="h-4 w-4" />
            </TooltipIconButton>
          </div>
        ))}
        {links.length < 10 && (
          <Button size="sm" variant="ghost" onClick={() => setLinks([...links, { label: '', url: '' }])}>
            <Plus aria-hidden="true" />
            Add link
          </Button>
        )}
      </fieldset>
      <SaveRow pending={update.isPending} dirty={dirty} onSave={save} error={update.error} />
    </div>
  );
}

const ROLES: ProjectRepo['role'][] = ['frontend', 'backend', 'mobile', 'infra', 'other'];

function ReposTab({ detail }: { detail: ProjectDetail }) {
  const { project, canManage } = detail;
  const update = useUpdateProject(project.key);
  const [repos, setRepos] = useState<ProjectRepo[]>(project.repos ?? []);
  const dirty = JSON.stringify(repos) !== JSON.stringify(project.repos ?? []);

  if (!canManage) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          The GitLab repos coding tasks use for this product. Only the project&apos;s creator or an admin can change them.
        </p>
        {repos.length === 0 ? (
          <p className="text-sm text-muted-foreground">No repos yet — the dev agent adds them on the first coding task.</p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-xl border border-border/60 bg-card">
            {repos.map((r) => (
              <li key={r.path} className="flex items-center justify-between px-4 py-2 text-sm">
                <span className="font-mono">{r.path}</span>
                <span className="text-muted-foreground">{r.role}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-3">
      <p className="text-sm text-muted-foreground">
        The GitLab repos coding tasks clone for this product. The dev agent also adds repos it learns.
      </p>
      {repos.map((r, i) => (
        <div key={i} className="flex gap-2">
          <Input
            aria-label={`Repo ${i + 1} path`}
            className="flex-1 font-mono"
            value={r.path}
            placeholder="group/subgroup/repo"
            onChange={(e) => setRepos(repos.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))}
          />
          <NativeSelect
            aria-label={`Repo ${i + 1} role`}
            className="w-36"
            value={r.role}
            onChange={(e) => setRepos(repos.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))}
          >
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </NativeSelect>
          <TooltipIconButton label={`Remove repo ${i + 1}`} onClick={() => setRepos(repos.filter((_, j) => j !== i))}>
            <X className="h-4 w-4" />
          </TooltipIconButton>
        </div>
      ))}
      <Button size="sm" variant="ghost" onClick={() => setRepos([...repos, { path: '', role: 'frontend' }])}>
        <Plus aria-hidden="true" />
        Add repo
      </Button>
      <SaveRow
        pending={update.isPending}
        dirty={dirty}
        onSave={() =>
          update.mutate({ repos: repos.filter((r) => r.path.trim()) }, { onSuccess: () => showToast('Repos saved', 'success') })
        }
        error={update.error}
      />
    </div>
  );
}
