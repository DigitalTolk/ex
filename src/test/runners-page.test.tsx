import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import RunnersPage from '@/pages/RunnersPage';
import type { RunnerInstall } from '@/hooks/useRunnerTokens';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));

const mockUser = { current: { id: 'u-alice', systemRole: 'member' as string } };
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: mockUser.current }) }));

// The real menu is a portal-and-pointer widget covered by its own tests;
// here the items just need to be clickable.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children, ...rest }: { children: ReactNode; 'aria-label'?: string; disabled?: boolean }) => (
    <button type="button" aria-label={rest['aria-label']} disabled={rest.disabled}>
      {children}
    </button>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
    ...rest
  }: {
    children: ReactNode;
    onClick?: () => void;
    'data-testid'?: string;
  }) => (
    <button type="button" onClick={onClick} data-testid={rest['data-testid']}>
      {children}
    </button>
  ),
}));

const ORIGIN = window.location.origin;

const mac: RunnerInstall = {
  id: 'rt1',
  label: 'Alices-Mac',
  createdAt: '2026-10-05T00:00:00Z',
  expiresAt: '2026-11-04T00:00:00Z',
  online: true,
  os: 'darwin',
  version: '0.0.3',
  harnesses: [
    { name: 'claude', version: '2.1.223 (Claude Code)', authed: true },
    { name: 'codex', authed: false },
  ],
};
const linux: RunnerInstall = { id: 'rt2', label: 'build-box', createdAt: '2026-10-01T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z' };
// Online, but reporting little: no OS or version, a CLI without a version,
// and one with no CLIs at all.
const sparse: RunnerInstall = {
  id: 'rt3',
  label: 'old-runner',
  createdAt: '2026-10-01T00:00:00Z',
  expiresAt: '2026-11-01T00:00:00Z',
  online: true,
  harnesses: [{ name: 'claude', authed: true }],
};
const bare: RunnerInstall = { id: 'rt4', label: 'bare', createdAt: '2026-10-01T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z', online: true };

let settings = { maxUploadBytes: 0, allowedExtensions: [], runnersInApp: true };
let runners: RunnerInstall[] = [mac, linux, sparse, bare];

beforeEach(() => {
  settings = { maxUploadBytes: 0, allowedExtensions: [], runnersInApp: true };
  runners = [mac, linux, sparse, bare];
  mockUser.current = { id: 'u-alice', systemRole: 'member' };
  mockApiFetch.mockReset();
  mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
    if (path === '/api/v1/admin/settings') return Promise.resolve(settings);
    if (path === '/api/v1/runner-tokens') return Promise.resolve({ runners });
    if (path === '/api/v1/runner-tokens/grants' && init?.method === 'POST') return Promise.resolve({ code: 'one-time' });
    return Promise.resolve(undefined);
  });
});

afterEach(() => {
  delete window.__EX_RUNNER__;
});

type Handler = (arg: unknown) => unknown;

// installBridge stands in for the desktop app: getState answers the current
// state, push() sends a new one the way the app does after each change.
function installBridge(initial: Record<string, unknown>, handlers: Record<string, Handler> = {}) {
  let current: Record<string, unknown> = { supported: true, ...initial };
  let listener: ((s: unknown) => void) | null = null;
  const call = vi.fn(async (op: string, arg?: unknown) => {
    if (op === 'getState') return current;
    return handlers[op]?.(arg);
  });
  window.__EX_RUNNER__ = {
    call,
    subscribe: (l) => {
      listener = l;
      return () => {
        listener = null;
      };
    },
  };
  return {
    call,
    push(next: Record<string, unknown>) {
      current = { ...current, ...next };
      act(() => listener?.(current));
    },
  };
}

const installed = { binary: { version: '0.0.3', source: 'app' } };
const connected = {
  ...installed,
  connection: { server: ORIGIN, user: 'Alice', label: 'Alices-Mac', tokenId: 'rt1', expiresAt: '2026-11-04T00:00:00Z', expired: false },
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <RunnersPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const card = () => screen.getByTestId('this-computer-card');

describe('RunnersPage', () => {
  it('is turned off until an admin turns it on', async () => {
    settings = { ...settings, runnersInApp: false };
    const view = renderPage();
    expect(await screen.findByTestId('runners-off')).toHaveTextContent('An admin can turn them on');
    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/v1/runner-tokens');
    view.unmount();

    mockUser.current = { id: 'u-admin', systemRole: 'admin' };
    renderPage();
    expect(await screen.findByRole('link', { name: 'Admin → Agents' })).toHaveAttribute('href', '/admin/agents');
  });

  it('in a browser, lists the computers with live status and shows the command-line setup', async () => {
    renderPage();
    const macRow = await screen.findByTestId('runner-row-rt1');
    expect(within(macRow).getByTestId('runner-status-rt1')).toHaveTextContent('Online');
    expect(macRow).toHaveTextContent('macOS · ex-runner 0.0.3 · Connected');
    expect(within(macRow).getByTestId('runner-harness-claude')).toHaveTextContent(/^Claude Code 2\.1\.223$/);
    expect(within(macRow).getByTestId('runner-harness-codex')).toHaveTextContent('Codex · not signed in');
    const linuxRow = screen.getByTestId('runner-row-rt2');
    expect(within(linuxRow).getByTestId('runner-status-rt2')).toHaveTextContent('Offline');
    expect(within(linuxRow).queryByTestId('runner-harness-claude')).toBeNull();
    const sparseRow = screen.getByTestId('runner-row-rt3');
    expect(within(sparseRow).getByTestId('runner-harness-claude')).toHaveTextContent(/^Claude Code$/);
    expect(sparseRow).toHaveTextContent('Connected');
    expect(sparseRow).not.toHaveTextContent('ex-runner');
    expect(within(screen.getByTestId('runner-row-rt4')).queryByTestId('runner-harness-claude')).toBeNull();

    expect(screen.queryByTestId('this-computer-card')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Connect a computer' })).toBeInTheDocument();
    expect(screen.getByText('brew install digitaltolk/tools/ex-runner')).toBeInTheDocument();
    expect(screen.getByText(`ex-runner login ${ORIGIN}`)).toBeInTheDocument();
    expect(screen.getByText('brew services start ex-runner')).toBeInTheDocument();
  });

  it('says so when this app version cannot run ex-runner', async () => {
    installBridge({ supported: false });
    renderPage();
    expect(await screen.findByTestId('runners-unsupported')).toBeInTheDocument();
    expect(screen.queryByTestId('this-computer-card')).toBeNull();
  });

  it('installs, connects, starts and stops ex-runner on this computer', async () => {
    const bridge = installBridge(
      {},
      { beginConnect: () => ({ port: 50123, state: 'st', challenge: 'ch', name: 'Alices-Mac' }) },
    );
    renderPage();

    // 1. Install.
    fireEvent.click(await screen.findByTestId('runner-install'));
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('install', undefined));
    bridge.push({ busy: 'installing', progress: 0.4 });
    expect(within(card()).getByRole('progressbar', { name: 'Installing ex-runner' })).toHaveAttribute('aria-valuenow', '40');
    expect(card()).toHaveTextContent('Downloading ex-runner… 40%');
    bridge.push({ busy: null, progress: null, ...installed });
    expect(screen.getByTestId('runner-step-install')).toHaveAttribute('data-state', 'done');
    expect(screen.getByTestId('runner-step-connect')).toHaveAttribute('data-state', 'current');

    // 2. Connect: the page approves the pairing with its session and hands
    //    the one-time code back to the app.
    fireEvent.click(screen.getByTestId('runner-connect'));
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('finishConnect', { code: 'one-time' }));
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/runner-tokens/grants', {
      method: 'POST',
      body: JSON.stringify({ challenge: 'ch', label: 'Alices-Mac' }),
    });
    bridge.push(connected);

    // 3. Start, then stop.
    fireEvent.click(await screen.findByTestId('runner-start'));
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('start', undefined));
    expect(screen.getByTestId('this-computer-status')).toHaveTextContent('Stopped');
    bridge.push({ process: 'starting' });
    expect(screen.getByTestId('this-computer-status')).toHaveTextContent('Starting…');
    bridge.push({ process: 'running' });
    expect(screen.getByTestId('this-computer-status')).toHaveTextContent('Running');
    expect(screen.getByTestId('runner-step-run')).toHaveAttribute('data-state', 'done');
    expect(screen.getByTestId('runner-meta')).toHaveTextContent('ex-runner 0.0.3 · installed by ex · connected as Alice');
    // The computer this app runs on is marked in the list.
    expect(within(await screen.findByTestId('runner-row-rt1')).getByText('This computer')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Connect another computer' })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('runner-stop'));
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('stop', undefined));
    bridge.push({ process: 'stopping' });
    expect(screen.getByTestId('this-computer-status')).toHaveTextContent('Stopping…');
  });

  it('treats a declined confirmation as a choice, and a failed approval as an error', async () => {
    let decline = true;
    const bridge = installBridge(installed, {
      beginConnect: () => {
        if (decline) throw new Error('cancelled');
        return { port: 50123, state: 'st', challenge: 'ch', name: 'mac' };
      },
    });
    renderPage();
    fireEvent.click(await screen.findByTestId('runner-connect'));
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('beginConnect', undefined));
    await waitFor(() => expect(screen.getByTestId('runner-connect')).not.toBeDisabled());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/v1/runner-tokens/grants', expect.anything());

    decline = false;
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/v1/runner-tokens/grants' && init?.method === 'POST') return Promise.reject(new Error('grant refused'));
      if (path === '/api/v1/admin/settings') return Promise.resolve(settings);
      return Promise.resolve({ runners });
    });
    fireEvent.click(screen.getByTestId('runner-connect'));
    expect(await screen.findByRole('alert')).toHaveTextContent('grant refused');
    expect(bridge.call).toHaveBeenCalledWith('cancelConnect', undefined);
  });

  it('reports a connect the app could not begin, and survives a failed cancel', async () => {
    let fail = 'begin';
    const bridge = installBridge(installed, {
      beginConnect: () => {
        if (fail === 'begin') throw new Error('ex-runner login failed to start');
        return { port: 50123, state: 'st', challenge: 'ch', name: 'mac' };
      },
      finishConnect: () => {
        throw new Error('the runner went away');
      },
      cancelConnect: () => {
        throw new Error('nothing to cancel');
      },
    });
    renderPage();
    fireEvent.click(await screen.findByTestId('runner-connect'));
    expect(await screen.findByRole('alert')).toHaveTextContent('ex-runner login failed to start');
    expect(bridge.call).not.toHaveBeenCalledWith('cancelConnect', undefined);

    fail = 'finish';
    fireEvent.click(screen.getByTestId('runner-connect'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('the runner went away'));
    expect(bridge.call).toHaveBeenCalledWith('cancelConnect', undefined);
  });

  it('drops a log that arrives after the dialog closed', async () => {
    let answer: (v: unknown) => void = () => {};
    let fail: (e: unknown) => void = () => {};
    installBridge(connected, {
      readLog: () =>
        new Promise((res, rej) => {
          answer = res;
          fail = rej;
        }),
    });
    renderPage();
    // Once with a log, once with a failure — neither lands in a closed dialog.
    for (const settle of [() => answer(['late']), () => fail(new Error('late'))]) {
      fireEvent.click(await screen.findByTestId('runner-view-log'));
      fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await act(async () => settle());
    }
    expect(screen.queryByTestId('runner-log')).toBeNull();
    expect(screen.queryByText('late')).toBeNull();
  });

  it('shows a generic message for an error without one, and the app’s own error', async () => {
    const bridge = installBridge(connected, {
      start: () => {
        throw new Error('');
      },
    });
    renderPage();
    fireEvent.click(await screen.findByTestId('runner-start'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
    bridge.push({ error: 'ex-runner stopped unexpectedly (exit 1).' });
    // The action's own message wins while it is fresh.
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong.');
  });

  it('shows the app’s error when nothing else is pending', async () => {
    installBridge({ ...connected, error: 'ex-runner stopped unexpectedly (exit 1).' });
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('ex-runner stopped unexpectedly (exit 1).');
  });

  it.each([
    [{ ...connected, connection: { ...connected.connection, expired: true } }, "This computer's sign-in expired", 'Connect again'],
    [
      { ...connected, connection: { ...connected.connection, server: 'https://other.example' } },
      'It runs agents for https://other.example',
      'Connect to this server',
    ],
    [{ ...connected, connection: { ...connected.connection, tokenId: 'rt-gone' } }, 'Not connected to your account', 'Connect to my account'],
    [installed, 'Link it to your account', 'Connect this computer'],
  ])('asks to connect again when needed (%#)', async (st, text, button) => {
    installBridge(st);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('runner-connect')).toHaveTextContent(button));
    expect(card()).toHaveTextContent(text);
  });

  it('asks to update an ex-runner too old to control', async () => {
    const bridge = installBridge({ binary: { version: '0.0.2', source: 'app' } });
    const view = renderPage();
    expect(await screen.findByTestId('runner-install')).toHaveTextContent('Update ex-runner');
    expect(card()).toHaveTextContent('This version (0.0.2) is too old');
    fireEvent.click(screen.getByTestId('runner-install'));
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('install', undefined));
    view.unmount();

    installBridge({ binary: { version: '0.0.2', source: 'system' } });
    renderPage();
    expect(await screen.findByTestId('runner-install')).toHaveTextContent("Install ex's own copy");
    expect(card()).toHaveTextContent('brew upgrade ex-runner');
    expect(screen.getByTestId('runner-meta')).toHaveTextContent('installed outside ex');
  });

  it('defers to a runner started outside the app', async () => {
    installBridge({ ...connected, binary: { version: '0.0.3', source: 'system' }, process: 'running', external: true });
    renderPage();
    await waitFor(() => expect(card()).toHaveTextContent('running outside the app'));
    expect(screen.queryByTestId('runner-stop')).toBeNull();
    expect(screen.queryByTestId('runner-autostart')).toBeNull();
    // Nothing the app can update or remove; disconnect still works.
    expect(screen.queryByTestId('runner-update')).toBeNull();
    expect(screen.queryByTestId('runner-uninstall')).toBeNull();
    expect(screen.getByTestId('runner-disconnect-here')).toBeInTheDocument();
  });

  it('turns "Start when ex opens" on and off', async () => {
    const user = userEvent.setup();
    const bridge = installBridge(connected);
    renderPage();
    const toggle = await screen.findByRole('switch', { name: 'Start when ex opens' });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('setAutoStart', { on: true }));
    bridge.push({ autoStart: true });
    expect(screen.getByRole('switch', { name: 'Start when ex opens' })).toBeChecked();
  });

  it('shows the log, refreshes it, and says when it is empty or unreadable', async () => {
    let lines: unknown = ['2026-10-16T08:00:00Z registered', '2026-10-16T08:00:05Z claimed run'];
    const bridge = installBridge(connected, {
      readLog: () => {
        if (lines instanceof Error) throw lines;
        return lines;
      },
    });
    renderPage();
    fireEvent.click(await screen.findByTestId('runner-view-log'));
    expect(await screen.findByTestId('runner-log')).toHaveTextContent('claimed run');
    lines = [];
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Nothing yet — start ex-runner first.')).toBeInTheDocument();
    lines = new Error('log unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('log unavailable')).toBeInTheDocument();
    lines = 'not an error object';
    expect(bridge.call.mock.calls.filter((c) => c[0] === 'readLog')).toHaveLength(3);
  });

  it('falls back to a generic log error', async () => {
    installBridge(connected, {
      readLog: () => {
        throw 'nope';
      },
    });
    renderPage();
    fireEvent.click(await screen.findByTestId('runner-view-log'));
    expect(await screen.findByText('Could not read the log.')).toBeInTheDocument();
  });

  it('updates, disconnects and removes from the menu, confirming the last two', async () => {
    const bridge = installBridge({ ...connected, latestVersion: '0.0.4' });
    renderPage();
    fireEvent.click(await screen.findByTestId('runner-update'));
    expect(screen.getByTestId('runner-update')).toHaveTextContent('Update to 0.0.4');
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('install', undefined));

    fireEvent.click(screen.getByTestId('runner-disconnect-here'));
    fireEvent.click(await screen.findByTestId('this-computer-disconnect-confirm'));
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('disconnect', undefined));

    fireEvent.click(screen.getByTestId('runner-uninstall'));
    fireEvent.click(await screen.findByTestId('this-computer-uninstall-cancel'));
    expect(bridge.call).not.toHaveBeenCalledWith('uninstall', undefined);
    fireEvent.click(screen.getByTestId('runner-uninstall'));
    fireEvent.click(await screen.findByTestId('this-computer-uninstall-confirm'));
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('uninstall', undefined));
  });

  it('has no menu when there is nothing to do from it', async () => {
    installBridge({ binary: { version: '0.0.3', source: 'system' } });
    renderPage();
    await screen.findByTestId('runner-connect');
    expect(screen.queryByRole('button', { name: 'More runner actions' })).toBeNull();
  });

  it('shows a starting runner and a connecting app as busy', async () => {
    const bridge = installBridge({ ...connected, process: 'starting' });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('runner-start')).toBeDisabled());
    bridge.push({ process: 'stopped', busy: 'connecting' });
    expect(card()).toHaveTextContent('Connecting this computer…');
    // A connect left waiting by an earlier page can be dropped.
    fireEvent.click(screen.getByTestId('runner-cancel-connect'));
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('cancelConnect', undefined));
    bridge.push({ busy: 'installing', progress: null });
    expect(card()).toHaveTextContent('Installing ex-runner…');
  });

  it('keeps the setup steps when the app never answers', async () => {
    window.__EX_RUNNER__ = { call: () => Promise.reject(new Error('gone')), subscribe: () => () => {} };
    renderPage();
    expect(await screen.findByTestId('runner-setup-steps')).toBeInTheDocument();
    expect(screen.queryByTestId('this-computer-card')).toBeNull();
  });
});
