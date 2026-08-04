import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, KeyRound, Plus, Trash2, Webhook } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { copyToClipboard } from '@/lib/clipboard';
import {
  useBots,
  useCreateBot,
  useCreateBotToken,
  useBotTokens,
  useDeleteBot,
  useRevokeBotToken,
  useSetBotWebhook,
  type Bot,
} from '@/hooks/useBots';

// A copy-to-clipboard button that flips to a checkmark for a couple of seconds.
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={copied ? 'Copied' : label}
      onClick={async () => {
        await copyToClipboard(value);
        setCopied(true);
      }}
    >
      {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
    </Button>
  );
}

// A one-time secret reveal — the plaintext is shown once and must be copied now.
function SecretReveal({ title, value }: { title: string; value: string }) {
  return (
    <div className="space-y-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
      <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
        {title} — copy it now, it won't be shown again.
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 text-sm">{value}</code>
        <CopyButton value={value} label="Copy secret" />
      </div>
    </div>
  );
}

// actionErrorMessage turns a failed bot mutation into something an admin can act
// on. A 404 here almost always means the row's id never reached the server, which
// is what a stale API build (still emitting camelCase fields) looks like from the
// client — so it gets a specific hint rather than the bare status.
function actionErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : '';
  if (/404|not.?found/i.test(message)) {
    return "That bot wasn't found on the server — it may already be gone, or the API is out of date. Reload, and if it persists restart the server.";
  }
  return message || 'That action failed — please try again.';
}

function BotRow({ bot }: { bot: Bot }) {
  const [open, setOpen] = useState(false);
  const [callbackURL, setCallbackURL] = useState(bot.callback_url ?? '');
  const [transport, setTransport] = useState<'ex' | 'mattermost'>(bot.transport ?? 'ex');
  const [triggerWords, setTriggerWords] = useState((bot.trigger_words ?? []).join(', '));
  const [triggerWhen, setTriggerWhen] = useState<0 | 1>(bot.trigger_when ?? 0);
  const [tokenLabel, setTokenLabel] = useState('');
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [revokeID, setRevokeID] = useState<string | null>(null);

  // Built-in bots (e.g. Cliffy) are provisioned by ex in code — EnsureBot stamps
  // created_by="system" — so they're shown read-only here: an admin didn't add
  // them and shouldn't delete or reconfigure them.
  const isSystem = bot.created_by === 'system';
  const { data: tokens = [] } = useBotTokens(open && !isSystem ? bot.user_id : '');
  const createToken = useCreateBotToken(bot.user_id);
  const revokeToken = useRevokeBotToken(bot.user_id);
  const setWebhook = useSetBotWebhook();
  const deleteBot = useDeleteBot();

  const isExternal = Boolean(bot.callback_url);

  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
      >
        {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{bot.name}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <code>{bot.user_id}</code>
            <span aria-hidden>·</span>
            <span>
              {isSystem
                ? 'Built-in · managed by ex'
                : isExternal
                  ? 'External (webhook)'
                  : 'In-process / token only'}
            </span>
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
            isSystem
              ? 'bg-violet-500/10 text-violet-700 dark:text-violet-400'
              : isExternal
                ? 'bg-sky-500/10 text-sky-700 dark:text-sky-400'
                : 'bg-muted text-muted-foreground'
          }`}
        >
          {isSystem ? 'system' : isExternal ? 'external' : 'internal'}
        </span>
      </button>

      {open && (
        <div className="space-y-5 border-t px-3 py-4">
          {bot.description && <p className="text-sm text-muted-foreground">{bot.description}</p>}

          {isSystem ? (
            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              This is a built-in bot managed by ex — it's created and wired in code, so it can't be
              edited or removed here.
            </p>
          ) : (
            <>
              {/* Access tokens */}
              <section className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <KeyRound className="h-4 w-4" /> Access tokens
                </div>
                <p className="text-xs text-muted-foreground">
                  An <code>exbot_</code> token authenticates the bot to ex's REST API and MCP endpoint.
                </p>
                {revealedToken && <SecretReveal title="New access token" value={revealedToken} />}
                <div className="space-y-1.5">
                  {tokens.length === 0 && <p className="text-xs text-muted-foreground">No tokens yet.</p>}
                  {tokens.map((t) => (
                    <div key={t.token_id} className="flex items-center gap-2 rounded border px-2.5 py-1.5 text-sm">
                      <div className="min-w-0 flex-1">
                        <span className="font-medium">{t.label || 'token'}</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {t.revoked_at ? 'revoked' : `created ${new Date(t.create_at).toLocaleDateString()}`}
                        </span>
                      </div>
                      {!t.revoked_at && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Revoke ${t.label || 'token'}`}
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => setRevokeID(t.token_id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    value={tokenLabel}
                    onChange={(e) => setTokenLabel(e.target.value)}
                    placeholder="Label (e.g. production)"
                    className="h-9"
                  />
                  <Button
                    variant="outline"
                    disabled={createToken.isPending}
                    onClick={() =>
                      createToken.mutate(tokenLabel.trim(), {
                        onSuccess: (issued) => {
                          setRevealedToken(issued.token);
                          setTokenLabel('');
                        },
                      })
                    }
                  >
                    <Plus className="mr-1 h-4 w-4" /> Issue token
                  </Button>
                </div>
              </section>

              {/* Outgoing webhook */}
              <section className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Webhook className="h-4 w-4" /> Outgoing webhook
                </div>
                <p className="text-xs text-muted-foreground">
                  Set a callback URL to make this an <b>external</b> bot: ex POSTs each @mention (or
                  trigger word) to it and posts the reply back. Leave blank for a token-only /
                  in-process bot.
                </p>
                {revealedSecret && <SecretReveal title="Shared secret" value={revealedSecret} />}
                <Input
                  value={callbackURL}
                  onChange={(e) => setCallbackURL(e.target.value)}
                  placeholder="https://bot.example.com/hook"
                  className="h-9"
                  aria-label="Callback URL"
                />

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor={`transport-${bot.user_id}`} className="text-xs">
                      Payload format
                    </Label>
                    <select
                      id={`transport-${bot.user_id}`}
                      value={transport}
                      onChange={(e) => setTransport(e.target.value as 'ex' | 'mattermost')}
                      className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    >
                      <option value="ex">ex — signed JSON (recommended)</option>
                      <option value="mattermost">Mattermost — form-encoded</option>
                    </select>
                    <p className="text-xs text-muted-foreground">
                      {transport === 'mattermost'
                        ? "MM's outgoing-webhook fields; the secret is the body's token. Pick this for an existing Mattermost bot."
                        : 'ex JSON with an HMAC X-Ex-Signature header — stronger authentication than a token in the body.'}
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`triggers-${bot.user_id}`} className="text-xs">
                      Trigger words
                    </Label>
                    <Input
                      id={`triggers-${bot.user_id}`}
                      value={triggerWords}
                      onChange={(e) => setTriggerWords(e.target.value)}
                      placeholder="deploy, status"
                      className="h-9"
                    />
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={triggerWhen === 1}
                        onChange={(e) => setTriggerWhen(e.target.checked ? 1 : 0)}
                      />
                      Match anywhere in the message (default: only at the start)
                    </label>
                  </div>
                </div>

                <div className="flex justify-end">
                  <Button
                    variant="outline"
                    disabled={setWebhook.isPending}
                    onClick={() =>
                      setWebhook.mutate(
                        {
                          id: bot.user_id,
                          callback_url: callbackURL.trim(),
                          transport,
                          // Split on commas AND whitespace: a trigger word can contain
                          // neither, so both are separators however the admin typed it.
                          trigger_words: triggerWords
                            .split(/[,\s]+/)
                            .map((w) => w.trim())
                            .filter(Boolean),
                          trigger_when: triggerWhen,
                        },
                        { onSuccess: (res) => setRevealedSecret(res.signing_secret || null) },
                      )
                    }
                  >
                    Save
                  </Button>
                </div>
                {setWebhook.isError && (
                  <p className="text-xs text-destructive" role="alert">
                    {setWebhook.error instanceof Error ? setWebhook.error.message : 'Could not save webhook'}
                  </p>
                )}
              </section>

              {/* Danger zone */}
              {/* A failed delete or revoke used to be silent, which reads as "the
                  button does nothing" — the server's reason belongs on screen. */}
              {(deleteBot.isError || revokeToken.isError) && (
                <p className="text-xs text-destructive" role="alert" data-testid="bot-action-error">
                  {actionErrorMessage(deleteBot.error ?? revokeToken.error)}
                </p>
              )}
              <div className="flex justify-end border-t pt-3">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={deleteBot.isPending}
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 className="mr-1 h-4 w-4" /> Delete bot
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete bot?"
        description={`"${bot.name}" and all its tokens will be removed immediately. This cannot be undone.`}
        confirmLabel="Delete bot"
        destructive
        onConfirm={() => {
          deleteBot.mutate(bot.user_id);
          setConfirmDelete(false);
        }}
      />
      <ConfirmDialog
        open={revokeID !== null}
        onOpenChange={(o) => {
          if (!o) setRevokeID(null);
        }}
        title="Revoke token?"
        description="Any client using this token will stop working immediately."
        confirmLabel="Revoke"
        destructive
        onConfirm={() => {
          if (revokeID) revokeToken.mutate(revokeID);
          setRevokeID(null);
        }}
      />
    </div>
  );
}

export function BotsPanel() {
  const { data: bots = [] } = useBots();
  const create = useCreateBot();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  return (
    <section className="space-y-5 rounded-lg border bg-card p-5 text-sm">
      {/* Create */}
      <div className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="bot-name">Name</Label>
            <Input id="bot-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jira bot" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bot-desc">Description</Label>
            <Input
              id="bot-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this bot does"
            />
          </div>
        </div>
        <Button
          disabled={create.isPending || !name.trim()}
          onClick={() =>
            create.mutate(
              { name: name.trim(), description: description.trim() },
              {
                onSuccess: () => {
                  setName('');
                  setDescription('');
                },
              },
            )
          }
        >
          {create.isPending ? 'Creating…' : 'Create bot'}
        </Button>
        {create.isError && (
          <p className="text-sm text-destructive" role="alert">
            {create.error instanceof Error ? create.error.message : 'Could not create bot'}
          </p>
        )}
      </div>

      {/* List */}
      <div className="space-y-2">
        {bots.length === 0 && <p className="text-sm text-muted-foreground">No bots yet.</p>}
        {bots.map((bot) => (
          <BotRow key={bot.user_id} bot={bot} />
        ))}
      </div>
    </section>
  );
}
