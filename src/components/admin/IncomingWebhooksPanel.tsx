import { useMemo, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useBrowseChannels, useUserChannels } from '@/hooks/useChannels';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import {
  useCreateIncomingWebhook,
  useDeleteIncomingWebhook,
  useIncomingWebhooks,
  useUpdateIncomingWebhook,
} from '@/hooks/useWebhooks';
import type { IncomingWebhook } from '@/types';

const EMPTY_FORM = {
  title: '',
  description: '',
  channelID: '',
  lockToChannel: true,
  username: '',
  profileImageURL: '',
};

export function IncomingWebhooksPanel() {
  const { data: memberships = [] } = useUserChannels();
  const { data: publicChannels = [] } = useBrowseChannels();
  const { data: webhooks = [] } = useIncomingWebhooks();
  const creatorIDs = useMemo(
    () => [...new Set(webhooks.map((w) => w.createdBy).filter(Boolean))],
    [webhooks],
  );
  const { map: creatorMap } = useUsersBatch(creatorIDs);
  const create = useCreateIncomingWebhook();
  const update = useUpdateIncomingWebhook();
  const remove = useDeleteIncomingWebhook();
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingID, setEditingID] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<IncomingWebhook | null>(null);

  // Webhooks may target any public channel plus any private channel the
  // creator belongs to — mirror that by merging the public directory with
  // the admin's own memberships (deduped by channel id).
  const channelOptions = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>();
    for (const ch of publicChannels) map.set(ch.id, { id: ch.id, name: ch.name });
    for (const m of memberships) {
      if (!map.has(m.channelID)) map.set(m.channelID, { id: m.channelID, name: m.channelName });
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [publicChannels, memberships]);

  const selectedChannelID = form.channelID || channelOptions[0]?.id || '';
  const pending = create.isPending || update.isPending;
  const mutationError = editingID ? update.error : create.error;
  const isError = editingID ? update.isError : create.isError;

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function resetForm() {
    setForm(EMPTY_FORM);
    setEditingID(null);
  }

  function startEdit(wh: IncomingWebhook) {
    setEditingID(wh.id);
    setForm({
      title: wh.title,
      description: wh.description ?? '',
      channelID: wh.channelID,
      lockToChannel: wh.lockToChannel,
      username: wh.username ?? '',
      profileImageURL: wh.profileImageURL ?? '',
    });
  }

  function submit() {
    const input = {
      title: form.title.trim(),
      description: form.description.trim(),
      channelID: selectedChannelID,
      lockToChannel: form.lockToChannel,
      username: form.username.trim(),
      profileImageURL: form.profileImageURL.trim(),
    };
    if (editingID) {
      update.mutate({ id: editingID, input }, { onSuccess: resetForm });
    } else {
      create.mutate(input, { onSuccess: resetForm });
    }
  }

  return (
    <section className="space-y-4 rounded-lg border bg-card p-5 text-sm">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="webhook-title">Title</Label>
          <Input id="webhook-title" value={form.title} onChange={(e) => set('title', e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="webhook-channel">Channel</Label>
          <select
            id="webhook-channel"
            value={selectedChannelID}
            onChange={(e) => set('channelID', e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm mobile:text-base mobile:h-11"
          >
            {channelOptions.map((ch) => (
              <option key={ch.id} value={ch.id}>
                {ch.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor="webhook-description">Description</Label>
          <Input id="webhook-description" value={form.description} onChange={(e) => set('description', e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="webhook-username">Username</Label>
          <Input id="webhook-username" value={form.username} onChange={(e) => set('username', e.target.value)} placeholder="webhook" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="webhook-picture">Profile picture URL</Label>
          <Input id="webhook-picture" value={form.profileImageURL} onChange={(e) => set('profileImageURL', e.target.value)} placeholder="https://example.com/icon.png" />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm mobile:py-1.5">
        <input
          type="checkbox"
          checked={form.lockToChannel}
          onChange={(e) => set('lockToChannel', e.target.checked)}
          className="mobile:h-5 mobile:w-5"
        />
        Lock to this channel
      </label>

      <div className="flex items-center gap-2">
        <Button onClick={submit} disabled={pending || !form.title.trim() || !selectedChannelID}>
          {pending
            ? editingID ? 'Saving...' : 'Creating...'
            : editingID ? 'Save changes' : 'Create webhook'}
        </Button>
        {editingID && (
          <Button variant="outline" onClick={resetForm} disabled={pending}>
            Cancel
          </Button>
        )}
      </div>

      {isError && (
        <p className="text-sm text-destructive" role="alert">
          {mutationError instanceof Error ? mutationError.message : 'Request failed'}
        </p>
      )}

      <div className="space-y-2">
        {webhooks.map((wh) => (
          <div key={wh.id} className="space-y-2 rounded-md border p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{wh.title}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted-foreground">
                  <span>~{wh.channelSlug || wh.channelName || wh.channelID}</span>
                  <span aria-hidden>·</span>
                  <span>{wh.lockToChannel ? 'Locked to channel' : 'Channel override allowed'}</span>
                  <span aria-hidden>·</span>
                  <span>Created by {creatorMap.get(wh.createdBy)?.displayName ?? 'unknown'}</span>
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => startEdit(wh)}
                  aria-label={`Edit ${wh.title}`}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setToDelete(wh)}
                  aria-label={`Delete ${wh.title}`}
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
            {wh.url && (
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-sm text-muted-foreground">{wh.url}</code>
                <CopyButton value={wh.url} label={`Copy ${wh.title} URL`} />
              </div>
            )}
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => {
          if (!o) setToDelete(null);
        }}
        title="Delete webhook?"
        description={toDelete ? `"${toDelete.title}" will stop accepting posts immediately. This cannot be undone.` : undefined}
        confirmLabel="Delete webhook"
        destructive
        onConfirm={() => {
          if (toDelete) remove.mutate(toDelete.id);
          setToDelete(null);
        }}
      />
    </section>
  );
}
