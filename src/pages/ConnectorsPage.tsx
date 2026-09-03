import { useState } from 'react';
import { Cable, Check, Plug, Unplug } from 'lucide-react';
import { PageContainer } from '@/components/layout/PageContainer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import {
  TwoFactorError,
  useConnectors,
  useInstallConnector,
  useUninstallConnector,
  useUpdateConnectorInstall,
  useVerifyConnector,
  type Connector,
} from '@/hooks/useConnectors';

// ConnectorsPage: external services agents can call. Installing = connecting
// YOUR account (paste a bearer token, or sign in for password-kind
// connectors). Pick a connector per message by typing /slug in the composer.
export default function ConnectorsPage() {
  useDocumentTitle('Connectors');
  const { data: connectors, isLoading } = useConnectors();

  return (
    <PageContainer
      title="Connectors"
      description="External services agents can use on your behalf. Install one with your own credentials, then pick it per message by typing / in the composer."
    >
      {isLoading && (
        <div className="space-y-3" data-testid="connectors-loading">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      )}

      {!isLoading && (connectors?.length ?? 0) === 0 && (
        <div className="py-12 text-center text-muted-foreground" data-testid="connectors-empty">
          <Cable className="mx-auto mb-3 h-8 w-8" />
          <p>No connectors yet. An admin adds them to the workspace registry.</p>
        </div>
      )}

      <div className="space-y-3">
        {connectors?.map((c) => <ConnectorCard key={c.slug} connector={c} />)}
      </div>
    </PageContainer>
  );
}

function ConnectorCard({ connector: c }: { connector: Connector }) {
  const [connecting, setConnecting] = useState(false);
  const uninstall = useUninstallConnector();

  return (
    <div className="rounded-lg border p-4" data-testid={`connector-card-${c.slug}`}>
      <div className="flex items-start gap-3">
        <Cable className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-semibold">{c.title}</span>
            <code className="text-xs text-muted-foreground">/{c.slug}</code>
            {c.installed && (
              <span
                className={
                  'rounded-full px-2 py-0.5 text-xs font-medium ' +
                  (c.installStatus === 'connected'
                    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                    : 'bg-amber-500/15 text-amber-600 dark:text-amber-400')
                }
              >
                {c.installStatus === 'connected'
                  ? `connected${c.connectedAs ? ` as ${c.connectedAs}` : ''}`
                  : 'connected (unverified)'}
              </span>
            )}
            {c.installed && c.installStatus !== 'connected' && <VerifyButton slug={c.slug} />}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">{c.description}</p>
          {c.installed && <AgentUseControl connector={c} />}
          {connecting && (
            <ConnectForm connector={c} onDone={() => setConnecting(false)} />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {c.installed ? (
            <>
              <Button variant="outline" size="sm" onClick={() => setConnecting(true)}>
                Reconnect
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={uninstall.isPending}
                onClick={() => uninstall.mutate(c.slug)}
              >
                <Unplug className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                Disconnect
              </Button>
            </>
          ) : (
            !connecting && (
              <Button size="sm" onClick={() => setConnecting(true)}>
                <Plug className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                Install
              </Button>
            )
          )}
        </div>
      </div>
    </div>
  );
}

// VerifyButton re-checks an unverified install's token against the service
// ("unverified" only means the service was unreachable at install time).
function VerifyButton({ slug }: { slug: string }) {
  const verify = useVerifyConnector();
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        disabled={verify.isPending}
        onClick={() => verify.mutate(slug)}
        className="rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        {verify.isPending ? 'Verifying…' : 'Verify now'}
      </button>
      {verify.isError && (
        <span className="text-xs text-destructive">
          {verify.error instanceof Error ? verify.error.message : 'failed'}
        </span>
      )}
    </span>
  );
}

// AgentUseControl: may agents attach this connector to a task themselves
// (the use_connector tool)? "Ask first" raises one approval card per run.
function AgentUseControl({ connector: c }: { connector: Connector }) {
  const update = useUpdateConnectorInstall();
  return (
    <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
      <span>Agents may use this:</span>
      <select
        className="rounded-md border bg-transparent px-1.5 py-0.5 text-xs"
        value={c.agentUse ?? 'ask'}
        disabled={update.isPending}
        onChange={(e) =>
          update.mutate({ slug: c.slug, agentUse: e.target.value as 'ask' | 'always' | 'never' })
        }
      >
        <option value="ask">Ask me first</option>
        <option value="always">Always allow</option>
        <option value="never">Only when I pick /{c.slug}</option>
      </select>
    </label>
  );
}

// ConnectForm collects the credential: paste-a-token always; email/password
// (with a 2FA step when the auth service demands one) for password-kind
// connectors. Without a credential the connector is not usable — install IS
// connecting.
function ConnectForm({ connector: c, onDone }: { connector: Connector; onDone: () => void }) {
  const install = useInstallConnector();
  const canLogin = c.authKind === 'password';
  const anonymous = c.authKind === 'none';
  const [mode, setMode] = useState<'login' | 'paste'>(canLogin ? 'login' : 'paste');
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [accessCode, setAccessCode] = useState('');
  const [error, setError] = useState('');
  const needsCode = accessCode !== '';

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

  return (
    <div className="mt-3 space-y-3 rounded-md border bg-muted/30 p-3" data-testid="connect-form">
      {canLogin && !needsCode && (
        <div className="inline-flex rounded-md border p-0.5 text-sm" role="tablist" aria-label="Connection method">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'login'}
            onClick={() => setMode('login')}
            className={`rounded px-3 py-1 ${mode === 'login' ? 'bg-accent font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'paste'}
            onClick={() => setMode('paste')}
            className={`rounded px-3 py-1 ${mode === 'paste' ? 'bg-accent font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            Paste a bearer token
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
            className="mt-1"
            value={twoFactorCode}
            placeholder="123456"
            autoFocus
            onChange={(e) => setTwoFactorCode(e.target.value)}
          />
        </div>
      ) : mode === 'paste' ? (
        <div>
          <Label htmlFor={`conn-token-${c.slug}`}>Bearer token</Label>
          <Input
            id={`conn-token-${c.slug}`}
            className="mt-1 font-mono"
            type="password"
            value={token}
            placeholder="paste your token for this service"
            autoFocus
            onChange={(e) => setToken(e.target.value)}
          />
          <p className="mt-0.5 text-xs text-muted-foreground">
            Stored for your account only; agents use it when you pick /{c.slug} in a message.
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          <div className="min-w-56 flex-1">
            <Label htmlFor={`conn-email-${c.slug}`}>Email</Label>
            <Input
              id={`conn-email-${c.slug}`}
              className="mt-1"
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
              className="mt-1"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className="mt-0.5 text-xs text-muted-foreground">
              Exchanged for a token once — your password is never stored.
            </p>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2">
        <Button size="sm" onClick={submit} disabled={!valid || install.isPending}>
          <Check className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          {install.isPending ? 'Connecting…' : needsCode ? 'Verify code' : 'Connect'}
        </Button>
        <Button size="sm" variant="outline" onClick={onDone} disabled={install.isPending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
