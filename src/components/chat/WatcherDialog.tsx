import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  useAgents,
  useCreateWatcher,
  useUpdateWatcher,
  useRemoveWatcher,
  WATCH_ACTION_MODES,
  type WatchActionMode,
} from '@/hooks/useAgents';
import { showToast } from '@/lib/toast';

// An existing watcher being managed: agent + thread are fixed; only the
// instruction and action mode are editable. agentName is for display.
export interface EditingWatcher {
  id: string;
  slug: string;
  agentName: string;
  instruction: string;
  actionMode: WatchActionMode;
}

interface WatcherDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // The thread this watcher attaches to (the message's thread root) and its parent.
  parentID: string;
  parentType: string;
  threadRootID: string;
  // When set (non-empty), the dialog MANAGES these existing watchers — edit
  // their standing order, switch between them, or delete — instead of adding a
  // new one. Empty/undefined = the add-a-watcher flow.
  editingList?: EditingWatcher[];
}

// WatcherDialog is the single surface for thread watchers: add one (pick agent,
// instruction, autonomy) or MANAGE existing ones (same form, prefilled, with
// Update + Delete). Mirrors the "Remind me" flow — one message action, one form.
export function WatcherDialog({ open, onOpenChange, parentID, parentType, threadRootID, editingList }: WatcherDialogProps) {
  const { data: agents } = useAgents();
  const createWatcher = useCreateWatcher();
  const updateWatcher = useUpdateWatcher();
  const removeWatcher = useRemoveWatcher();
  const usable = (agents ?? []).filter((a) => a.status === 'active');
  const isEdit = !!editingList && editingList.length > 0;

  // The dialog mounts fresh each open (parent gates it behind `open && <…/>`),
  // so state initializes straight from props — no effect. Switching which
  // watcher is selected happens in an event handler (selectWatcher), which is
  // free to setState.
  const [selectedId, setSelectedId] = useState(editingList?.[0]?.id ?? '');
  const selected = editingList?.find((w) => w.id === selectedId) ?? editingList?.[0];

  const [slug, setSlug] = useState(''); // create mode only
  const [instruction, setInstruction] = useState(selected?.instruction ?? '');
  const [actionMode, setActionMode] = useState<WatchActionMode>(selected?.actionMode ?? 'notify');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  const selectWatcher = (id: string) => {
    const w = editingList?.find((x) => x.id === id);
    setSelectedId(id);
    setInstruction(w?.instruction ?? '');
    setActionMode(w?.actionMode ?? 'notify');
    setError('');
  };

  const effectiveSlug = slug || usable[0]?.slug || '';
  const modeHint = WATCH_ACTION_MODES.find((m) => m.value === actionMode)?.hint ?? '';

  /* istanbul ignore next -- edit mode implies a non-empty editingList */
  const editCount = editingList?.length ?? 0;
  /* istanbul ignore next -- edit mode always has a selection */
  const selectedID = selected?.id ?? '';

  const confirm = async () => {
    if (!isEdit && !effectiveSlug) {
      setError('Pick an agent.');
      return;
    }
    if (!instruction.trim()) {
      setError('Tell the watcher what to watch for and do.');
      return;
    }
    setPending(true);
    setError('');
    try {
      if (isEdit && selected) {
        await updateWatcher.mutateAsync({
          slug: selected.slug,
          parentID,
          id: selected.id,
          instruction: instruction.trim(),
          actionMode,
        });
        showToast('Watcher updated.');
      } else {
        await createWatcher.mutateAsync({
          slug: effectiveSlug,
          parentID,
          parentType,
          threadRootID,
          instruction: instruction.trim(),
          actionMode,
        });
      }
      onOpenChange(false);
    } catch {
      setError(isEdit ? "Couldn't update the watcher — please try again." : "Couldn't add the watcher — please try again.");
    } finally {
      setPending(false);
    }
  };

  const remove = async () => {
    /* istanbul ignore if -- remove renders only in edit mode, where a watcher is always selected */
    if (!selected) return;
    setPending(true);
    setError('');
    try {
      await removeWatcher.mutateAsync({ slug: selected.slug, parentID, id: selected.id });
      showToast('Watcher removed.');
      onOpenChange(false);
    } catch {
      setError("Couldn't remove the watcher — please try again.");
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" data-testid="watcher-dialog">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Manage watcher' : 'Add watcher to this thread'}</DialogTitle>
          <DialogDescription>
            An agent watches this thread and acts on your standing order — on your machine, with your access.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 px-1 py-2">
          {isEdit ? (
            // Manage mode: which watcher (a picker only when several watch this
            // thread), agent name shown read-only.
            editCount > 1 ? (
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">Watcher</span>
                <select
                  aria-label="Which watcher"
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm mobile:h-11"
                  value={selectedID}
                  onChange={(e) => selectWatcher(e.target.value)}
                >
                  {editingList?.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.agentName}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <div className="text-xs text-muted-foreground">
                Watching agent: <span className="font-medium text-foreground">{selected?.agentName}</span>
              </div>
            )
          ) : (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Agent</span>
              <select
                aria-label="Watcher agent"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm mobile:h-11"
                value={effectiveSlug}
                onChange={(e) => setSlug(e.target.value)}
              >
                {usable.length === 0 && <option value="">No available agents</option>}
                {usable.map((a) => (
                  <option key={a.slug} value={a.slug}>
                    {a.displayName}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Instruction</span>
            <textarea
              aria-label="Watcher instruction"
              placeholder="e.g. DM me a heads-up if anyone asks about the deploy, or draft a reply I can send."
              className="min-h-[84px] w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={instruction}
              onChange={(e) => {
                setInstruction(e.target.value);
                setError('');
              }}
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">What it may do</span>
            <select
              aria-label="Action mode"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm mobile:h-11"
              value={actionMode}
              onChange={(e) => setActionMode(e.target.value as WatchActionMode)}
            >
              {WATCH_ACTION_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-muted-foreground">{modeHint}</span>
          </label>

          {error && (
            <p className="text-xs text-destructive" data-testid="watcher-error">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          {isEdit && (
            <Button
              variant="ghost"
              onClick={remove}
              disabled={pending}
              data-testid="watcher-delete"
              className="mr-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="mr-1.5 h-4 w-4" /> Delete watcher
            </Button>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={pending} data-testid="watcher-confirm">
            {pending ? (isEdit ? 'Saving…' : 'Adding…') : isEdit ? 'Save changes' : 'Add watcher'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
