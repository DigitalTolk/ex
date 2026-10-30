import { useState } from 'react';
import { ChevronDown, CircleAlert, CircleCheck, KeyRound, Send } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/context/AuthContext';
import { isAdmin } from '@/lib/roles';
import { cn } from '@/lib/utils';
import {
  useInteractivity,
  useRotateCredential,
  useSendTestInteraction,
  useSetInteractivitySwitch,
  useSetRequestURL,
} from '@/hooks/useInteractivity';
import type { IncomingWebhook, InteractionEntry } from '@/types';

const errorText = (err: unknown) => (err instanceof Error && err.message ? err.message : 'Request failed');

// InteractivitySettings lets an app receive the clicks on its messages'
// buttons: where they go, the credentials it signs and posts with, the admin
// switches, a test click and the recent history. Folded until opened, so the
// webhooks list stays one row each and nothing loads for a closed section.
export function InteractivitySettings({ webhook }: { webhook: IncomingWebhook }) {
  const [open, setOpen] = useState(false);
  const state = webhook.adminPaused ? 'Paused' : webhook.interactivityURL ? 'On' : 'Off';
  return (
    <div className="rounded-md border bg-muted/30" data-testid={`interactivity-${webhook.id}`}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium mobile:min-h-11"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid={`interactivity-toggle-${webhook.id}`}
      >
        <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform', !open && '-rotate-90')} aria-hidden />
        Interactivity
        <Badge variant={state === 'On' ? 'default' : state === 'Paused' ? 'destructive' : 'secondary'}>{state}</Badge>
      </button>
      {open && <InteractivityBody webhook={webhook} />}
    </div>
  );
}

function InteractivityBody({ webhook }: { webhook: IncomingWebhook }) {
  const { user } = useAuth();
  const admin = isAdmin(user?.systemRole);
  const status = useInteractivity(webhook.id, true);
  const current = status.data?.webhook ?? webhook;
  return (
    <div className="space-y-5 border-t px-3 py-4">
      {status.data?.pausedForSeconds ? (
        <p className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="status">
          <CircleAlert className="h-4 w-4 shrink-0" aria-hidden />
          Paused after failing clicks — resumes in {Math.ceil(status.data.pausedForSeconds / 60)} min.
        </p>
      ) : null}
      <RequestURL webhook={current} />
      <div className="space-y-2">
        <h4 className="text-sm font-medium">Credentials</h4>
        <Credential
          webhookID={webhook.id}
          kind="bot-token"
          label="Bot token"
          issued={!!current.hasBotToken}
          hint="Post buttons that call the app with Authorization: Bearer <token>."
        />
        <Credential
          webhookID={webhook.id}
          kind="signing-secret"
          label="Signing secret"
          issued={!!current.hasSigningSecret}
          hint="Verify X-Ex-Signature on every request ex sends the app."
        />
      </div>
      <div className="space-y-2">
        <h4 className="text-sm font-medium">Admin</h4>
        <AdminSwitch
          webhookID={webhook.id}
          which="email-sharing"
          label="Share clickers' email addresses"
          checked={!!current.emailSharing}
          admin={admin}
        />
        <AdminSwitch webhookID={webhook.id} which="paused" label="Pause this app's buttons" checked={!!current.adminPaused} admin={admin} />
        {!admin && <p className="text-xs text-muted-foreground">Only a workspace admin can change these.</p>}
      </div>
      <TestInteraction webhookID={webhook.id} ready={!!current.interactivityURL && !!current.hasSigningSecret} />
      <History entries={status.data?.interactions ?? []} />
    </div>
  );
}

function RequestURL({ webhook }: { webhook: IncomingWebhook }) {
  const saved = webhook.interactivityURL ?? '';
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? saved;
  const save = useSetRequestURL(webhook.id);
  const id = `request-url-${webhook.id}`;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Request URL</Label>
      <div className="flex gap-2 mobile:flex-col">
        <Input
          id={id}
          value={value}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="https://app.example.com/ex/interactions"
          aria-invalid={save.isError || undefined}
          data-testid={`request-url-input-${webhook.id}`}
        />
        <Button
          onClick={() => save.mutate(value, { onSuccess: () => setDraft(null) })}
          disabled={save.isPending || value.trim() === saved}
          data-testid={`request-url-save-${webhook.id}`}
        >
          {save.isPending ? 'Saving…' : value.trim() ? 'Save' : 'Turn off'}
        </Button>
      </div>
      {save.isError ? (
        <p className="text-sm text-destructive" role="alert">
          {errorText(save.error)}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Clicks on this app's buttons are sent here, signed. Empty turns them off.</p>
      )}
    </div>
  );
}

function Credential({
  webhookID,
  kind,
  label,
  issued,
  hint,
}: {
  webhookID: string;
  kind: 'bot-token' | 'signing-secret';
  label: string;
  issued: boolean;
  hint: string;
}) {
  const rotate = useRotateCredential(webhookID, kind);
  const [confirming, setConfirming] = useState(false);
  const [revokeNow, setRevokeNow] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const issue = (revoke: boolean) =>
    rotate.mutate(revoke, {
      onSuccess: (res) => {
        setRevealed(res.token ?? res.secret ?? null);
        setConfirming(false);
        setRevokeNow(false);
      },
    });
  return (
    <div className="rounded-md border bg-background p-3" data-testid={`credential-${kind}-${webhookID}`}>
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 text-sm font-medium">{label}</span>
        <div className="ml-auto shrink-0">
          {!confirming && (
            <Button
              size="sm"
              variant="outline"
              disabled={rotate.isPending}
              onClick={() => (issued ? setConfirming(true) : issue(false))}
              data-testid={`credential-${kind}-action-${webhookID}`}
            >
              {issued ? 'Rotate…' : 'Issue'}
            </Button>
          )}
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{issued ? 'Issued' : 'Not issued'}</span> · {hint}
      </p>
      {confirming && (
        <div className="mt-3 space-y-2 rounded-md bg-muted/50 p-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={revokeNow}
              onChange={(e) => setRevokeNow(e.target.checked)}
              className="mobile:h-5 mobile:w-5"
              data-testid={`credential-${kind}-revoke-${webhookID}`}
            />
            Stop the old one now (otherwise it keeps working for 24 hours)
          </label>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => issue(revokeNow)} disabled={rotate.isPending} data-testid={`credential-${kind}-confirm-${webhookID}`}>
              Rotate
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {rotate.isError && (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {errorText(rotate.error)}
        </p>
      )}
      {revealed && (
        <div className="mt-3 space-y-1.5" data-testid={`credential-${kind}-revealed-${webhookID}`}>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">{revealed}</code>
            <CopyButton value={revealed} label={`Copy ${label.toLowerCase()}`} />
          </div>
          <p className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            Shown this once — store it in the app now.
            <Button size="xs" variant="ghost" onClick={() => setRevealed(null)}>
              Done
            </Button>
          </p>
        </div>
      )}
    </div>
  );
}

function AdminSwitch({
  webhookID,
  which,
  label,
  checked,
  admin,
}: {
  webhookID: string;
  which: 'email-sharing' | 'paused';
  label: string;
  checked: boolean;
  admin: boolean;
}) {
  const set = useSetInteractivitySwitch(webhookID, which);
  return (
    <div className="flex items-center justify-between gap-3 text-sm mobile:min-h-11">
      <span>{label}</span>
      <Switch
        checked={checked}
        disabled={!admin || set.isPending}
        onCheckedChange={(on) => set.mutate(on)}
        aria-label={label}
        data-testid={`switch-${which}-${webhookID}`}
      />
    </div>
  );
}

function TestInteraction({ webhookID, ready }: { webhookID: string; ready: boolean }) {
  const test = useSendTestInteraction(webhookID);
  const result = test.data;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          disabled={!ready || test.isPending}
          onClick={() => test.mutate(undefined)}
          data-testid={`test-interaction-${webhookID}`}
        >
          <Send aria-hidden />
          {test.isPending ? 'Sending…' : 'Send test interaction'}
        </Button>
        {!ready && <span className="text-xs text-muted-foreground">Needs a request URL and a signing secret.</span>}
        {result && (
          <span className={cn('flex items-center gap-1.5 text-sm', result.ok ? 'text-foreground' : 'text-destructive')} data-testid={`test-result-${webhookID}`}>
            {result.ok ? (
              <CircleCheck className="h-4 w-4 text-online" aria-hidden />
            ) : (
              <CircleAlert className="h-4 w-4" aria-hidden />
            )}
            {result.ok ? `Answered ${result.status} in ${result.latencyMs} ms` : result.error}
          </span>
        )}
        {test.isError && (
          <span className="text-sm text-destructive" role="alert">
            {errorText(test.error)}
          </span>
        )}
      </div>
      {result?.reply && <pre className="max-h-32 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap break-words">{result.reply}</pre>}
    </div>
  );
}

const whenFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

const kindLabel: Record<InteractionEntry['kind'], string> = { click: 'Click', response_url: 'Response URL', test: 'Test' };

function History({ entries }: { entries: InteractionEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-xs text-muted-foreground">No interactions yet.</p>;
  }
  return (
    <details className="group">
      <summary className="cursor-pointer text-sm font-medium mobile:min-h-11 mobile:py-2">Recent interactions ({entries.length})</summary>
      <div className="mt-2 max-h-64 overflow-auto rounded-md border">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-muted text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 font-medium">When</th>
              <th className="px-2 py-1.5 font-medium">What</th>
              <th className="px-2 py-1.5 font-medium">Result</th>
              <th className="px-2 py-1.5 text-right font-medium mobile:hidden">ms</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={i} className="border-t align-top" data-testid="interaction-row">
                <td className="px-2 py-1.5 whitespace-nowrap">{whenFormat.format(new Date(e.at))}</td>
                <td className="px-2 py-1.5">
                  {kindLabel[e.kind]}
                  {e.actionID && e.kind !== 'test' ? ` · ${e.actionID}` : ''}
                </td>
                <td className={cn('px-2 py-1.5', e.result !== 'ok' && 'text-destructive')}>
                  {e.result === 'ok' ? 'OK' : e.result === 'timeout' ? 'Timed out' : 'Failed'}
                  {e.error ? <span className="block text-muted-foreground">{e.error}</span> : null}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums mobile:hidden">{e.latencyMs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
