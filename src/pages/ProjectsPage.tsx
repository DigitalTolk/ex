import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Check, FolderKanban, Images, Plus } from 'lucide-react';
import { PageContainer } from '@/components/layout/PageContainer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useCreateProject, useProjects, type ProjectSummary } from '@/hooks/useProjects';
import { formatRelative } from '@/lib/format';
import { isStale } from '@/lib/project-screens';

// ProjectsPage lists the team's products with their design references
// (plan-projects-design.md §1). A project here is the same one coding tasks
// learn: its repos plus what the design agent copies from — app link, notes
// and labelled screenshots of real pages.
export default function ProjectsPage() {
  useDocumentTitle('Projects');
  const { data: projects, isLoading } = useProjects();
  const [creating, setCreating] = useState(false);
  const all = projects ?? [];

  return (
    <PageContainer
      title="Projects"
      description="Your products and what they look like. The design agent copies these screenshots and notes so mockups match the real app — pick a project in chat with /."
      actions={
        !creating && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" />
            New project
          </Button>
        )
      }
    >
      {creating && (
        <div className="mb-5">
          <CreateProjectForm onDone={() => setCreating(false)} />
        </div>
      )}

      {isLoading && (
        <div className="space-y-2" data-testid="projects-loading">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[68px] w-full rounded-xl" />
          ))}
        </div>
      )}

      {!isLoading && all.length === 0 && !creating && (
        <div className="py-12 text-center text-muted-foreground" data-testid="projects-empty">
          <FolderKanban className="mx-auto mb-3 h-8 w-8" aria-hidden="true" />
          <p>No projects yet. Add one, upload a few screenshots of its main pages, and the design agent can mock up changes that look like it.</p>
        </div>
      )}

      {all.length > 0 && (
        <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
          {all.map((p) => (
            <ProjectRow key={p.key} project={p} />
          ))}
        </div>
      )}
    </PageContainer>
  );
}

function ProjectRow({ project }: { project: ProjectSummary }) {
  const stale = isStale(project.oldestScreenAt, new Date());
  return (
    <Link
      to={`/projects/${encodeURIComponent(project.key)}`}
      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted"
      data-testid={`project-row-${project.key}`}
    >
      <FolderKanban className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{project.name}</div>
        <div className="truncate text-sm text-muted-foreground">
          {project.description || project.appURL || 'No description yet'}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5 text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Images className="h-4 w-4" aria-hidden="true" />
          {project.screenCount} {project.screenCount === 1 ? 'screen' : 'screens'}
        </span>
        {project.oldestScreenAt && (
          <span className={stale ? 'text-pinned' : undefined}>
            {stale ? 'Oldest may be outdated' : `Oldest ${formatRelative(project.oldestScreenAt)}`}
          </span>
        )}
      </div>
    </Link>
  );
}

function CreateProjectForm({ onDone }: { onDone: () => void }) {
  const create = useCreateProject();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [appURL, setAppURL] = useState('');
  const [description, setDescription] = useState('');

  const save = () => {
    create.mutate(
      { name: name.trim(), appURL: appURL.trim(), description: description.trim() },
      { onSuccess: (res) => navigate(`/projects/${encodeURIComponent(res.project.key)}`) },
    );
  };

  return (
    <div className="space-y-3 rounded-xl border border-border/60 bg-card p-4" data-testid="project-create-form">
      <div className="flex flex-wrap gap-3">
        <div className="min-w-48 flex-1">
          <Label htmlFor="project-name">Product name</Label>
          <Input
            id="project-name"
            className="mt-1"
            value={name}
            placeholder="Booking Portal"
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="min-w-64 flex-[2]">
          <Label htmlFor="project-app-url">App link</Label>
          <Input
            id="project-app-url"
            className="mt-1"
            value={appURL}
            placeholder="https://staging.example.com"
            onChange={(e) => setAppURL(e.target.value)}
          />
        </div>
      </div>
      <div>
        <Label htmlFor="project-description">What it is and who uses it</Label>
        <Input
          id="project-description"
          className="mt-1"
          value={description}
          placeholder="Clients book interpreters; admins assign and track bookings."
          maxLength={2000}
          onChange={(e) => setDescription(e.target.value)}
        />
        <p className="mt-0.5 text-sm text-muted-foreground">
          The agent uses this for realistic placeholder content in mockups.
        </p>
      </div>
      {create.isError && (
        <p className="text-sm text-destructive" role="alert">
          Couldn&apos;t create the project{create.error instanceof Error ? `: ${create.error.message}` : ''}.
        </p>
      )}
      <div className="flex gap-2">
        <Button onClick={save} disabled={!name.trim() || create.isPending}>
          <Check aria-hidden="true" />
          {create.isPending ? 'Creating…' : 'Create project'}
        </Button>
        <Button variant="ghost" onClick={onDone} disabled={create.isPending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
