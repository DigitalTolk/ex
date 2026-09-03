import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AgentApprovalCard } from '@/components/chat/AgentApprovalCard';
import { onRunApproval, resetAgentApprovalsSessionState } from '@/stores/agent-approvals';
import type { UserMapEntry } from '@/components/chat/MessageList';

type ApiInit = { method?: string; body?: string };

const mockApiFetch = vi.fn<(path: string, init?: ApiInit) => Promise<unknown>>();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (path: string, init?: ApiInit) => mockApiFetch(path, init),
}));

let mockUser: { id: string } | undefined;
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: mockUser }),
}));

const userMap: Record<string, UserMapEntry> = { 'ag-1': { displayName: 'gg' } };

function rosterAgent(over: Record<string, unknown> = {}) {
  return {
    id: 'ag-1',
    displayName: 'gg',
    slug: 'gg',
    status: 'active',
    prefs: { userID: 'u-1', slug: 'gg' },
    resolved: { harness: 'claude', model: 'm', persona: '', limits: {}, maxConcurrentRuns: 1 },
    ...over,
  };
}

interface Routes {
  agents?: () => Promise<unknown>;
  prefs?: (path: string, init?: ApiInit) => Promise<unknown>;
  decide?: (path: string, init?: ApiInit) => Promise<unknown>;
}

function installRoutes(over: Routes = {}) {
  mockApiFetch.mockImplementation((path, init) => {
    if (!init?.method && path === '/api/v1/agents') {
      return (over.agents ?? (async () => ({ agents: [rosterAgent()] })))();
    }
    if (init?.method === 'PATCH' && path.endsWith('/prefs')) {
      return (over.prefs ?? (() => Promise.resolve(rosterAgent({ prefs: { userID: 'u-1', slug: 'gg', autoAllow: ['read'] } }))))(path, init);
    }
    if (init?.method === 'POST' && path.includes('/approvals/')) {
      return (over.decide ?? (() => Promise.resolve({})))(path, init);
    }
    return Promise.resolve({});
  });
}

function seedApproval(approvalID: string, over: Record<string, unknown> = {}) {
  act(() =>
    onRunApproval({
      approvalID,
      runID: 'run-1',
      agentID: 'ag-1',
      invokerID: 'u-1',
      parentID: 'c-1',
      state: 'pending',
      summary: 'wants to run `rm -rf tmp` now',
      ...over,
    }),
  );
}

function renderCard(parentID?: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AgentApprovalCard parentID={parentID} userMap={userMap} />
    </QueryClientProvider>,
  );
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

beforeEach(() => {
  mockApiFetch.mockReset();
  mockUser = { id: 'u-1' };
  installRoutes();
});

afterEach(() => {
  act(() => resetAgentApprovalsSessionState());
});

describe('AgentApprovalCard', () => {
  it('renders nothing without a parentID, for other invokers, or signed out', () => {
    seedApproval('ap-1');
    const { unmount } = renderCard(undefined);
    expect(screen.queryByTestId('agent-approval-card')).not.toBeInTheDocument();
    unmount();

    seedApproval('ap-2', { invokerID: 'u-2' });
    act(() => resetAgentApprovalsSessionState());
    seedApproval('ap-2', { invokerID: 'u-2' });
    const second = renderCard('c-1');
    expect(screen.queryByTestId('agent-approval-card')).not.toBeInTheDocument();
    second.unmount();

    mockUser = undefined;
    seedApproval('ap-3');
    renderCard('c-1');
    expect(screen.queryByTestId('agent-approval-card')).not.toBeInTheDocument();
  });

  it('renders a permission ask with code chips, the risk tag and both plain decide paths', async () => {
    seedApproval('ap-1', { risk: 'destructive' });
    renderCard('c-1');
    const card = screen.getByTestId('agent-approval-card');
    expect(card).toHaveTextContent('gg');
    expect(card).toHaveTextContent('is waiting for your approval');
    expect(card).toHaveTextContent('destructive');
    // `rm -rf tmp` renders as a code chip, not backticks.
    expect(within(card).getByText('rm -rf tmp').tagName).toBe('CODE');
    expect(card).not.toHaveTextContent('`');

    // Approve without a note posts {approve:true} and removes the card.
    fireEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.queryByTestId('agent-approval-card')).not.toBeInTheDocument());
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/runs/run-1/approvals/ap-1',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ approve: true }) }),
    );
  });

  it('sends the note with a deny and relabels the buttons while a note is present', async () => {
    seedApproval('ap-1');
    renderCard('c-1');
    const card = screen.getByTestId('agent-approval-card');
    // Fallback risk tag when the frame has none.
    expect(card).toHaveTextContent('approval');
    fireEvent.change(within(card).getByTestId('approval-note'), { target: { value: '  use /tmp instead  ' } });
    expect(within(card).getByRole('button', { name: /Approve with note/ })).toBeInTheDocument();
    const deny = within(card).getByTestId('approval-deny');
    expect(deny).toHaveTextContent('No — do this instead');

    fireEvent.click(deny);
    await waitFor(() => expect(screen.queryByTestId('agent-approval-card')).not.toBeInTheDocument());
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/runs/run-1/approvals/ap-1',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ approve: false, text: 'use /tmp instead' }) }),
    );
  });

  it('disables the buttons while a decision is in flight and settles even when the POST fails', async () => {
    const gate = deferred<unknown>();
    installRoutes({ decide: () => gate.promise });
    seedApproval('ap-1');
    renderCard('c-1');
    const card = screen.getByTestId('agent-approval-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(within(card).getByTestId('approval-deny')).toBeDisabled());
    expect(within(card).getByTestId('approval-note')).toBeDisabled();
    gate.reject(new Error('already settled'));
    // The catch arm still removes the card locally.
    await waitFor(() => expect(screen.queryByTestId('agent-approval-card')).not.toBeInTheDocument());
  });

  it('denies without a note, omitting the text field entirely', async () => {
    seedApproval('ap-1');
    renderCard('c-1');
    fireEvent.click(screen.getByTestId('approval-deny'));
    await waitFor(() => expect(screen.queryByTestId('agent-approval-card')).not.toBeInTheDocument());
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/runs/run-1/approvals/ap-1',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ approve: false }) }),
    );
  });

  it('renders ask_user options and settles with the picked choice', async () => {
    seedApproval('ap-1', { summary: 'Which env?', options: ['staging', 'production'] });
    renderCard('c-1');
    const card = screen.getByTestId('agent-approval-card');
    expect(card).toHaveTextContent('needs you to pick an option');
    expect(card).toHaveTextContent('question');
    expect(within(card).queryByTestId('approval-note')).not.toBeInTheDocument();

    fireEvent.click(within(card).getByRole('button', { name: /staging/ }));
    await waitFor(() => expect(screen.queryByTestId('agent-approval-card')).not.toBeInTheDocument());
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/runs/run-1/approvals/ap-1',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ approve: true, choice: 'staging' }) }),
    );
  });

  it('lets the user dismiss an ask_user card so the agent decides', async () => {
    seedApproval('ap-1', { summary: 'Which env?', options: ['staging'] });
    renderCard('c-1');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss — let it decide' }));
    await waitFor(() => expect(screen.queryByTestId('agent-approval-card')).not.toBeInTheDocument());
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/runs/run-1/approvals/ap-1',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ approve: false }) }),
    );
  });

  it('renders a drafted reply for edit + send', async () => {
    seedApproval('ap-1', { replyText: 'Draft: ship it', risk: '' });
    renderCard('c-1');
    const card = screen.getByTestId('agent-approval-card');
    expect(card).toHaveTextContent('drafted a reply');
    expect(card).toHaveTextContent('draft reply');
    const box = within(card).getByTestId('reply-proposal-text') as HTMLTextAreaElement;
    expect(box.value).toBe('Draft: ship it');

    fireEvent.change(box, { target: { value: 'Ship it tomorrow' } });
    fireEvent.click(within(card).getByTestId('reply-proposal-send'));
    await waitFor(() => expect(screen.queryByTestId('agent-approval-card')).not.toBeInTheDocument());
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/runs/run-1/approvals/ap-1',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ approve: true, text: 'Ship it tomorrow' }) }),
    );
  });

  it('disables sending an emptied draft, shows the busy spinner, and cancels without text', async () => {
    const gate = deferred<unknown>();
    installRoutes({ decide: () => gate.promise });
    seedApproval('ap-1', { replyText: 'Draft' });
    seedApproval('ap-2', { replyText: 'Other draft', runID: 'run-2' });
    renderCard('c-1');
    const cards = screen.getAllByTestId('agent-approval-card');
    expect(cards).toHaveLength(2);

    const box = within(cards[0]).getByTestId('reply-proposal-text');
    fireEvent.change(box, { target: { value: '   ' } });
    expect(within(cards[0]).getByTestId('reply-proposal-send')).toBeDisabled();
    fireEvent.change(box, { target: { value: 'ok' } });
    expect(within(cards[0]).getByTestId('reply-proposal-send')).toBeEnabled();

    // Cancel posts a denial; while it is in flight the box is disabled.
    fireEvent.click(within(cards[0]).getByRole('button', { name: /Cancel — I/ }));
    await waitFor(() => expect(box).toBeDisabled());
    gate.resolve({});
    await waitFor(() => expect(screen.getAllByTestId('agent-approval-card')).toHaveLength(1));
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/runs/run-1/approvals/ap-1',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ approve: false }) }),
    );
  });

  it('offers always-allow only for known roster agents with a kind', async () => {
    seedApproval('ap-1'); // no kind
    renderCard('c-1');
    expect(await screen.findByTestId('agent-approval-card')).toBeInTheDocument();
    expect(screen.queryByTestId('approval-always-allow')).not.toBeInTheDocument();
  });

  it('hides always-allow when the agent is not in the roster', async () => {
    installRoutes({ agents: async () => ({ agents: [rosterAgent({ id: 'ag-other' })] }) });
    seedApproval('ap-1', { kind: 'read' });
    renderCard('c-1');
    expect(await screen.findByTestId('agent-approval-card')).toBeInTheDocument();
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/agents', undefined));
    expect(screen.queryByTestId('approval-always-allow')).not.toBeInTheDocument();
  });

  it('always-allow saves the pref then approves every pending gate of that kind', async () => {
    const prefs = vi.fn(() => Promise.resolve(rosterAgent({ prefs: { userID: 'u-1', slug: 'gg', autoAllow: ['read'] } })));
    const decide = vi.fn(() => Promise.resolve({}));
    installRoutes({ prefs, decide });
    seedApproval('ap-1', { kind: 'read', summary: 'read `a.txt`' });
    seedApproval('ap-2', { kind: 'read', runID: 'run-2', summary: 'read `b.txt`' });
    seedApproval('ap-3', { kind: 'shell', summary: 'run `ls`' });
    renderCard('c-1');

    const buttons = await screen.findAllByTestId('approval-always-allow');
    expect(buttons[0]).toHaveTextContent('Always allow read files');
    fireEvent.click(buttons[0]);

    await waitFor(() => expect(screen.getAllByTestId('agent-approval-card')).toHaveLength(1));
    expect(prefs).toHaveBeenCalledWith(
      '/api/v1/agents/gg/prefs',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ autoAllow: ['read'] }) }),
    );
    expect(decide).toHaveBeenCalledTimes(2);
    expect(decide).toHaveBeenCalledWith('/api/v1/runs/run-1/approvals/ap-1', expect.objectContaining({ body: JSON.stringify({ approve: true }) }));
    expect(decide).toHaveBeenCalledWith('/api/v1/runs/run-2/approvals/ap-2', expect.objectContaining({ body: JSON.stringify({ approve: true }) }));
    // The shell gate stays pending.
    expect(screen.getByTestId('agent-approval-card')).toHaveTextContent('ls');
  });

  it('skips the pref save when the kind is already auto-allowed', async () => {
    const prefs = vi.fn(() => Promise.resolve(rosterAgent()));
    installRoutes({
      agents: async () => ({ agents: [rosterAgent({ prefs: { userID: 'u-1', slug: 'gg', autoAllow: ['read'] } })] }),
      prefs,
    });
    seedApproval('ap-1', { kind: 'read' });
    renderCard('c-1');
    fireEvent.click(await screen.findByTestId('approval-always-allow'));
    await waitFor(() => expect(screen.queryByTestId('agent-approval-card')).not.toBeInTheDocument());
    expect(prefs).not.toHaveBeenCalled();
  });

  it('still approves when the pref save fails, and settles when an approval POST fails', async () => {
    const decide = vi.fn(() => Promise.reject(new Error('raced the timeout')));
    installRoutes({ prefs: () => Promise.reject(new Error('nope')), decide });
    seedApproval('ap-1', { kind: 'web' });
    renderCard('c-1');
    fireEvent.click(await screen.findByTestId('approval-always-allow'));
    await waitFor(() => expect(screen.queryByTestId('agent-approval-card')).not.toBeInTheDocument());
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('falls back to the raw kind for classes outside the preset list and to "agent" without a user map', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    seedApproval('ap-1', { kind: 'mystery' });
    render(
      <QueryClientProvider client={qc}>
        <AgentApprovalCard parentID="c-1" />
      </QueryClientProvider>,
    );
    const button = await screen.findByTestId('approval-always-allow');
    expect(button).toHaveTextContent('Always allow mystery');
    expect(button.title).toContain('wants to mystery');
    expect(screen.getByTestId('agent-approval-card')).toHaveTextContent('agent');
    // Busy state pins the always-allow button too.
    const gate = deferred<unknown>();
    installRoutes({ decide: () => gate.promise, prefs: () => gate.promise });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    gate.resolve(rosterAgent());
    await waitFor(() => expect(screen.queryByTestId('agent-approval-card')).not.toBeInTheDocument());
  });
});
