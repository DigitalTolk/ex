import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ImagePlus, Loader2, Monitor, Pencil, RefreshCw, Smartphone, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { uploadAttachment } from '@/hooks/useAttachments';
import {
  useAddScreen,
  useDeleteScreen,
  useUpdateScreen,
  type ScreenPatch,
  type ScreenView,
} from '@/hooks/useProjects';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { formatRelative } from '@/lib/format';
import { groupByPage, guessViewport, isStale, pageNameFromFilename, readImageSize } from '@/lib/project-screens';
import { showToast } from '@/lib/toast';

// ScreensTab is a project's reference gallery (plan-projects-design.md §2):
// screenshots of real pages, each labelled with its page name, a one-line
// description, viewport, state, who sees it and its route. The design agent
// reads the labels as a catalog and opens only the screens it needs.

type Viewport = 'desktop' | 'mobile';

// ScreenLabels is what a person writes about a screen.
interface ScreenLabels {
  page: string;
  description: string;
  viewport: Viewport;
  state: string;
  seenBy: string;
  route: string;
}

interface Draft {
  id: number;
  file: File;
  preview: string;
  page: string;
  description: string;
  viewport: Viewport;
  state: string;
  seenBy: string;
  route: string;
  saving: boolean;
  error?: string;
}

let draftSeq = 0;

export function ScreensTab({ projectKey, screens }: { projectKey: string; screens: ScreenView[] }) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const addScreen = useAddScreen(projectKey);

  const addFiles = useCallback(async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (images.length < files.length) showToast('Only images can be reference screens.');
    const next = await Promise.all(
      images.map(async (file) => {
        const { width, height } = await readImageSize(file);
        return {
          id: ++draftSeq,
          file,
          preview: URL.createObjectURL(file),
          page: pageNameFromFilename(file.name),
          description: '',
          viewport: guessViewport(file.name, width, height),
          state: '',
          seenBy: '',
          route: '',
          saving: false,
        } satisfies Draft;
      }),
    );
    if (next.length) setDrafts((d) => [...d, ...next]);
  }, []);

  // Paste a screenshot straight from the clipboard while this tab is open.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length) {
        e.preventDefault();
        void addFiles(files);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addFiles]);

  // Object URLs die with the tab.
  const draftsRef = useRef(drafts);
  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);
  useEffect(() => () => draftsRef.current.forEach((d) => URL.revokeObjectURL(d.preview)), []);

  const patchDraft = (id: number, patch: Partial<Draft>) =>
    setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  const dropDraft = (d: Draft) => {
    URL.revokeObjectURL(d.preview);
    setDrafts((ds) => ds.filter((x) => x.id !== d.id));
  };

  const saveDraft = async (d: Draft) => {
    patchDraft(d.id, { saving: true, error: undefined });
    try {
      const upload = await uploadAttachment(d.file);
      await addScreen.mutateAsync({
        page: d.page.trim(),
        description: d.description.trim(),
        viewport: d.viewport,
        state: d.state.trim(),
        seenBy: d.seenBy.trim(),
        route: d.route.trim(),
        attachmentID: upload.id,
      });
      dropDraft(d);
    } catch (e) {
      patchDraft(d.id, { saving: false, error: e instanceof Error ? e.message : 'Upload failed' });
    }
  };

  const ready = drafts.filter((d) => !d.saving && d.page.trim() && d.description.trim());

  return (
    <div className="space-y-6">
      <div
        className="rounded-xl border border-dashed border-border-strong p-4 text-center"
        data-testid="screens-dropzone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void addFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <ImagePlus className="mx-auto mb-2 h-6 w-6 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">
          Drop screenshots of the real app here, paste one, or{' '}
          <button type="button" className="underline" onClick={() => fileInput.current?.click()}>
            choose files
          </button>
          . Main pages at desktop and mobile width work best.
        </p>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          data-testid="screens-file-input"
          onChange={(e) => {
            void addFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </div>

      {drafts.length > 0 && (
        <section className="space-y-3" aria-label="New screens">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">New screens ({drafts.length})</h2>
            {ready.length > 1 && (
              <Button size="sm" onClick={() => ready.forEach((d) => void saveDraft(d))}>
                <Check aria-hidden="true" />
                Save all
              </Button>
            )}
          </div>
          {drafts.map((d) => (
            <DraftCard
              key={d.id}
              draft={d}
              onChange={(patch) => patchDraft(d.id, patch)}
              onSave={() => void saveDraft(d)}
              onDiscard={() => dropDraft(d)}
            />
          ))}
        </section>
      )}

      {screens.length === 0 && drafts.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground" data-testid="screens-empty">
          No screens yet. Without them the design agent can&apos;t match this product&apos;s look.
        </p>
      ) : (
        <Gallery projectKey={projectKey} screens={screens} />
      )}
    </div>
  );
}

function LabelFields({
  idPrefix,
  value,
  onChange,
}: {
  idPrefix: string;
  value: ScreenLabels;
  onChange: (patch: Partial<ScreenLabels>) => void;
}) {
  return (
    <div className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
      <div>
        <Label htmlFor={`${idPrefix}-page`}>Page name</Label>
        <Input
          id={`${idPrefix}-page`}
          className="mt-1"
          value={value.page}
          maxLength={80}
          placeholder="Booking detail"
          onChange={(e) => onChange({ page: e.target.value })}
        />
      </div>
      <div>
        <Label htmlFor={`${idPrefix}-viewport`}>Viewport</Label>
        <NativeSelect
          id={`${idPrefix}-viewport`}
          className="mt-1"
          value={value.viewport}
          onChange={(e) => onChange({ viewport: e.target.value as Viewport })}
        >
          <option value="desktop">Desktop</option>
          <option value="mobile">Mobile</option>
        </NativeSelect>
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor={`${idPrefix}-description`}>What this page is for and what&apos;s on it</Label>
        <Input
          id={`${idPrefix}-description`}
          className="mt-1"
          value={value.description}
          maxLength={300}
          placeholder="One booking: status, client, interpreter, timeline and actions"
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </div>
      <div>
        <Label htmlFor={`${idPrefix}-state`}>State (optional)</Label>
        <Input
          id={`${idPrefix}-state`}
          className="mt-1"
          value={value.state}
          maxLength={120}
          placeholder="default, empty, error, modal open…"
          onChange={(e) => onChange({ state: e.target.value })}
        />
      </div>
      <div>
        <Label htmlFor={`${idPrefix}-seen-by`}>Seen by (optional)</Label>
        <Input
          id={`${idPrefix}-seen-by`}
          className="mt-1"
          value={value.seenBy}
          maxLength={120}
          placeholder="admin"
          onChange={(e) => onChange({ seenBy: e.target.value })}
        />
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor={`${idPrefix}-route`}>Route (optional)</Label>
        <Input
          id={`${idPrefix}-route`}
          className="mt-1 font-mono"
          value={value.route}
          maxLength={120}
          placeholder="/bookings/:id"
          onChange={(e) => onChange({ route: e.target.value })}
        />
      </div>
    </div>
  );
}

function DraftCard({
  draft,
  onChange,
  onSave,
  onDiscard,
}: {
  draft: Draft;
  onChange: (patch: Partial<Draft>) => void;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const valid = draft.page.trim() && draft.description.trim();
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card p-3 sm:flex-row" data-testid="screen-draft">
      <img
        src={draft.preview}
        alt={`New screenshot ${draft.file.name}`}
        width={160}
        height={100}
        className="h-[100px] w-[160px] shrink-0 rounded-md border border-border object-cover object-top"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <LabelFields idPrefix={`draft-${draft.id}`} value={draft} onChange={onChange} />
        {draft.error && (
          <p className="text-sm text-destructive" role="alert">
            {draft.error}
          </p>
        )}
        <div className="flex gap-2">
          <Button size="sm" onClick={onSave} disabled={!valid || draft.saving}>
            {draft.saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
            {draft.saving ? 'Uploading…' : 'Save screen'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDiscard} disabled={draft.saving}>
            Discard
          </Button>
        </div>
      </div>
    </div>
  );
}

function Gallery({ projectKey, screens }: { projectKey: string; screens: ScreenView[] }) {
  const { map: users } = useUsersBatch(screens.map((s) => s.uploadedBy));
  const [viewing, setViewing] = useState<ScreenView | null>(null);
  const now = new Date();
  return (
    <>
      <div className="space-y-5">
        {groupByPage(screens).map((g) => (
          <section key={g.page} aria-label={g.page}>
            <h2 className="mb-2 px-1 text-sm font-medium tracking-wider text-muted-foreground uppercase">{g.page}</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {g.screens.map((sc) => (
                <ScreenCard
                  key={sc.id}
                  projectKey={projectKey}
                  screen={sc}
                  uploader={users.get(sc.uploadedBy)?.displayName}
                  stale={isStale(sc.updatedAt, now)}
                  onView={() => setViewing(sc)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
      <Dialog open={viewing !== null} onOpenChange={(open) => !open && setViewing(null)}>
        <DialogContent size="full" finalFocus={false}>
          <DialogHeader>
            <DialogTitle>
              {viewing?.page} · {viewing?.viewport}
            </DialogTitle>
          </DialogHeader>
          {viewing?.imageURL && (
            <img
              src={viewing.imageURL}
              alt={viewing.description}
              width={viewing.width || undefined}
              height={viewing.height || undefined}
              className="mx-auto h-auto max-h-[calc(100dvh-9rem)] w-auto max-w-full rounded-md object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function ScreenCard({
  projectKey,
  screen,
  uploader,
  stale,
  onView,
}: {
  projectKey: string;
  screen: ScreenView;
  uploader?: string;
  stale: boolean;
  onView: () => void;
}) {
  const update = useUpdateScreen(projectKey);
  const del = useDeleteScreen(projectKey);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const replaceInput = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState({
    page: screen.page,
    description: screen.description,
    viewport: screen.viewport as Viewport,
    state: screen.state ?? '',
    seenBy: screen.seenBy ?? '',
    route: screen.route ?? '',
  });
  const ViewportIcon = screen.viewport === 'mobile' ? Smartphone : Monitor;

  const replace = async (file: File) => {
    setReplacing(true);
    try {
      const upload = await uploadAttachment(file);
      await update.mutateAsync({ id: screen.id, patch: { attachmentID: upload.id } });
      showToast('Screenshot replaced', 'success');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Replace failed');
    } finally {
      setReplacing(false);
    }
  };

  const save = () => {
    const patch: ScreenPatch = { ...form };
    update.mutate({ id: screen.id, patch }, { onSuccess: () => setEditing(false) });
  };

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card" data-testid={`screen-${screen.id}`}>
      <button type="button" onClick={onView} className="block bg-muted" aria-label={`View ${screen.page} (${screen.viewport})`}>
        {screen.thumbnailURL || screen.imageURL ? (
          <img
            src={screen.thumbnailURL || screen.imageURL}
            alt=""
            width={screen.width || 320}
            height={screen.height || 200}
            loading="lazy"
            className="aspect-[16/10] h-auto w-full object-cover object-top"
          />
        ) : (
          <div className="flex aspect-[16/10] items-center justify-center text-sm text-muted-foreground">Image unavailable</div>
        )}
      </button>
      {editing ? (
        <div className="space-y-2 p-3">
          <LabelFields idPrefix={`screen-${screen.id}`} value={form} onChange={(p) => setForm((f) => ({ ...f, ...p }))} />
          {update.isError && (
            <p className="text-sm text-destructive" role="alert">
              Save failed{update.error instanceof Error ? `: ${update.error.message}` : ''}.
            </p>
          )}
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={update.isPending || !form.page.trim() || !form.description.trim()}>
              <Check aria-hidden="true" />
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              <X aria-hidden="true" />
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-1 p-3">
          <div className="flex items-start gap-1.5">
            <ViewportIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-label={screen.viewport} />
            <p className="min-w-0 flex-1 text-sm">{screen.description}</p>
          </div>
          <div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
            {screen.state && <span>State: {screen.state}</span>}
            {screen.seenBy && <span>Seen by: {screen.seenBy}</span>}
            {screen.route && <span className="font-mono">{screen.route}</span>}
          </div>
          <div className="mt-auto flex items-center gap-1 pt-1">
            <span className={`min-w-0 flex-1 truncate text-xs ${stale ? 'text-pinned' : 'text-muted-foreground'}`}>
              {stale ? 'May be outdated · ' : ''}
              {uploader ?? 'Someone'} · {formatRelative(screen.updatedAt)}
            </span>
            <TooltipIconButton label="Edit labels" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" />
            </TooltipIconButton>
            <TooltipIconButton label="Replace screenshot" disabled={replacing} onClick={() => replaceInput.current?.click()}>
              {replacing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </TooltipIconButton>
            <TooltipIconButton label="Delete screen" onClick={() => setConfirming(true)}>
              <Trash2 className="h-4 w-4" />
            </TooltipIconButton>
            <input
              ref={replaceInput}
              type="file"
              accept="image/*"
              className="hidden"
              data-testid={`screen-replace-${screen.id}`}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void replace(f);
              }}
            />
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete this ${screen.page} screen?`}
        description="The design agent stops using it."
        confirmLabel="Delete screen"
        destructive
        onConfirm={() => del.mutate(screen.id, { onError: (e) => showToast(e instanceof Error ? e.message : 'Delete failed') })}
      />
    </div>
  );
}
