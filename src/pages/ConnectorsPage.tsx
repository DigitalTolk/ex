import { useState } from 'react';
import { Cable, Check, LogIn, RefreshCw, Unplug } from 'lucide-react';
import { PageContainer } from '@/components/layout/PageContainer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { useAuth } from '@/context/AuthContext';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import {
  TwoFactorError,
  useConnectors,
  useInstallConnector,
  useSyncConnectors,
  useUninstallConnector,
  useUpdateConnectorInstall,
  useVerifyConnector,
  type Connector,
} from '@/hooks/useConnectors';
import { connectorInitials, connectorTint, credentialNoun, summarizeError } from '@/lib/connector-ui';
import { showToast } from '@/lib/toast';

// ConnectorsPage: external services agents can call on the user's behalf.
// Connecting = linking YOUR account (one-click sign-in, a pasted bearer token,
// or email/password for password-kind connectors). Connected services come
// first; everything else waits under "Available". Pick a connector per
// message by typing /slug in the composer.
//
// Visually one flat list per section — hairline-divided rows on a single
// surface, quiet text actions, no card-in-card — so the page reads as a
// settings list rather than a grid of boxes.
export default function ConnectorsPage() {
  useDocumentTitle('Connectors');
  const { data: connectors, isLoading } = useConnectors();
  const { user } = useAuth();
  const all = connectors ?? [];
  const connected = all.filter((c) => c.installed);
  const available = all.filter((c) => !c.installed);

  return (
    <PageContainer
      title="Connectors"
      description="Services your agents can use on your behalf. Connect with your own account, then type / in a message to pick one."
      actions={user?.systemRole === 'admin' && <SyncButton />}
    >
      {isLoading && (
        <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60" data-testid="connectors-loading">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-4">
              <Skeleton className="h-8 w-8 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="h-3 w-3/4" />
              </div>
            </div>
          ))}
        </div>
      )}

      {!isLoading && all.length === 0 && (
        <div className="py-12 text-center text-muted-foreground" data-testid="connectors-empty">
          <Cable className="mx-auto mb-3 h-8 w-8" />
          <p>No connectors yet. An admin adds them to the workspace registry.</p>
        </div>
      )}

      <div className="space-y-7">
        {connected.length > 0 && (
          <Section title="Connected" count={connected.length}>
            {connected.map((c) => <ConnectorRow key={c.slug} connector={c} />)}
          </Section>
        )}
        {available.length > 0 && (
          <Section title="Available" count={available.length}>
            {available.map((c) => <ConnectorRow key={c.slug} connector={c} />)}
          </Section>
        )}
      </div>
    </PageContainer>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 px-1 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
        {title} <span className="text-muted-foreground/60">({count})</span>
      </h2>
      <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">{children}</div>
    </section>
  );
}

// SyncButton (admin-only): re-pull the registry from the connector-provider
// right now. The server also polls each minute, so this exists for "I just
// published a connector, show it without the wait".
function SyncButton() {
  const sync = useSyncConnectors();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={sync.isPending}
      onClick={() =>
        sync.mutate(undefined, {
          onSuccess: (res) => {
            const synced = res?.synced.length ?? 0;
            const skipped = Object.keys(res?.skipped ?? {}).length;
            showToast(
              skipped > 0
                ? `Synced ${synced} connector(s), ${skipped} skipped`
                : `Connectors up to date (${synced} synced)`,
            );
          },
          onError: () => showToast("Couldn't sync from the connector provider — try again."),
        })
      }
    >
      <RefreshCw className={sync.isPending ? 'animate-spin' : ''} aria-hidden="true" />
      {sync.isPending ? 'Syncing…' : 'Sync from provider'}
    </Button>
  );
}

// ConnectorRow: two lines. Line one is identity and state — monogram, name,
// /slug, then the status — with the row's controls right-aligned on the same
// line: the agent-use policy and icon-only Reconnect / Disconnect once
// connected, a quiet Connect before. Line two is the description, one line
// on desktop. The connect form opens beneath as a hairline-separated strip.
function ConnectorRow({ connector: c }: { connector: Connector }) {
  const [connecting, setConnecting] = useState(false);
  const uninstall = useUninstallConnector();
  const verify = useVerifyConnector();
  const unverified = c.installed && c.installStatus !== 'connected';

  return (
    <div className="px-4 py-3" data-testid={`connector-card-${c.slug}`}>
      <div className="flex items-start gap-3">
        <div
          aria-hidden="true"
          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold ${connectorTint(c.slug)}`}
        >
          {connectorInitials(c.title)}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium">{c.title}</span>
            <span className="font-mono text-xs text-muted-foreground">/{c.slug}</span>
            {c.installed && <StatusBadge connector={c} />}
            {unverified && (
              <Button variant="ghost" size="xs" className="text-muted-foreground" disabled={verify.isPending} onClick={() => verify.mutate(c.slug)}>
                {verify.isPending ? 'Verifying…' : 'Verify now'}
              </Button>
            )}
            {!connecting && (
              <div className="ml-auto flex items-center gap-1">
                {c.installed ? (
                  <>
                    <AgentUseControl connector={c} />
                    <TooltipIconButton
                      label="Reconnect"
                      className="text-muted-foreground"
                      onClick={() => setConnecting(true)}
                    >
                      <RefreshCw aria-hidden="true" />
                    </TooltipIconButton>
                    <TooltipIconButton
                      label="Disconnect"
                      className="text-muted-foreground hover:text-destructive"
                      disabled={uninstall.isPending}
                      onClick={() =>
                        uninstall.mutate(c.slug, {
                          onError: () => showToast("Couldn't disconnect — try again."),
                        })
                      }
                    >
                      <Unplug aria-hidden="true" />
                    </TooltipIconButton>
                  </>
                ) : (
                  <Button variant="outline" size="xs" onClick={() => setConnecting(true)}>
                    Connect
                  </Button>
                )}
              </div>
            )}
          </div>
          <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground sm:line-clamp-1" title={c.description}>
            {c.description}
          </p>
          {verify.isError && (
            <div className="mt-1.5">
              <ErrorNote message={verify.error instanceof Error ? verify.error.message : 'failed'} />
            </div>
          )}

          {connecting && <ConnectForm connector={c} onDone={() => setConnecting(false)} />}
        </div>
      </div>
    </div>
  );
}

// StatusBadge: a dot and one phrase, no fill. Green when the service confirmed
// the credential; amber "Unverified" when the token was accepted but the
// service couldn't be reached at connect time (Verify now re-checks).
function StatusBadge({ connector: c }: { connector: Connector }) {
  const ok = c.installStatus === 'connected';
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-amber-500'}`} />
      <span className={ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}>
        {ok ? `Connected${c.connectedAs ? ` as ${c.connectedAs}` : ''}` : 'Unverified'}
      </span>
    </span>
  );
}

// ErrorNote shows a service failure as one readable line. A gateway that
// answers with a whole HTML error page collapses to its title; the raw text
// stays one click away behind "Details" instead of flooding the row.
function ErrorNote({ message }: { message: string }) {
  const { summary, details } = summarizeError(message);
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs text-destructive">
      <span>{summary}</span>
      {details && (
        <>
          {' '}
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Hide details' : 'Details'}
          </button>
          {open && (
            <pre className="mt-1.5 max-h-40 overflow-auto rounded-md bg-muted/60 p-2 text-[11px] break-all whitespace-pre-wrap text-muted-foreground">
              {details}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

// AgentUseControl: may agents attach this connector to a task themselves
// (the use_connector tool)? "Ask me first" raises one approval card per run.
// Rendered as a quiet inline select, not a form field.
function AgentUseControl({ connector: c }: { connector: Connector }) {
  const update = useUpdateConnectorInstall();
  return (
    <label className="flex items-center gap-1 text-xs text-muted-foreground">
      <span className="whitespace-nowrap">
        Agents<span className="sr-only"> may use this</span>:
      </span>
      <select
        className="h-6 min-w-0 rounded-md border-0 bg-transparent px-1 text-xs font-medium text-foreground/80 hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        value={c.agentUse ?? 'ask'}
        disabled={update.isPending}
        onChange={(e) =>
          update.mutate({ slug: c.slug, agentUse: e.target.value as 'ask' | 'always' | 'never' })
        }
      >
        <option value="ask">Ask me first</option>
        <option value="always">Always allow</option>
        <option value="never">Only when I pick it</option>
      </select>
    </label>
  );
}

// SSOConnectButton: one-click connect for sso_window connectors inside the
// desktop shell — the shell opens the service's own SSO entry in an internal
// window, the user signs in with their Microsoft account, and the shell
// captures the service-minted token from the redirect (or from the service's
// own Authorization headers). The token then installs exactly like a paste.
function SSOConnectButton({
  connector: c,
  onToken,
  onError,
  busy,
}: {
  connector: Connector;
  onToken: (token: string) => void;
  onError: (message: string) => void;
  busy: boolean;
}) {
  const [waiting, setWaiting] = useState(false);
  return (
    <Button
      size="sm"
      disabled={waiting || busy}
      onClick={() => {
        setWaiting(true);
        window
          .__EX_CONNECTOR_SSO__!({
            startURL: c.startURL as string,
            capturePattern: c.capturePattern,
            apiOrigin: c.baseURL,
          })
          .then(onToken)
          .catch((err: unknown) =>
            onError(err instanceof Error ? err.message : 'sign-in window failed'),
          )
          .finally(() => setWaiting(false));
      }}
    >
      <LogIn aria-hidden="true" />
      {waiting ? 'Finish signing in in the window…' : `Sign in to ${c.title}`}
    </Button>
  );
}

// ConnectForm collects the credential: paste-a-token always; email/password
// (with a 2FA step when the auth service demands one) for password-kind
// connectors; sso_window connectors get one-click sign-in in the desktop
// shell with paste tucked behind a link as the fallback (and shown outright
// in a browser, which has no shell). Without a credential the connector is
// not usable — install IS connecting. It renders as a hairline-separated
// strip inside the row, one line when it can be.
function ConnectForm({ connector: c, onDone }: { connector: Connector; onDone: () => void }) {
  const install = useInstallConnector();
  const canLogin = c.authKind === 'password';
  // What the paste field asks for: a connector whose credential header is
  // not Authorization takes an API key (Metabase's X-Api-Key). Calling that a
  // "bearer token" had people pasting the right key under the wrong name.
  const credential = credentialNoun(c);
  const anonymous = c.authKind === 'none';
  const canSSO = c.authKind === 'sso_window' && !!window.__EX_CONNECTOR_SSO__ && !!c.startURL;
  const [mode, setMode] = useState<'login' | 'paste'>(canLogin ? 'login' : 'paste');
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [accessCode, setAccessCode] = useState('');
  const [error, setError] = useState('');
  // sso_window: paste-a-token is a fallback tucked behind a link, revealed on click.
  const [showPaste, setShowPaste] = useState(false);
  const needsCode = accessCode !== '';
  // In the SSO idle state the sign-in line is the whole form; Cancel sits on
  // it and there is no submit row.
  const ssoIdle = canSSO && !showPaste;

  const submit = () => {
    setError('');
    const payload = anonymous
      ? {}
      : needsCode
        ? { twoFactorCode, accessCode }
        : mode === 'paste'
          ? { token }
          : { email, password };
    install.mutate(
      { slug: c.slug, payload },
      {
        onSuccess: onDone,
        onError: (err) => {
          if (err instanceof TwoFactorError) {
            setAccessCode(err.accessCode);
            return;
          }
          setError(err instanceof Error ? err.message : 'connection failed');
        },
      },
    );
  };

  const valid = anonymous
    ? true
    : needsCode
      ? twoFactorCode.trim().length > 0
      : mode === 'paste'
        ? token.trim().length > 0
        : email.trim().length > 0 && password.length > 0;

  const tabClass = (active: boolean) =>
    `rounded-md px-2.5 py-1 ${active ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`;

  return (
    <div className="mt-3 space-y-2.5 border-t border-border/60 pt-3" data-testid="connect-form">
      {canSSO && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <SSOConnectButton
            connector={c}
            busy={install.isPending}
            onError={setError}
            onToken={(t) =>
              install.mutate(
                { slug: c.slug, payload: { token: t } },
                {
                  onSuccess: onDone,
                  onError: (err) => setError(err instanceof Error ? err.message : 'connection failed'),
                },
              )
            }
          />
          <span className="text-xs text-muted-foreground">
            Opens a sign-in window with your Microsoft account.
            {ssoIdle && (
              <>
                {' · '}
                <button
                  type="button"
                  onClick={() => setShowPaste(true)}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  Paste a token instead
                </button>
              </>
            )}
          </span>
          {ssoIdle && (
            <Button size="xs" variant="ghost" className="ml-auto text-muted-foreground" onClick={onDone} disabled={install.isPending}>
              Cancel
            </Button>
          )}
        </div>
      )}
      {c.authKind === 'sso_window' && !canSSO && (
        <p className="text-xs text-muted-foreground">
          The desktop app signs in to {c.title} with one click; in the browser, paste a token.
        </p>
      )}

      {canLogin && !needsCode && (
        <div className="inline-flex rounded-lg bg-muted p-0.5 text-xs" role="tablist" aria-label="Connection method">
          <button type="button" role="tab" aria-selected={mode === 'login'} onClick={() => setMode('login')} className={tabClass(mode === 'login')}>
            Sign in
          </button>
          <button type="button" role="tab" aria-selected={mode === 'paste'} onClick={() => setMode('paste')} className={tabClass(mode === 'paste')}>
            {credential === 'API key' ? 'Paste an API key' : 'Paste a bearer token'}
          </button>
        </div>
      )}

      {anonymous ? (
        <p className="text-xs text-muted-foreground">
          This service needs no credential — connecting just verifies it is reachable.
        </p>
      ) : needsCode ? (
        <div className="max-w-56">
          <Label htmlFor={`conn-2fa-${c.slug}`}>Two-factor code</Label>
          <Input
            id={`conn-2fa-${c.slug}`}
            className="mt-1 h-8"
            value={twoFactorCode}
            placeholder="123456"
            autoFocus
            onChange={(e) => setTwoFactorCode(e.target.value)}
          />
        </div>
      ) : mode === 'paste' ? (
        ssoIdle ? null : (
          <div className="max-w-xl">
            <Label htmlFor={`conn-token-${c.slug}`}>{credential === 'API key' ? 'API key' : 'Bearer token'}</Label>
            <Input
              id={`conn-token-${c.slug}`}
              className="mt-1 h-8 font-mono"
              type="password"
              value={token}
              placeholder={`paste your ${credential} for this service`}
              autoFocus
              onChange={(e) => setToken(e.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Stored for your account only; agents use it when you pick /{c.slug} in a message.
            </p>
          </div>
        )
      ) : (
        <div className="flex flex-wrap gap-3">
          <div className="min-w-56 flex-1">
            <Label htmlFor={`conn-email-${c.slug}`}>Email</Label>
            <Input
              id={`conn-email-${c.slug}`}
              className="mt-1 h-8"
              type="email"
              value={email}
              autoFocus
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="min-w-56 flex-1">
            <Label htmlFor={`conn-password-${c.slug}`}>Password</Label>
            <Input
              id={`conn-password-${c.slug}`}
              className="mt-1 h-8"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Exchanged for a token once — your password is never stored.
            </p>
          </div>
        </div>
      )}

      {error && <ErrorNote message={error} />}

      {!ssoIdle && (
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={submit} disabled={!valid || install.isPending}>
            <Check aria-hidden="true" />
            {install.isPending ? 'Connecting…' : needsCode ? 'Verify code' : 'Connect'}
          </Button>
          <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={onDone} disabled={install.isPending}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
