import { useMemo, useState } from 'react';
import { KeyRound, Pencil, Power, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import {
  useBots,
  useBotTokens,
  useCreateBot,
  useCreateBotToken,
  useRevokeBotToken,
  useSetBotEnabled,
  useUpdateBot,
  type BotInput,
} from '@/hooks/useBots';
import { formatLongDate } from '@/lib/format';
import type { BotAccount, BotToken, BotTokenIssued } from '@/types/generated';

const EMPTY_FORM: BotInput = { username: '', displayName: '', description: '' };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Request failed';
}

// BotsPanel manages the bot accounts integrations act as through the
// Mattermost-compatible API: the ones created here and the ones migrated
// from Mattermost. Laid out like the incoming webhooks: the form on top,
// the bots below.
export function BotsPanel() {
  const { data: bots = [] } = useBots();
  const sorted = useMemo(() => [...bots].sort((a, b) => a.displayName.localeCompare(b.displayName)), [bots]);
  const ownerIDs = useMemo(() => [...new Set(bots.map((b) => b.ownerID).filter(Boolean))], [bots]);
  const { map: owners } = useUsersBatch(ownerIDs);
  const create = useCreateBot();
  const update = useUpdateBot();
  const setEnabled = useSetBotEnabled();
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingID, setEditingID] = useState<string | null>(null);
  const [tokensFor, setTokensFor] = useState<string | null>(null);

  const saving = editingID ? update : create;

  function set<K extends keyof BotInput>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function resetForm() {
    setForm(EMPTY_FORM);
    setEditingID(null);
  }

  function startEdit(bot: BotAccount) {
    setEditingID(bot.id);
    setForm({ username: bot.username, displayName: bot.displayName, description: bot.description });
  }

  function submit() {
    const input = {
      username: form.username.trim(),
      displayName: form.displayName.trim(),
      description: form.description.trim(),
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
          <Label htmlFor="bot-username">Username</Label>
          <Input id="bot-username" value={form.username} onChange={(e) => set('username', e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="bot-display-name">Display name</Label>
          <Input id="bot-display-name" value={form.displayName} onChange={(e) => set('displayName', e.target.value)} />
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor="bot-description">Description</Label>
          <Input id="bot-description" value={form.description} onChange={(e) => set('description', e.target.value)} />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={submit} disabled={saving.isPending || !form.username.trim()}>
          {saving.isPending ? (editingID ? 'Saving...' : 'Creating...') : editingID ? 'Save changes' : 'Create bot'}
        </Button>
        {editingID && (
          <Button variant="outline" onClick={resetForm} disabled={saving.isPending}>
            Cancel
          </Button>
        )}
      </div>

      {saving.isError && (
        <p className="text-sm text-destructive" role="alert">
          {errorText(saving.error)}
        </p>
      )}
      {setEnabled.isError && (
        <p className="text-sm text-destructive" role="alert">
          {errorText(setEnabled.error)}
        </p>
      )}

      <div className="space-y-2">
        {sorted.map((bot) => {
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
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setTokensFor(tokensFor === bot.id ? null : bot.id)}
                    aria-label={`Tokens for ${bot.displayName}`}
                    aria-expanded={tokensFor === bot.id}
                  >
                    <KeyRound className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => startEdit(bot)} aria-label={`Edit ${bot.displayName}`}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setEnabled.mutate({ id: bot.id, enabled: disabled })}
                    disabled={setEnabled.isPending}
                    aria-label={`${disabled ? 'Enable' : 'Disable'} ${bot.displayName}`}
                  >
                    <Power className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              {tokensFor === bot.id && <BotTokens botID={bot.id} />}
            </div>
          );
        })}
      </div>
    </section>
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
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setToRevoke(t)}
            aria-label={`Revoke ${t.description}`}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
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
