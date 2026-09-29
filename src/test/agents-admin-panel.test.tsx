import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AgentsAdminPanel } from '@/components/admin/AgentsAdminPanel';
import type { AgentView } from '@/hooks/useAgents';

type ApiInit = { method?: string; body?: string };
const mockApiFetch = vi.fn<(path: string, init?: ApiInit) => Promise<unknown>>();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (path: string, init?: ApiInit) => mockApiFetch(path, init),
}));

// gg: claude, a prompt, nobody has overridden it.
// qib: bedrock with a real profile id, and people HAVE overridden it.
function agents(): AgentView[] {
  return [
    {
      id: 'ag-gg',
      displayName: 'gg',
      slug: 'gg',
      status: 'active',
      prefs: { userID: 'u-1', slug: 'gg' },
      resolved: { harness: 'claude', model: 'claude-opus-5', persona: 'Be gg.', limits: {}, maxConcurrentRuns: 1 },
      defaultPersona: 'Be gg.',
      defaultHarness: 'claude',
      defaultModel: 'claude-opus-5',
    },
    {
      id: 'ag-qib',
      displayName: 'qib',
      slug: 'qib',
      status: 'active',
      // The viewing admin has their OWN pin here — the panel must still show
      // the template, never these values.
      prefs: { userID: 'u-1', slug: 'qib', harness: 'bedrock', model: 'mine-not-theirs' },
      resolved: { harness: 'bedrock', model: 'mine-not-theirs', persona: 'Be qib.', limits: {}, maxConcurrentRuns: 1 },
      defaultPersona: 'Be qib.',
      defaultHarness: 'bedrock',
      defaultModel: 'eu.anthropic.claude-opus-5',
      defaultExecutionMode: 'server',
    },
    // No default* fields at all: an agent whose model was never pinned. The
    // row must fall back rather than render "undefined".
    {
      id: 'ag-bare',
      displayName: 'bare',
      slug: 'bare',
      status: 'offline',
      prefs: { userID: 'u-1', slug: 'bare' },
      resolved: { harness: 'claude', model: '', persona: '', limits: {}, maxConcurrentRuns: 1 },
    },
  ];
}

let overrideCounts: Record<string, number | Error>;

function setup(list: AgentView[] | Error = agents()) {
  mockApiFetch.mockImplementation((path, init) => {
    if (path === '/api/v1/agents') {
      // Fresh objects each fetch: returning the same references would let
      // react-query's structural sharing conclude nothing changed after a
      // PATCH, so the row would never re-render with the new defaults.
      return list instanceof Error
        ? Promise.reject(list)
        : Promise.resolve({ agents: list.map((a) => ({ ...a })) });
    }
    const overrides = /^\/api\/v1\/agents\/([^/]+)\/overrides$/.exec(path);
    if (overrides) {
      const v = overrideCounts[overrides[1]];
      if (v instanceof Error) return Promise.reject(v);
      if (init?.method === 'DELETE') {
        overrideCounts[overrides[1]] = 0;
        return Promise.resolve({ cleared: v });
      }
      return Promise.resolve({ count: v });
    }
    // A PATCH really changes the template, so the invalidated refetch returns
    // the new defaults — which is what settles the form's dirty state and is
    // therefore what makes "Saved." appear at all.
    const patch = /^\/api\/v1\/agents\/([^/]+)$/.exec(path);
    if (patch && init?.method === 'PATCH' && !(list instanceof Error)) {
      const body = JSON.parse(init.body!) as Record<string, string>;
      const agent = list.find((a) => a.slug === patch[1]);
      if (agent) {
        agent.defaultHarness = body.harness;
        agent.defaultModel = body.model;
        agent.defaultExecutionMode = body.executionMode;
        agent.defaultPersona = body.persona;
      }
      return Promise.resolve({ agent });
    }
    return Promise.resolve({ agent: {} });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AgentsAdminPanel />
    </QueryClientProvider>,
  );
}

async function openRow(slug: string) {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`@${slug}`) }));
  return screen.getByTestId(`admin-agent-${slug}`);
}

beforeEach(() => {
  mockApiFetch.mockReset();
  overrideCounts = { gg: 0, qib: 3, bare: 0 };
});

describe('AgentsAdminPanel', () => {
  it('lists agents collapsed, showing each template summary', async () => {
    setup();
    expect(await screen.findByRole('button', { name: /@gg/ })).toBeInTheDocument();
    // The SUMMARY is the template's, not the viewer's: the admin has pinned
    // "mine-not-theirs" on qib and must not see it labelled as the default.
    expect(screen.getByRole('button', { name: /@qib/ }).textContent).toContain(
      'eu.anthropic.claude-opus-5',
    );
    expect(screen.getByRole('button', { name: /@qib/ }).textContent).not.toContain('mine-not-theirs');
    // Collapsed: no form fields yet, and no override count fetched.
    expect(screen.queryByLabelText('Backend')).not.toBeInTheDocument();
  });

  it('shows a skeleton while loading and an empty state with no agents', async () => {
    const { unmount } = setup([]);
    expect(await screen.findByText('No shared agents yet.')).toBeInTheDocument();
    unmount();
  });

  it('opens a row and edits the prompt, backend and model', async () => {
    setup();
    await openRow('gg');

    const persona = screen.getByLabelText('Prompt') as HTMLTextAreaElement;
    expect(persona.value).toBe('Be gg.');
    const save = screen.getByRole('button', { name: 'Save default' });
    // Nothing changed yet.
    expect(save).toBeDisabled();

    fireEvent.change(persona, { target: { value: 'Be brief.' } });
    expect(save).toBeEnabled();

    fireEvent.change(screen.getByLabelText('Backend'), { target: { value: 'bedrock' } });
    // Switching to bedrock explains the id is unvalidated.
    expect(screen.getByText(/Bedrock ids are not validated here/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: ' eu.anthropic.x ' } });

    fireEvent.click(save);
    await waitFor(() => {
      const call = mockApiFetch.mock.calls.find(([p, i]) => p === '/api/v1/agents/gg' && i?.method === 'PATCH');
      expect(call).toBeTruthy();
      // harness must ride along or the server skips the engine block entirely;
      // model and prompt are trimmed; bedrock forces server execution.
      expect(JSON.parse(call![1]!.body!)).toEqual({
        harness: 'bedrock',
        model: 'eu.anthropic.x',
        executionMode: 'server',
        persona: 'Be brief.',
      });
    });
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('refuses to save a blank prompt', async () => {
    setup();
    await openRow('gg');
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: '   ' } });
    // Blank would leave everyone without an override running with no
    // instructions, since Resolve falls back to the template persona.
    expect(screen.getByRole('button', { name: 'Save default' })).toBeDisabled();
  });

  it('sends an empty execution mode for a non-bedrock backend', async () => {
    setup();
    await openRow('qib');
    fireEvent.change(screen.getByLabelText('Backend'), { target: { value: 'claude' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save default' }));
    await waitFor(() => {
      const call = mockApiFetch.mock.calls.find(([p, i]) => p === '/api/v1/agents/qib' && i?.method === 'PATCH');
      expect(JSON.parse(call![1]!.body!).executionMode).toBe('');
    });
  });

  it('surfaces a save failure', async () => {
    setup();
    await openRow('gg');
    mockApiFetch.mockImplementationOnce(() => Promise.reject(new Error('nope')));
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'changed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save default' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('nope');
  });

  it('reports when nobody has their own settings', async () => {
    setup();
    await openRow('gg');
    expect(await screen.findByText(/Nobody has their own settings/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reset everyone/ })).not.toBeInTheDocument();
  });

  it('reports a failed override check without offering a reset', async () => {
    overrideCounts = { gg: new Error('boom'), qib: 0 };
    setup();
    await openRow('gg');
    expect(await screen.findByText(/Could not check who has their own settings/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reset everyone/ })).not.toBeInTheDocument();
  });

  it('uses the singular for one person', async () => {
    overrideCounts = { gg: 1, qib: 0 };
    setup();
    await openRow('gg');
    expect(await screen.findByText(/1 person has their own settings/)).toBeInTheDocument();
  });

  it('confirms before resetting, and can be cancelled', async () => {
    setup();
    await openRow('qib');
    fireEvent.click(await screen.findByRole('button', { name: /Reset everyone/ }));
    // The confirm spells out that a prefs row is ONE document.
    expect(screen.getByText(/prompt, model, limits, follow-up settings and pre-approved/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/It cannot be undone/)).not.toBeInTheDocument();
    expect(
      mockApiFetch.mock.calls.some(([, i]) => i?.method === 'DELETE'),
    ).toBe(false);
  });

  it('resets everyone and re-reads the count', async () => {
    setup();
    await openRow('qib');
    fireEvent.click(await screen.findByRole('button', { name: /Reset everyone/ }));
    fireEvent.click(screen.getByRole('button', { name: /Reset 3 people/ }));

    await waitFor(() => {
      expect(
        mockApiFetch.mock.calls.some(
          ([p, i]) => p === '/api/v1/agents/qib/overrides' && i?.method === 'DELETE',
        ),
      ).toBe(true);
    });
    expect(await screen.findByText(/Nobody has their own settings/)).toBeInTheDocument();
  });

  it('surfaces a failed reset', async () => {
    setup();
    await openRow('qib');
    fireEvent.click(await screen.findByRole('button', { name: /Reset everyone/ }));
    mockApiFetch.mockImplementationOnce(() => Promise.reject(new Error('denied')));
    fireEvent.click(screen.getByRole('button', { name: /Reset 3 people/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('denied');
  });

  it('collapses again, dropping the form', async () => {
    setup();
    await openRow('gg');
    expect(screen.getByLabelText('Prompt')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /@gg/ }));
    expect(screen.queryByLabelText('Prompt')).not.toBeInTheDocument();
  });
});

describe('AgentsAdminPanel — fallbacks and failure shapes', () => {
  it('falls back for an agent with no template engine recorded', async () => {
    setup();
    const summary = await screen.findByRole('button', { name: /@bare/ });
    // Backend falls back to claude; an absent model adds no " · " suffix.
    expect(summary.textContent).toContain('claude');
    expect(summary.textContent).not.toContain('·');
    expect(summary.textContent).not.toContain('undefined');

    await openRow('bare');
    expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('');
    // An empty prompt cannot be saved, so a bare agent starts un-saveable.
    expect(screen.getByRole('button', { name: 'Save default' })).toBeDisabled();
  });

  it('shows a generic message when a save rejects with a non-Error', async () => {
    setup();
    await openRow('gg');
    mockApiFetch.mockImplementationOnce(() => Promise.reject('just a string'));
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'changed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save default' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Save failed');
  });

  it('shows a generic message when a reset rejects with a non-Error', async () => {
    setup();
    await openRow('qib');
    fireEvent.click(await screen.findByRole('button', { name: /Reset everyone/ }));
    mockApiFetch.mockImplementationOnce(() => Promise.reject('just a string'));
    fireEvent.click(screen.getByRole('button', { name: /Reset 3 people/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Reset failed');
  });

  it('disables the reset button while it is in flight', async () => {
    setup();
    await openRow('qib');
    fireEvent.click(await screen.findByRole('button', { name: /Reset everyone/ }));

    let release: (v: unknown) => void = () => {};
    mockApiFetch.mockImplementationOnce(() => new Promise((res) => { release = res; }));
    fireEvent.click(screen.getByRole('button', { name: /Reset 3 people/ }));

    const pending = await screen.findByRole('button', { name: 'Resetting…' });
    expect(pending).toBeDisabled();
    release({ cleared: 3 });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Resetting…' })).not.toBeInTheDocument());
  });
});
