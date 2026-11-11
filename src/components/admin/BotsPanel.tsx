import { useMemo, useState } from 'react';
import { KeyRound, Pencil, Power, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import {
  useBots,
  useBotTokens,
  useCreateBot,
  useCreateBotToken,
  useDeleteBot,
  useRevokeBotToken,
  useSetBotEnabled,
  useUpdateBot,
  type BotInput,
} from '@/hooks/useBots';
import { formatLongDate } from '@/lib/format';
import type { BotAccount, BotToken, BotTokenIssued } from '@/types/generated';

const EMPTY_FORM: BotInput = { username: '', displayName: '', description: '' };

const DESTRUCTIVE_ICON = 'text-destructive hover:bg-destructive/10 hover:text-destructive';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Request failed';
}

// What a form shows of the mutation it submits to.
interface MutationState {
  isPending: boolean;
  isError: boolean;
  error: unknown;
}

// BotsPanel manages the bot accounts integrations act as through the
// Mattermost-compatible API: the ones created here and the ones migrated
// from Mattermost. Laid out like the webhooks: the form for a new bot on
// top, the bots below, each edited in place.
export function BotsPanel() {
  const { data: bots = [] } = useBots();
  const sorted = useMemo(() => [...bots].sort((a, b) => a.displayName.localeCompare(b.displayName)), [bots]);
  const ownerIDs = useMemo(() => [...new Set(bots.map((b) => b.ownerID).filter(Boolean))], [bots]);
  const { map: owners } = useUsersBatch(ownerIDs);
  const create = useCreateBot();
  const setEnabled = useSetBotEnabled();
  const remove = useDeleteBot();
  // A new key empties the create form after a bot is made.
  const [createKey, setCreateKey] = useState(0);
  const [editingID, setEditingID] = useState<string | null>(null);
  const [tokensFor, setTokensFor] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<BotAccount | null>(null);

  return (
    <section className="space-y-4 rounded-lg border bg-card p-5 text-sm">
      <BotForm
        key={createKey}
        idPrefix="bot"
        initial={EMPTY_FORM}
        submitLabel="Create bot"
        pendingLabel="Creating..."
        mutation={create}
        onSubmit={(input) => create.mutate(input, { onSuccess: () => setCreateKey((k) => k + 1) })}
      />

      {setEnabled.isError && (
        <p className="text-sm text-destructive" role="alert">
          {errorText(setEnabled.error)}
        </p>
      )}
      {remove.isError && (
        <p className="text-sm text-destructive" role="alert">
          {errorText(remove.error)}
        </p>
      )}

      <div className="space-y-2">
        {sorted.map((bot) => {
          if (editingID === bot.id) {
            return <BotEditor key={bot.id} bot={bot} onDone={() => setEditingID(null)} />;
          }
          const disabled = bot.status === 'deactivated';
          const owner = owners.get(bot.ownerID)?.displayName;
          const details = [bot.username && `@${bot.username}`, bot.description, owner && `Created by ${owner}`].filter(Boolean);
          return (
            <div key={bot.id} className="space-y-2 rounded-md border p-3" data-testid={`bot-${bot.id}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <span className="truncate">{bot.displayName}</span>
                    {disabled && (
                      <Badge variant="secondary" className="text-xs px-1 py-0">
                        Disabled
                      </Badge>
                    )}
                  </p>
                  {details.length > 0 && (
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted-foreground">
                      {details.map((d, i) => (
                        <span key={i} className="flex items-center gap-2">
                          {i > 0 && <span aria-hidden>·</span>}
                          <span>{d}</span>
                        </span>
                      ))}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <TooltipIconButton
                    size="icon-sm"
                    label="Access tokens"
                    ariaLabel={`Access tokens for ${bot.displayName}`}
                    expanded={tokensFor === bot.id}
                    onClick={() => setTokensFor(tokensFor === bot.id ? null : bot.id)}
                  >
                    <KeyRound className="h-4 w-4" />
                  </TooltipIconButton>
                  <TooltipIconButton
                    size="icon-sm"
                    label="Edit"
                    ariaLabel={`Edit ${bot.displayName}`}
                    onClick={() => setEditingID(bot.id)}
                  >
                    <Pencil className="h-4 w-4" />
                  </TooltipIconButton>
                  <TooltipIconButton
                    size="icon-sm"
                    label={disabled ? 'Enable' : 'Disable'}
                    ariaLabel={`${disabled ? 'Enable' : 'Disable'} ${bot.displayName}`}
                    disabled={setEnabled.isPending}
                    onClick={() => setEnabled.mutate({ id: bot.id, enabled: disabled })}
                  >
                    <Power className="h-4 w-4" />
                  </TooltipIconButton>
                  <TooltipIconButton
                    size="icon-sm"
                    label="Delete"
                    ariaLabel={`Delete ${bot.displayName}`}
                    className={DESTRUCTIVE_ICON}
                    onClick={() => setToDelete(bot)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </TooltipIconButton>
                </div>
              </div>
              {tokensFor === bot.id && <BotTokens botID={bot.id} />}
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={toDelete !== null}
        // It has no trigger of its own: it only ever asks to close.
        onOpenChange={() => setToDelete(null)}
        title={`Delete "${toDelete?.displayName ?? ''}"?`}
        description="Its tokens stop working at once. This cannot be undone."
        confirmLabel="Delete bot"
        destructive
        onConfirm={() => {
          if (toDelete) remove.mutate(toDelete.id);
          setToDelete(null);
        }}
      />
    </section>
  );
}

// BotEditor edits one bot where it is listed.
function BotEditor({ bot, onDone }: { bot: BotAccount; onDone: () => void }) {
  const update = useUpdateBot();
  return (
    <div className="rounded-md border p-3" data-testid={`bot-${bot.id}`}>
      <BotForm
        idPrefix={`bot-${bot.id}`}
        initial={{ username: bot.username, displayName: bot.displayName, description: bot.description }}
        submitLabel="Save changes"
        pendingLabel="Saving..."
        mutation={update}
        onSubmit={(input) => update.mutate({ id: bot.id, input }, { onSuccess: onDone })}
        onCancel={onDone}
      />
    </div>
  );
}

// BotForm is a bot's username, display name and description: the form for a
// new bot, and a bot's own when it is being edited.
function BotForm({
  idPrefix,
  initial,
  submitLabel,
  pendingLabel,
  mutation,
  onSubmit,
  onCancel,
}: {
  idPrefix: string;
  initial: BotInput;
  submitLabel: string;
  pendingLabel: string;
  mutation: MutationState;
  onSubmit: (input: BotInput) => void;
  onCancel?: () => void;
}) {
  const [form, setForm] = useState(initial);

  function set<K extends keyof BotInput>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function submit() {
    onSubmit({
      username: form.username.trim(),
      displayName: form.displayName.trim(),
      description: form.description.trim(),
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-username`}>Username</Label>
          <Input id={`${idPrefix}-username`} value={form.username} onChange={(e) => set('username', e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-display-name`}>Display name</Label>
          <Input id={`${idPrefix}-display-name`} value={form.displayName} onChange={(e) => set('displayName', e.target.value)} />
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor={`${idPrefix}-description`}>Description</Label>
          <Input id={`${idPrefix}-description`} value={form.description} onChange={(e) => set('description', e.target.value)} />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={submit} disabled={mutation.isPending || !form.username.trim()}>
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
          {errorText(mutation.error)}
        </p>
      )}
    </div>
  );
}

// BotTokens lists one bot's tokens, makes new ones (each secret shown once,
// right after) and revokes them.
function BotTokens({ botID }: { botID: string }) {
  const { data: tokens = [] } = useBotTokens(botID);
  const create = useCreateBotToken(botID);
  const revoke = useRevokeBotToken(botID);
  const [description, setDescription] = useState('');
  const [issued, setIssued] = useState<BotTokenIssued | null>(null);
  const [toRevoke, setToRevoke] = useState<BotToken | null>(null);
  const inputID = `bot-token-description-${botID}`;

  function submit() {
    create.mutate(description.trim(), {
      onSuccess: (res) => {
        setIssued(res);
        setDescription('');
      },
    });
  }

  return (
    <div className="space-y-2 border-t pt-2" data-testid={`bot-tokens-${botID}`}>
      {issued && (
        <div className="flex items-center gap-2" data-testid="bot-token-secret">
          <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-sm">{issued.secret}</code>
          <CopyButton value={issued.secret} label={`Copy token ${issued.token.description}`} />
          <Button variant="outline" size="sm" onClick={() => setIssued(null)}>
            Done
          </Button>
        </div>
      )}
      {tokens.map((t) => (
        <div key={t.id} className="flex items-center gap-2" data-testid={`bot-token-${t.id}`}>
          <span className="min-w-0 flex-1 truncate">{t.description}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{formatLongDate(t.createdAt)}</span>
          <TooltipIconButton
            size="icon-sm"
            label="Revoke"
            ariaLabel={`Revoke ${t.description}`}
            className={DESTRUCTIVE_ICON}
            onClick={() => setToRevoke(t)}
          >
            <Trash2 className="h-4 w-4" />
          </TooltipIconButton>
        </div>
      ))}
      <div className="space-y-2">
        <Label htmlFor={inputID}>Token description</Label>
        <div className="flex items-center gap-2">
          <Input id={inputID} value={description} onChange={(e) => setDescription(e.target.value)} />
          <Button onClick={submit} disabled={create.isPending || !description.trim()}>
            Create token
          </Button>
        </div>
      </div>
      {(create.isError || revoke.isError) && (
        <p className="text-sm text-destructive" role="alert">
          {errorText(create.error ?? revoke.error)}
        </p>
      )}
      <ConfirmDialog
        open={toRevoke !== null}
        // It has no trigger of its own: it only ever asks to close.
        onOpenChange={() => setToRevoke(null)}
        title={`Revoke "${toRevoke?.description ?? ''}"?`}
        confirmLabel="Revoke token"
        destructive
        onConfirm={() => {
          if (toRevoke) revoke.mutate(toRevoke.id);
          setToRevoke(null);
        }}
      />
    </div>
  );
}
