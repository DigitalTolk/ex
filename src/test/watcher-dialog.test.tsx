import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WatcherDialog, type EditingWatcher } from '@/components/chat/WatcherDialog';

type ApiInit = { method?: string; body?: string };

const mockApiFetch = vi.fn<(path: string, init?: ApiInit) => Promise<unknown>>();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (path: string, init?: ApiInit) => mockApiFetch(path, init),
}));

const showToast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ showToast }));

function agent(slug: string, displayName: string, status = 'active') {
  return {
    id: `id-${slug}`,
    displayName,
    slug,
    status,
    prefs: { userID: 'u-1', slug },
    resolved: { harness: 'claude', model: 'm', persona: '', limits: {}, maxConcurrentRuns: 1 },
  };
}

function installRoutes(opts: {
  agents?: unknown[];
  mutate?: (path: string, init?: ApiInit) => Promise<unknown> | undefined;
} = {}) {
  mockApiFetch.mockImplementation((path, init) => {
    if (!init?.method && path === '/api/v1/agents') {
      return Promise.resolve({ agents: opts.agents ?? [agent('gg', 'GG'), agent('hh', 'HH'), agent('zz', 'ZZ', 'offline')] });
    }
    return opts.mutate?.(path, init) ?? Promise.resolve({});
  });
}

function renderDialog(over: { editingList?: EditingWatcher[]; onOpenChange?: (o: boolean) => void } = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onOpenChange = over.onOpenChange ?? vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <WatcherDialog
        open
        onOpenChange={onOpenChange}
        parentID="c-1"
        parentType="channel"
        threadRootID="m-1"
        editingList={over.editingList}
      />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

const editing: EditingWatcher[] = [
  { id: 'w-1', slug: 'gg', agentName: 'GG', instruction: 'ping me on deploys', actionMode: 'notify' },
  { id: 'w-2', slug: 'hh', agentName: 'HH', instruction: 'draft replies', actionMode: 'draft' },
];

beforeEach(() => {
  mockApiFetch.mockReset();
  showToast.mockReset();
});

describe('WatcherDialog create mode', () => {
  it('lists only active agents and defaults to the first', async () => {
    installRoutes();
    renderDialog();
    const select = await screen.findByLabelText('Watcher agent');
    await screen.findByRole('option', { name: 'GG' });
    const options = Array.from((select as HTMLSelectElement).options).map((o) => o.textContent);
    expect(options).toEqual(['GG', 'HH']);
    expect((select as HTMLSelectElement).value).toBe('gg');
  });

  it('requires an agent when none are available', async () => {
    installRoutes({ agents: [agent('zz', 'ZZ', 'offline')] });
    renderDialog();
    expect(await screen.findByText('No available agents')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Watcher instruction'), { target: { value: 'watch it' } });
    fireEvent.click(screen.getByTestId('watcher-confirm'));
    expect(await screen.findByTestId('watcher-error')).toHaveTextContent('Pick an agent.');
  });

  it('requires an instruction', async () => {
    installRoutes();
    renderDialog();
    await screen.findByLabelText('Watcher agent');
    fireEvent.change(screen.getByLabelText('Watcher instruction'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('watcher-confirm'));
    expect(await screen.findByTestId('watcher-error')).toHaveTextContent('Tell the watcher what to watch for and do.');
    // Typing again clears the error.
    fireEvent.change(screen.getByLabelText('Watcher instruction'), { target: { value: 'x' } });
    expect(screen.queryByTestId('watcher-error')).not.toBeInTheDocument();
  });

  it('creates a watcher with the chosen agent and mode, then closes without a toast', async () => {
    const mutate = vi.fn(() => Promise.resolve({}));
    installRoutes({ mutate });
    const { onOpenChange } = renderDialog();
    const select = await screen.findByLabelText('Watcher agent');
    await screen.findByRole('option', { name: 'HH' });
    fireEvent.change(select, { target: { value: 'hh' } });
    fireEvent.change(screen.getByLabelText('Watcher instruction'), { target: { value: '  watch deploys  ' } });
    const mode = screen.getByLabelText('Action mode');
    fireEvent.change(mode, { target: { value: 'draft' } });
    expect(screen.getByText('DMs you a ready-to-send reply. Never posts.')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('watcher-confirm'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(mutate).toHaveBeenCalledWith(
      '/api/v1/agents/hh/subscriptions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          parentID: 'c-1',
          parentType: 'channel',
          threadRootID: 'm-1',
          instruction: 'watch deploys',
          actionMode: 'draft',
        }),
      }),
    );
    expect(showToast).not.toHaveBeenCalled();
  });

  it('shows the add-flavored error and re-enables when creation fails', async () => {
    installRoutes({ mutate: () => Promise.reject(new Error('nope')) });
    renderDialog();
    await screen.findByLabelText('Watcher agent');
    fireEvent.change(screen.getByLabelText('Watcher instruction'), { target: { value: 'watch' } });
    fireEvent.click(screen.getByTestId('watcher-confirm'));
    expect(await screen.findByTestId('watcher-error')).toHaveTextContent("Couldn't add the watcher — please try again.");
    expect(screen.getByTestId('watcher-confirm')).toBeEnabled();
    expect(screen.getByTestId('watcher-confirm')).toHaveTextContent('Add watcher');
  });

  it('disables the form while the create is in flight', async () => {
    let release: (v: unknown) => void = () => {};
    installRoutes({ mutate: () => new Promise((res) => { release = res; }) });
    renderDialog();
    await screen.findByLabelText('Watcher agent');
    await screen.findByRole('option', { name: 'GG' });
    fireEvent.change(screen.getByLabelText('Watcher instruction'), { target: { value: 'watch' } });
    fireEvent.click(screen.getByTestId('watcher-confirm'));
    await waitFor(() => expect(screen.getByTestId('watcher-confirm')).toHaveTextContent('Adding…'));
    expect(screen.getByTestId('watcher-confirm')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    release({});
    await waitFor(() => expect(screen.getByTestId('watcher-confirm')).toHaveTextContent('Add watcher'));
  });

  it('shows no mode hint for an unknown action mode value', async () => {
    installRoutes();
    renderDialog();
    await screen.findByLabelText('Watcher agent');
    const mode = screen.getByLabelText('Action mode') as HTMLSelectElement;
    expect(screen.getByText('DMs you a heads-up. Never posts publicly.')).toBeInTheDocument();
    // A value outside the option list resolves to '' and no hint text.
    fireEvent.change(mode, { target: { value: 'bogus' } });
    expect(screen.queryByText('DMs you a heads-up. Never posts publicly.')).not.toBeInTheDocument();
  });

  it('cancel closes without calling the API', async () => {
    const mutate = vi.fn(() => Promise.resolve({}));
    installRoutes({ mutate });
    const { onOpenChange } = renderDialog();
    await screen.findByLabelText('Watcher agent');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('treats an empty editing list as create mode', async () => {
    installRoutes();
    renderDialog({ editingList: [] });
    expect(await screen.findByText('Add watcher to this thread')).toBeInTheDocument();
  });
});

describe('WatcherDialog manage mode', () => {
  it('offers a watcher picker when several watch the thread and switches fields', async () => {
    installRoutes();
    renderDialog({ editingList: editing });
    expect(await screen.findByText('Manage watcher')).toBeInTheDocument();
    const picker = screen.getByLabelText('Which watcher') as HTMLSelectElement;
    expect((screen.getByLabelText('Watcher instruction') as HTMLTextAreaElement).value).toBe('ping me on deploys');

    fireEvent.change(picker, { target: { value: 'w-2' } });
    expect((screen.getByLabelText('Watcher instruction') as HTMLTextAreaElement).value).toBe('draft replies');
    expect((screen.getByLabelText('Action mode') as HTMLSelectElement).value).toBe('draft');

    // A bogus selection resolves to no watcher: fields reset, header falls
    // back to the first watcher.
    fireEvent.change(picker, { target: { value: 'w-missing' } });
    expect((screen.getByLabelText('Watcher instruction') as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByLabelText('Action mode') as HTMLSelectElement).value).toBe('notify');
  });

  it('shows the agent read-only when only one watcher exists', async () => {
    installRoutes();
    renderDialog({ editingList: [editing[0]] });
    expect(await screen.findByText('Watching agent:')).toBeInTheDocument();
    expect(screen.getByText('GG')).toBeInTheDocument();
    expect(screen.queryByLabelText('Which watcher')).not.toBeInTheDocument();
  });

  it('updates the selected watcher and toasts', async () => {
    const mutate = vi.fn(() => Promise.resolve({}));
    installRoutes({ mutate });
    const { onOpenChange } = renderDialog({ editingList: editing });
    await screen.findByText('Manage watcher');
    fireEvent.change(screen.getByLabelText('Watcher instruction'), { target: { value: 'new order' } });
    fireEvent.click(screen.getByTestId('watcher-confirm'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(mutate).toHaveBeenCalledWith(
      '/api/v1/agents/gg/subscriptions/c-1/w-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ instruction: 'new order', actionMode: 'notify' }),
      }),
    );
    expect(showToast).toHaveBeenCalledWith('Watcher updated.');
  });

  it('requires an instruction in manage mode too', async () => {
    installRoutes();
    renderDialog({ editingList: editing });
    await screen.findByText('Manage watcher');
    fireEvent.change(screen.getByLabelText('Watcher instruction'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('watcher-confirm'));
    expect(await screen.findByTestId('watcher-error')).toHaveTextContent('Tell the watcher what to watch for and do.');
  });

  it('shows the edit-flavored error when the update fails', async () => {
    installRoutes({ mutate: () => Promise.reject(new Error('nope')) });
    renderDialog({ editingList: editing });
    await screen.findByText('Manage watcher');
    fireEvent.click(screen.getByTestId('watcher-confirm'));
    expect(await screen.findByTestId('watcher-error')).toHaveTextContent("Couldn't update the watcher — please try again.");
    expect(screen.getByTestId('watcher-confirm')).toHaveTextContent('Save changes');
  });

  it('deletes the watcher, toasts and closes', async () => {
    const mutate = vi.fn(() => Promise.resolve({}));
    installRoutes({ mutate });
    const { onOpenChange } = renderDialog({ editingList: editing });
    await screen.findByText('Manage watcher');
    fireEvent.click(screen.getByTestId('watcher-delete'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(mutate).toHaveBeenCalledWith(
      '/api/v1/agents/gg/subscriptions/c-1/w-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(showToast).toHaveBeenCalledWith('Watcher removed.');
  });

  it('surfaces a delete failure and re-enables the buttons', async () => {
    installRoutes({ mutate: (_p, init) => (init?.method === 'DELETE' ? Promise.reject(new Error('nope')) : Promise.resolve({})) });
    renderDialog({ editingList: editing });
    await screen.findByText('Manage watcher');
    fireEvent.click(screen.getByTestId('watcher-delete'));
    expect(await screen.findByTestId('watcher-error')).toHaveTextContent("Couldn't remove the watcher — please try again.");
    expect(screen.getByTestId('watcher-delete')).toBeEnabled();
    // The pending label shows while a save is in flight in manage mode.
    let release: (v: unknown) => void = () => {};
    installRoutes({ mutate: () => new Promise((res) => { release = res; }) });
    fireEvent.click(screen.getByTestId('watcher-confirm'));
    await waitFor(() => expect(screen.getByTestId('watcher-confirm')).toHaveTextContent('Saving…'));
    release({});
    await waitFor(() => expect(screen.getByTestId('watcher-confirm')).toHaveTextContent('Save changes'));
  });
});
