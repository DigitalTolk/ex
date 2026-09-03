import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ConnectorsPage from '@/pages/ConnectorsPage';
import { ApiError } from '@/lib/api';
import type { Connector } from '@/hooks/useConnectors';

type ApiInit = { method?: string; body?: string };

const mockApiFetch = vi.fn<(path: string, init?: ApiInit) => Promise<unknown>>();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (path: string, init?: ApiInit) => mockApiFetch(path, init),
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
});

describe('ConnectorsPage', () => {
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
    expect(jira.getByRole('button', { name: 'Install' })).toBeInTheDocument();
    expect(jira.queryByText(/connected/)).not.toBeInTheDocument();
    expect(jira.queryByLabelText(/Agents may use this/)).not.toBeInTheDocument();

    const gitlab = await findCard('gitlab');
    expect(gitlab.getByText('connected as shivesh')).toBeInTheDocument();
    expect(gitlab.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(gitlab.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
    expect(gitlab.queryByRole('button', { name: 'Verify now' })).not.toBeInTheDocument();
    expect(gitlab.getByLabelText(/Agents may use this/)).toHaveValue('always');

    const sentry = await findCard('sentry');
    expect(sentry.getByText('connected (unverified)')).toBeInTheDocument();
    expect(sentry.getByRole('button', { name: 'Verify now' })).toBeInTheDocument();
    expect(sentry.getByLabelText(/Agents may use this/)).toHaveValue('ask');

    const figma = await findCard('figma');
    expect(figma.getByText('connected')).toBeInTheDocument();
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
    fireEvent.click(jira.getByRole('button', { name: 'Install' }));
    const form = within(jira.getByTestId('connect-form'));
    // Paste-kind connectors have no sign-in tab strip and hide the Install CTA
    // while the form is open.
    expect(jira.queryByRole('tab')).not.toBeInTheDocument();
    expect(jira.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();

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
    fireEvent.click(jira.getByRole('button', { name: 'Install' }));
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
});
