import { useMemo, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { useBrowseChannels, useUserChannels } from '@/hooks/useChannels';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import {
  useCreateIncomingWebhook,
  useDeleteIncomingWebhook,
  useIncomingWebhooks,
  useUpdateIncomingWebhook,
} from '@/hooks/useWebhooks';
import type { IncomingWebhook } from '@/types';
import { NativeSelect } from '@/components/ui/native-select';
import { InteractivitySettings } from './InteractivitySettings';
import { TemplatesSettings } from './TemplatesSettings';

interface WebhookFormValues {
  title: string;
  description: string;
  channelID: string;
  lockToChannel: boolean;
  username: string;
  profileImageURL: string;
  // '' is classic, 'rich' an app's; chosen at creation, fixed after.
  kind: string;
}

const EMPTY_FORM: WebhookFormValues = {
  title: '',
  description: '',
  channelID: '',
  lockToChannel: true,
  username: '',
  profileImageURL: '',
  kind: '',
};

interface ChannelOption {
  id: string;
  name: string;
}

// What a form shows of the mutation it submits to.
interface MutationState {
  isPending: boolean;
  isError: boolean;
  error: unknown;
}

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
  const remove = useDeleteIncomingWebhook();
  // A new key empties the create form after a webhook is made.
  const [createKey, setCreateKey] = useState(0);
  const [editingID, setEditingID] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<IncomingWebhook | null>(null);

  // Webhooks may target any public channel plus any private channel the
  // creator belongs to — mirror that by merging the public directory with
  // the admin's own memberships (deduped by channel id).
  const channelOptions = useMemo(() => {
    const map = new Map<string, ChannelOption>();
    for (const ch of publicChannels) map.set(ch.id, { id: ch.id, name: ch.name });
    for (const m of memberships) {
      if (!map.has(m.channelID)) map.set(m.channelID, { id: m.channelID, name: m.channelName });
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [publicChannels, memberships]);

  return (
    <section className="space-y-4 rounded-lg border bg-card p-5 text-sm">
      <WebhookForm
        key={createKey}
        idPrefix="webhook"
        initial={EMPTY_FORM}
        channelOptions={channelOptions}
        submitLabel="Create webhook"
        pendingLabel="Creating..."
        mutation={create}
        onSubmit={({ kind, ...input }) =>
          create.mutate(kind ? { ...input, kind } : input, { onSuccess: () => setCreateKey((k) => k + 1) })
        }
      />

      <div className="space-y-2">
        {webhooks.map((wh) =>
          editingID === wh.id ? (
            <WebhookEditor key={wh.id} webhook={wh} channelOptions={channelOptions} onDone={() => setEditingID(null)} />
          ) : (
            <div key={wh.id} className="space-y-2 rounded-md border p-3" data-testid={`webhook-${wh.id}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
                    <span className="truncate">{wh.title}</span>
                    {wh.kind === 'rich' && (
                      <span className="shrink-0 rounded bg-muted px-1.5 text-xs font-medium leading-5 text-muted-foreground">Rich</span>
                    )}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted-foreground">
                    <span>~{wh.channelSlug || wh.channelName || wh.channelID}</span>
                    <span aria-hidden>·</span>
                    <span>{wh.lockToChannel ? 'Locked to channel' : 'Channel override allowed'}</span>
                    <span aria-hidden>·</span>
                    <span>Created by {creatorMap.get(wh.createdBy)?.displayName ?? 'unknown'}</span>
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <TooltipIconButton
                    size="icon-sm"
                    label="Edit"
                    ariaLabel={`Edit ${wh.title}`}
                    onClick={() => setEditingID(wh.id)}
                  >
                    <Pencil className="h-4 w-4" />
                  </TooltipIconButton>
                  <TooltipIconButton
                    size="icon-sm"
                    label="Delete"
                    ariaLabel={`Delete ${wh.title}`}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setToDelete(wh)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </TooltipIconButton>
                </div>
              </div>
              {wh.url && (
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-sm text-muted-foreground">{wh.url}</code>
                  <CopyButton value={wh.url} label={`Copy ${wh.title} URL`} />
                </div>
              )}
              {wh.kind === 'rich' && (
                <>
                  <InteractivitySettings webhook={wh} />
                  <TemplatesSettings webhook={wh} />
                </>
              )}
            </div>
          ),
        )}
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

// WebhookEditor edits one webhook where it is listed.
function WebhookEditor({
  webhook,
  channelOptions,
  onDone,
}: {
  webhook: IncomingWebhook;
  channelOptions: ChannelOption[];
  onDone: () => void;
}) {
  const update = useUpdateIncomingWebhook();
  return (
    <div className="rounded-md border p-3" data-testid={`webhook-${webhook.id}`}>
      <WebhookForm
        idPrefix={`webhook-${webhook.id}`}
        initial={{
          title: webhook.title,
          description: webhook.description ?? '',
          channelID: webhook.channelID,
          lockToChannel: webhook.lockToChannel,
          username: webhook.username ?? '',
          profileImageURL: webhook.profileImageURL ?? '',
          kind: webhook.kind ?? '',
        }}
        channelOptions={channelOptions}
        submitLabel="Save changes"
        pendingLabel="Saving..."
        mutation={update}
        // The kind never changes, so it isn't sent.
        onSubmit={(input) => update.mutate({ id: webhook.id, input: { ...input, kind: undefined } }, { onSuccess: onDone })}
        onCancel={onDone}
      />
    </div>
  );
}

// WebhookForm is everything a webhook is set up with: the form for a new
// one, and a webhook's own when it is being edited.
function WebhookForm({
  idPrefix,
  initial,
  channelOptions,
  submitLabel,
  pendingLabel,
  mutation,
  onSubmit,
  onCancel,
}: {
  idPrefix: string;
  initial: WebhookFormValues;
  channelOptions: ChannelOption[];
  submitLabel: string;
  pendingLabel: string;
  mutation: MutationState;
  onSubmit: (input: WebhookFormValues) => void;
  onCancel?: () => void;
}) {
  const [form, setForm] = useState(initial);
  const selectedChannelID = form.channelID || channelOptions[0]?.id || '';

  function set<K extends keyof WebhookFormValues>(key: K, value: WebhookFormValues[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function submit() {
    onSubmit({
      title: form.title.trim(),
      description: form.description.trim(),
      channelID: selectedChannelID,
      lockToChannel: form.lockToChannel,
      username: form.username.trim(),
      profileImageURL: form.profileImageURL.trim(),
      kind: form.kind,
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-title`}>Title</Label>
          <Input id={`${idPrefix}-title`} value={form.title} onChange={(e) => set('title', e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-channel`}>Channel</Label>
          <NativeSelect id={`${idPrefix}-channel`} value={selectedChannelID} onChange={(e) => set('channelID', e.target.value)}>
            {channelOptions.map((ch) => (
              <option key={ch.id} value={ch.id}>
                {ch.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor={`${idPrefix}-kind`}>Type</Label>
          {/* Fixed at creation (an edit form has onCancel): an existing
              webhook's senders keep posting exactly what they always did. */}
          <NativeSelect
            id={`${idPrefix}-kind`}
            value={form.kind}
            onChange={(e) => set('kind', e.target.value)}
            disabled={!!onCancel}
          >
            <option value="">Classic — text and cards</option>
            <option value="rich">Rich — an app's blocks, buttons and forms</option>
          </NativeSelect>
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor={`${idPrefix}-description`}>Description</Label>
          <Input id={`${idPrefix}-description`} value={form.description} onChange={(e) => set('description', e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-username`}>Username</Label>
          <Input id={`${idPrefix}-username`} value={form.username} onChange={(e) => set('username', e.target.value)} placeholder="webhook" />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-picture`}>Profile picture URL</Label>
          <Input id={`${idPrefix}-picture`} value={form.profileImageURL} onChange={(e) => set('profileImageURL', e.target.value)} placeholder="https://example.com/icon.png" />
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
        <Button onClick={submit} disabled={mutation.isPending || !form.title.trim() || !selectedChannelID}>
          {mutation.isPending ? pendingLabel : submitLabel}
        </Button>
        {onCancel && (
          <Button variant="outline" onClick={onCancel} disabled={mutation.isPending}>
            Cancel
          </Button>
        )}
      </div>

      {mutation.isError && (
        <p className="text-sm text-destructive" role="alert">
          {mutation.error instanceof Error ? mutation.error.message : 'Request failed'}
        </p>
      )}
    </div>
  );
}
