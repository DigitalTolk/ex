import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ConnectorsPage from '@/pages/ConnectorsPage';
import { credentialNoun } from '@/lib/connector-ui';
import { ApiError } from '@/lib/api';
import type { Connector } from '@/hooks/useConnectors';

type ApiInit = { method?: string; body?: string };

const mockApiFetch = vi.fn<(path: string, init?: ApiInit) => Promise<unknown>>();
const showToast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ showToast }));

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (path: string, init?: ApiInit) => mockApiFetch(path, init),
}));

// The page reads the viewer's role to decide whether to offer the admin
// sync button; tests flip this between member and admin.
const authRole = vi.hoisted(() => ({ value: 'member' }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'u-1',
      email: 'a@b.c',
      displayName: 'Alice',
      systemRole: authRole.value,
      status: 'active',
    },
  }),
}));

// jira: paste-token, not installed. gitlab: password sign-in, connected as a
// user, agents always allowed. sentry: installed but unverified. figma: no
// credential needed, connected without an account name.
function connectorFixtures(): Connector[] {
  return [
    {
      slug: 'jira',
      title: 'Jira',
      description: 'Issue tracking',
      baseURL: 'https://jira.example.com',
      authKind: 'paste',
      installed: false,
    },
    {
      slug: 'gitlab',
      title: 'GitLab',
      description: 'Repos and MRs',
      baseURL: 'https://gitlab.example.com',
      authKind: 'password',
      installed: true,
      installStatus: 'connected',
      connectedAs: 'shivesh',
      agentUse: 'always',
    },
    {
      slug: 'sentry',
      title: 'Sentry',
      description: 'Error tracking',
      baseURL: 'https://sentry.example.com',
      authKind: 'paste',
      installed: true,
      installStatus: 'unverified',
    },
    {
      slug: 'figma',
      title: 'Figma',
      description: 'Design files',
      baseURL: 'https://figma.example.com',
      authKind: 'none',
      installed: true,
      installStatus: 'connected',
    },
  ];
}

interface Routes {
  connectors?: () => Promise<unknown>;
  mutate?: (path: string, init?: ApiInit) => Promise<unknown> | undefined;
}

function installRoutes(over: Routes = {}) {
  mockApiFetch.mockImplementation((path, init) => {
    if (!init?.method && path === '/api/v1/connectors') {
      return (over.connectors ?? (async () => ({ connectors: connectorFixtures() })))();
    }
    return over.mutate?.(path, init) ?? Promise.resolve({});
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ConnectorsPage />
    </QueryClientProvider>,
  );
}

async function findCard(slug: string) {
  return within(await screen.findByTestId(`connector-card-${slug}`));
}

beforeEach(() => {
  mockApiFetch.mockReset();
  authRole.value = 'member';
});

describe('credentialNoun', () => {
  it('asks for an API key only when the credential header is not Authorization', () => {
    expect(credentialNoun({})).toBe('bearer token');
    expect(credentialNoun({ authHeader: '' })).toBe('bearer token');
    expect(credentialNoun({ authHeader: 'Authorization: Bearer {token}' })).toBe('bearer token');
    expect(credentialNoun({ authHeader: 'authorization: Token {token}' })).toBe('bearer token');
    expect(credentialNoun({ authHeader: 'X-Api-Key: {token}' })).toBe('API key');
    expect(credentialNoun({ authHeader: 'X-Api-Key' })).toBe('API key');
  });
});

describe('ConnectorsPage', () => {
  it('labels the paste field "API key" for connectors whose header is not Authorization', async () => {
    installRoutes({
      connectors: async () => ({
        connectors: [
          {
            slug: 'metabase', title: 'Metabase', description: 'BI', baseURL: 'https://mb.example.net/api',
            authKind: 'paste', authHeader: 'X-Api-Key: {token}', installed: false,
          },
          {
            slug: 'legacy', title: 'Legacy', description: 'old', baseURL: 'https://l.example.net',
            authKind: 'password', authHeader: 'X-Api-Key: {token}', installed: false,
          },
        ],
      }),
    });
    renderPage();
    const mb = await findCard('metabase');
    fireEvent.click(mb.getByRole('button', { name: 'Connect' }));
    const form = within(mb.getByTestId('connect-form'));
    expect(form.getByLabelText('API key')).toHaveAttribute('placeholder', 'paste your API key for this service');
    expect(form.queryByLabelText('Bearer token')).toBeNull();
    // A password-kind connector with an API-key header names its paste tab accordingly.
    const legacy = await findCard('legacy');
    fireEvent.click(legacy.getByRole('button', { name: 'Connect' }));
    const lform = within(legacy.getByTestId('connect-form'));
    expect(lform.getByRole('tab', { name: 'Paste an API key' })).toBeInTheDocument();
  });

  it('shows loading skeletons while connectors load', () => {
    installRoutes({ connectors: () => new Promise(() => {}) });
    renderPage();
    expect(screen.getByTestId('connectors-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('connectors-empty')).not.toBeInTheDocument();
  });

  it('shows the empty state when the server returns no payload', async () => {
    installRoutes({ connectors: async () => undefined });
    renderPage();
    expect(await screen.findByTestId('connectors-empty')).toBeInTheDocument();
  });

  it('shows the empty state when the connectors query errors', async () => {
    installRoutes({ connectors: () => Promise.reject(new Error('boom')) });
    renderPage();
    expect(await screen.findByTestId('connectors-empty')).toBeInTheDocument();
  });

  it('renders the catalog with install status, connected-as, and per-card actions', async () => {
    installRoutes();
    renderPage();

    const jira = await findCard('jira');
    expect(jira.getByText('/jira')).toBeInTheDocument();
    expect(jira.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
    expect(jira.queryByText(/connected/)).not.toBeInTheDocument();
    expect(jira.queryByLabelText(/Agents may use this/)).not.toBeInTheDocument();

    const gitlab = await findCard('gitlab');
    expect(gitlab.getByText('Connected as shivesh')).toBeInTheDocument();
    expect(gitlab.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(gitlab.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
    expect(gitlab.queryByRole('button', { name: 'Verify now' })).not.toBeInTheDocument();
    expect(gitlab.getByLabelText(/Agents may use this/)).toHaveValue('always');

    const sentry = await findCard('sentry');
    expect(sentry.getByText('Unverified')).toBeInTheDocument();
    expect(sentry.getByRole('button', { name: 'Verify now' })).toBeInTheDocument();
    expect(sentry.getByLabelText(/Agents may use this/)).toHaveValue('ask');

    const figma = await findCard('figma');
    expect(figma.getByText('Connected')).toBeInTheDocument();
  });

  it('updates the agent-use policy', async () => {
    let patchBody: unknown;
    installRoutes({
      mutate: (path, init) => {
        if (path === '/api/v1/connectors/gitlab/install' && init?.method === 'PATCH') {
          patchBody = JSON.parse(init.body!);
          return Promise.resolve({});
        }
        return undefined;
      },
    });
    renderPage();

    const gitlab = await findCard('gitlab');
    fireEvent.change(gitlab.getByLabelText(/Agents may use this/), { target: { value: 'never' } });
    await waitFor(() => expect(patchBody).toEqual({ agentUse: 'never' }));
  });

  it('re-verifies an unverified install, surfacing both failure shapes and the pending state', async () => {
    let verifyResult: () => Promise<unknown> = async () => ({});
    installRoutes({
      mutate: (path, init) =>
        path === '/api/v1/connectors/sentry/verify' && init?.method === 'POST'
          ? verifyResult()
          : undefined,
    });
    renderPage();

    const sentry = await findCard('sentry');
    verifyResult = () => Promise.reject('x');
    fireEvent.click(sentry.getByRole('button', { name: 'Verify now' }));
    expect(await sentry.findByText('failed')).toBeInTheDocument();

    verifyResult = () => Promise.reject(new ApiError(401, 'token expired'));
    fireEvent.click(sentry.getByRole('button', { name: 'Verify now' }));
    expect(await sentry.findByText('token expired')).toBeInTheDocument();

    const d = deferred<unknown>();
    verifyResult = () => d.promise;
    fireEvent.click(sentry.getByRole('button', { name: 'Verify now' }));
    expect(await sentry.findByRole('button', { name: 'Verifying…' })).toBeDisabled();
    d.resolve({});
    await waitFor(() =>
      expect(sentry.getByRole('button', { name: 'Verify now' })).toBeInTheDocument(),
    );
  });

  it('installs a paste connector: validation, every error shape, pending, success, cancel', async () => {
    const bodies: unknown[] = [];
    let installResult: () => Promise<unknown> = async () => ({});
    installRoutes({
      mutate: (path, init) => {
        if (path === '/api/v1/connectors/jira/install' && init?.method === 'POST') {
          bodies.push(JSON.parse(init.body!));
          return installResult();
        }
        return undefined;
      },
    });
    renderPage();

    const jira = await findCard('jira');
    fireEvent.click(jira.getByRole('button', { name: 'Connect' }));
    const form = within(jira.getByTestId('connect-form'));
    // Paste-kind connectors have no sign-in tab strip and hide the card's
    // Connect CTA while the form is open — only the form's Connect remains.
    expect(jira.queryByRole('tab')).not.toBeInTheDocument();
    expect(jira.getAllByRole('button', { name: 'Connect' })).toHaveLength(1);

    const connectBtn = () => form.getByRole('button', { name: 'Connect' });
    expect(connectBtn()).toBeDisabled();
    fireEvent.change(form.getByLabelText('Bearer token'), { target: { value: ' tok ' } });
    expect(connectBtn()).toBeEnabled();

    installResult = () => Promise.reject('x');
    fireEvent.click(connectBtn());
    expect(await form.findByText('connection failed')).toBeInTheDocument();

    installResult = () => Promise.reject(new Error('bad token'));
    fireEvent.click(connectBtn());
    expect(await form.findByText('bad token')).toBeInTheDocument();

    installResult = () => Promise.reject(new ApiError(500, 'server down'));
    fireEvent.click(connectBtn());
    expect(await form.findByText('server down')).toBeInTheDocument();

    installResult = () => Promise.reject(new ApiError(409, 'conflict', { error: 'other' }));
    fireEvent.click(connectBtn());
    expect(await form.findByText('conflict')).toBeInTheDocument();

    installResult = () => Promise.reject(new ApiError(409, 'conflict2'));
    fireEvent.click(connectBtn());
    expect(await form.findByText('conflict2')).toBeInTheDocument();

    const d = deferred<unknown>();
    installResult = () => d.promise;
    fireEvent.click(connectBtn());
    expect(await form.findByRole('button', { name: 'Connecting…' })).toBeDisabled();
    d.resolve({ install: {} });
    await waitFor(() => expect(jira.queryByTestId('connect-form')).not.toBeInTheDocument());
    expect(bodies[0]).toEqual({ token: ' tok ' });
    expect(bodies).toHaveLength(6);

    // Reopen and cancel.
    fireEvent.click(jira.getByRole('button', { name: 'Connect' }));
    fireEvent.click(within(jira.getByTestId('connect-form')).getByRole('button', { name: 'Cancel' }));
    expect(jira.queryByTestId('connect-form')).not.toBeInTheDocument();
  });

  it('signs in to a password connector with tab switching and a two-factor retry', async () => {
    const bodies: unknown[] = [];
    const results: (() => Promise<unknown>)[] = [
      // 2FA demanded but no access code supplied: the form silently stays put.
      () => Promise.reject(new ApiError(409, '2fa', { error: 'two_factor_required' })),
      () => Promise.reject(new ApiError(409, '2fa', { error: 'two_factor_required', accessCode: 'AC-9' })),
      async () => ({ install: {} }),
    ];
    installRoutes({
      mutate: (path, init) => {
        if (path === '/api/v1/connectors/gitlab/install' && init?.method === 'POST') {
          bodies.push(JSON.parse(init.body!));
          return results[bodies.length - 1]();
        }
        return undefined;
      },
    });
    renderPage();

    const gitlab = await findCard('gitlab');
    fireEvent.click(gitlab.getByRole('button', { name: 'Reconnect' }));
    const form = within(gitlab.getByTestId('connect-form'));

    // Tab strip: sign-in is the default; paste swaps the credential inputs.
    expect(form.getByRole('tab', { name: 'Sign in' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(form.getByRole('tab', { name: 'Paste a bearer token' }));
    expect(form.getByRole('tab', { name: 'Paste a bearer token' })).toHaveAttribute('aria-selected', 'true');
    expect(form.getByLabelText('Bearer token')).toBeInTheDocument();
    fireEvent.click(form.getByRole('tab', { name: 'Sign in' }));

    const connectBtn = () => form.getByRole('button', { name: 'Connect' });
    expect(connectBtn()).toBeDisabled();
    fireEvent.change(form.getByLabelText('Email'), { target: { value: 'me@x.com' } });
    expect(connectBtn()).toBeDisabled();
    fireEvent.change(form.getByLabelText('Password'), { target: { value: 'pw' } });
    expect(connectBtn()).toBeEnabled();

    fireEvent.click(connectBtn());
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(form.getByLabelText('Email')).toBeInTheDocument();
    expect(form.queryByText('connection failed')).not.toBeInTheDocument();

    fireEvent.click(connectBtn());
    const codeInput = await form.findByLabelText('Two-factor code');
    expect(form.queryByRole('tab')).not.toBeInTheDocument();
    const verifyBtn = () => form.getByRole('button', { name: 'Verify code' });
    expect(verifyBtn()).toBeDisabled();
    fireEvent.change(codeInput, { target: { value: '123456' } });
    expect(verifyBtn()).toBeEnabled();
    fireEvent.click(verifyBtn());

    await waitFor(() => expect(gitlab.queryByTestId('connect-form')).not.toBeInTheDocument());
    expect(bodies).toEqual([
      { email: 'me@x.com', password: 'pw' },
      { email: 'me@x.com', password: 'pw' },
      { twoFactorCode: '123456', accessCode: 'AC-9' },
    ]);
  });

  it('connects a no-credential connector without any input', async () => {
    const bodies: unknown[] = [];
    installRoutes({
      mutate: (path, init) => {
        if (path === '/api/v1/connectors/figma/install' && init?.method === 'POST') {
          bodies.push(JSON.parse(init.body!));
          return Promise.resolve({ install: {} });
        }
        return undefined;
      },
    });
    renderPage();

    const figma = await findCard('figma');
    fireEvent.click(figma.getByRole('button', { name: 'Reconnect' }));
    const form = within(figma.getByTestId('connect-form'));
    expect(form.getByText(/needs no credential/)).toBeInTheDocument();
    const connect = form.getByRole('button', { name: 'Connect' });
    expect(connect).toBeEnabled();
    fireEvent.click(connect);
    await waitFor(() => expect(figma.queryByTestId('connect-form')).not.toBeInTheDocument());
    expect(bodies).toEqual([{}]);
  });

  it('disconnects an installed connector', async () => {
    const deletes: string[] = [];
    installRoutes({
      mutate: (path, init) => {
        if (init?.method === 'DELETE') {
          deletes.push(path);
          return Promise.resolve({});
        }
        return undefined;
      },
    });
    renderPage();

    const gitlab = await findCard('gitlab');
    fireEvent.click(gitlab.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(deletes).toEqual(['/api/v1/connectors/gitlab/install']));
  });

  it('says so when a disconnect fails instead of looking like it worked', async () => {
    installRoutes({
      mutate: (path, init) =>
        init?.method === 'DELETE' ? Promise.reject(new Error('offline')) : Promise.resolve({}),
    });
    renderPage();
    const gitlab = await findCard('gitlab');
    fireEvent.click(gitlab.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Couldn't disconnect — try again."));
  });

  it('hides the provider sync button from members', async () => {
    installRoutes();
    renderPage();
    await findCard('jira');
    expect(screen.queryByRole('button', { name: /Sync from provider/ })).toBeNull();
  });

  it('groups connectors into Connected and Available sections with counts', async () => {
    installRoutes();
    renderPage();
    await findCard('jira');
    // gitlab, sentry, figma are installed; jira is not.
    expect(screen.getByRole('heading', { name: 'Connected (3)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Available (1)' })).toBeInTheDocument();
  });

  it('omits the Available section when everything is already connected', async () => {
    installRoutes({ connectors: async () => ({ connectors: connectorFixtures().filter((c) => c.installed) }) });
    renderPage();
    await findCard('gitlab');
    expect(screen.getByRole('heading', { name: 'Connected (3)' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Available/ })).toBeNull();
  });

  it('shows a gateway error page as its title, with the raw page behind a Details toggle', async () => {
    const page =
      '<!DOCTYPE html><html><head><title>digitaltolk.net | 502: Bad gateway</title></head><body><h1>Bad gateway</h1></body></html>';
    installRoutes({
      mutate: (path, init) =>
        path === '/api/v1/connectors/sentry/verify' && init?.method === 'POST'
          ? Promise.reject(new ApiError(502, page))
          : undefined,
    });
    renderPage();
    const sentry = await findCard('sentry');
    fireEvent.click(sentry.getByRole('button', { name: 'Verify now' }));
    expect(await sentry.findByText('digitaltolk.net | 502: Bad gateway')).toBeInTheDocument();
    // The raw markup is not dumped into the card…
    expect(sentry.queryByText(/<h1>/)).toBeNull();
    // …but one click away.
    fireEvent.click(sentry.getByRole('button', { name: 'Details' }));
    expect(sentry.getByText(/<h1>Bad gateway<\/h1>/)).toBeInTheDocument();
    fireEvent.click(sentry.getByRole('button', { name: 'Hide details' }));
    expect(sentry.queryByText(/<h1>/)).toBeNull();
  });

  it('lets an admin sync from the provider and refetches the list', async () => {
    authRole.value = 'admin';
    let lists = 0;
    installRoutes({
      connectors: async () => {
        lists += 1;
        return { connectors: connectorFixtures() };
      },
      mutate: (path, init) =>
        path === '/api/v1/connectors/sync' && init?.method === 'POST'
          ? Promise.resolve({ synced: ['metabase'], skipped: {} })
          : Promise.resolve({}),
    });
    renderPage();
    await findCard('jira');
    fireEvent.click(screen.getByRole('button', { name: /Sync from provider/ }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Connectors up to date (1 synced)'));
    // The sync invalidates the connectors query → the page refetches.
    await waitFor(() => expect(lists).toBeGreaterThan(1));
  });

  it('shows a syncing state and tolerates an empty sync response', async () => {
    authRole.value = 'admin';
    const d = deferred<unknown>();
    installRoutes({
      mutate: (path, init) =>
        path === '/api/v1/connectors/sync' && init?.method === 'POST'
          ? d.promise
          : Promise.resolve({}),
    });
    renderPage();
    await findCard('jira');
    fireEvent.click(screen.getByRole('button', { name: 'Sync from provider' }));
    // In flight: label flips and the button locks so a double-click can't
    // queue a second pull.
    expect(await screen.findByRole('button', { name: 'Syncing…' })).toBeDisabled();
    // apiFetch can resolve undefined (empty body); the toast falls back to 0.
    d.resolve(undefined);
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Connectors up to date (0 synced)'),
    );
  });

  it('reports skipped connectors and sync failures', async () => {
    authRole.value = 'admin';
    installRoutes({
      mutate: (path, init) =>
        path === '/api/v1/connectors/sync' && init?.method === 'POST'
          ? Promise.resolve({ synced: [], skipped: { broken: 'no registration' } })
          : Promise.resolve({}),
    });
    renderPage();
    await findCard('jira');
    fireEvent.click(screen.getByRole('button', { name: /Sync from provider/ }));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Synced 0 connector(s), 1 skipped'),
    );

    installRoutes({
      mutate: (path, init) =>
        path === '/api/v1/connectors/sync' && init?.method === 'POST'
          ? Promise.reject(new ApiError(502, 'provider_error'))
          : Promise.resolve({}),
    });
    fireEvent.click(screen.getByRole('button', { name: /Sync from provider/ }));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith("Couldn't sync from the connector provider — try again."),
    );
  });
});


describe('sso_window connectors', () => {
  const ssoConnector = (): Connector => ({
    slug: 'cliffhub',
    title: 'CliffHub',
    description: 'Team ops',
    baseURL: 'https://cliffhub-api.example.net',
    authKind: 'sso_window',
    startURL: 'https://cliffhub-api.example.net/api/auth/microsoft',
    capturePattern: '/callback?token={token}',
    installed: false,
  });

  afterEach(() => {
    delete window.__EX_CONNECTOR_SSO__;
  });

  it('one-click signs in via the shell bridge and installs the captured token', async () => {
    const bridge = vi.fn(async () => 'captured-tok');
    window.__EX_CONNECTOR_SSO__ = bridge;
    let installBody: string | undefined;
    installRoutes({
      connectors: async () => ({ connectors: [ssoConnector()] }),
      mutate: (path, init) => {
        if (path === '/api/v1/connectors/cliffhub/install' && init?.method === 'POST') {
          installBody = init.body;
          return Promise.resolve({ install: {} });
        }
        return Promise.resolve({});
      },
    });
    renderPage();
    const card = await findCard('cliffhub');
    fireEvent.click(card.getByRole('button', { name: 'Connect' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to CliffHub' }));
    await waitFor(() => expect(installBody).toBe(JSON.stringify({ token: 'captured-tok' })));
    expect(bridge).toHaveBeenCalledWith({
      startURL: 'https://cliffhub-api.example.net/api/auth/microsoft',
      capturePattern: '/callback?token={token}',
      apiOrigin: 'https://cliffhub-api.example.net',
    });
  });

  it('hides the token field behind a link when SSO is available, revealing it on click', async () => {
    window.__EX_CONNECTOR_SSO__ = vi.fn(async () => 'x');
    installRoutes({ connectors: async () => ({ connectors: [ssoConnector()] }) });
    renderPage();
    const card = await findCard('cliffhub');
    fireEvent.click(card.getByRole('button', { name: 'Connect' }));
    await screen.findByRole('button', { name: 'Sign in to CliffHub' });
    // Token input is tucked away and the primary Connect button is suppressed —
    // signing in is the main action.
    expect(screen.queryByLabelText('Bearer token')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    // The small fallback link reveals the paste field + its Connect button.
    fireEvent.click(screen.getByRole('button', { name: 'Paste a token instead' }));
    fireEvent.change(screen.getByLabelText('Bearer token'), { target: { value: 'tok-x' } });
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
  });

  it('shows the bridge error and stays open when sign-in fails', async () => {
    window.__EX_CONNECTOR_SSO__ = vi.fn(async () => {
      throw new Error('sign-in window was closed');
    });
    installRoutes({ connectors: async () => ({ connectors: [ssoConnector()] }) });
    renderPage();
    const card = await findCard('cliffhub');
    fireEvent.click(card.getByRole('button', { name: 'Connect' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to CliffHub' }));
    expect(await screen.findByText('sign-in window was closed')).toBeInTheDocument();
  });

  it('reports a generic message for non-Error bridge failures', async () => {
    window.__EX_CONNECTOR_SSO__ = vi.fn(() => Promise.reject('nope'));
    installRoutes({ connectors: async () => ({ connectors: [ssoConnector()] }) });
    renderPage();
    const card = await findCard('cliffhub');
    fireEvent.click(card.getByRole('button', { name: 'Connect' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to CliffHub' }));
    expect(await screen.findByText('sign-in window failed')).toBeInTheDocument();
  });

  it('surfaces an install failure after a successful capture', async () => {
    window.__EX_CONNECTOR_SSO__ = vi.fn(async () => 'tok');
    installRoutes({
      connectors: async () => ({ connectors: [ssoConnector()] }),
      mutate: (path, init) =>
        init?.method === 'POST' && path.endsWith('/install')
          ? Promise.reject(new ApiError(401, 'token rejected'))
          : Promise.resolve({}),
    });
    renderPage();
    const card = await findCard('cliffhub');
    fireEvent.click(card.getByRole('button', { name: 'Connect' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to CliffHub' }));
    await waitFor(() => expect(screen.getByText(/token rejected|connection failed/)).toBeInTheDocument());
  });

  it('falls back to paste with a desktop hint when no bridge is available', async () => {
    installRoutes({ connectors: async () => ({ connectors: [ssoConnector()] }) });
    renderPage();
    const card = await findCard('cliffhub');
    fireEvent.click(card.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText(/desktop app signs in to CliffHub/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in to CliffHub' })).toBeNull();
    // Paste still works.
    fireEvent.change(screen.getByLabelText('Bearer token'), { target: { value: 'tok-manual' } });
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
  });

  it('offers no sign-in button when the connector lacks a startURL', async () => {
    window.__EX_CONNECTOR_SSO__ = vi.fn(async () => 't');
    const c = ssoConnector();
    delete (c as Partial<Connector>).startURL;
    installRoutes({ connectors: async () => ({ connectors: [c] }) });
    renderPage();
    const card = await findCard('cliffhub');
    fireEvent.click(card.getByRole('button', { name: 'Connect' }));
    await screen.findByTestId('connect-form');
    expect(screen.queryByRole('button', { name: 'Sign in to CliffHub' })).toBeNull();
  });

  it('reports a generic message for a non-Error install failure', async () => {
    window.__EX_CONNECTOR_SSO__ = vi.fn(async () => 'tok');
    installRoutes({
      connectors: async () => ({ connectors: [ssoConnector()] }),
      mutate: (path, init) =>
        init?.method === 'POST' && path.endsWith('/install')
          ? Promise.reject('kaput')
          : Promise.resolve({}),
    });
    renderPage();
    const card = await findCard('cliffhub');
    fireEvent.click(card.getByRole('button', { name: 'Connect' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to CliffHub' }));
    expect(await screen.findByText('connection failed')).toBeInTheDocument();
  });
});
