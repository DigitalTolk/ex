import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessageItem } from '@/components/chat/MessageItem';
import { closeRunDrawer, useRunDrawerStore } from '@/stores/run-drawer';
import type { AgentSubscription, AgentView } from '@/hooks/useAgents';
import type { Message } from '@/types';
import { MESSAGE_LONG_PRESS_MS } from '@/hooks/useLongPress';

vi.mock('@/components/ui/dropdown-menu');

type ApiInit = { method?: string; body?: string };
const mockApiFetch = vi.fn<(path: string, init?: ApiInit) => Promise<unknown>>(() => Promise.resolve({}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (path: string, init?: ApiInit) => mockApiFetch(path, init),
}));

vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
}));

let mockWatchers: AgentSubscription[] = [];
let mockRoster: AgentView[] = [];
vi.mock('@/hooks/useAgents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useAgents')>()),
  useParentWatchers: () => ({ data: mockWatchers }),
  useAgents: () => ({ data: mockRoster }),
  useSkills: () => ({
    data: [
      { id: 'sk1', name: 'Weekly Report', description: 'digest' },
      { id: 'sk2', name: '---', description: 'normalizes to nothing' },
    ],
  }),
}));
vi.mock('@/hooks/useConnectors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useConnectors')>()),
  useConnectors: () => ({
    data: [
      { slug: 'gitlab', title: 'GitLab', description: 'MRs', baseURL: '', authKind: 'none', installed: true },
      { slug: 'trello', title: 'Trello', description: 'Boards', baseURL: '', authKind: 'none', installed: false },
    ],
  }),
}));

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    parentID: 'ch-1',
    authorID: 'u-1',
    body: 'hello',
    createdAt: '2026-04-24T10:30:00Z',
    ...overrides,
  };
}

function agent(id: string, slug: string, displayName: string): AgentView {
  return {
    id,
    slug,
    displayName,
    status: 'active',
    prefs: { userID: 'u-1', slug },
    resolved: { harness: 'claude', model: 'm', persona: '', limits: {}, maxConcurrentRuns: 1 },
  };
}

function watcher(over: Partial<AgentSubscription>): AgentSubscription {
  return {
    id: 'w-1',
    agentID: 'ag-1',
    creatorID: 'u-1',
    parentID: 'ch-1',
    parentType: 'channel',
    threadRootID: 'msg-1',
    ...over,
  };
}

function renderItem(message: Message, extra: Partial<Parameters<typeof MessageItem>[0]> = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <MessageItem message={message} authorName="Alice" isOwn={false} channelId="ch-1" currentUserId="u-1" {...extra} />
      </BrowserRouter>
    </QueryClientProvider>,
  );
  // The hover toolbar mounts on hover (MessageItem): hover the first row so
  // the tests can reach its actions the way a pointer user does.
  const row = result.container.querySelector('[data-message-id]');
  if (row) {
    fireEvent.pointerOver(row, { pointerType: 'mouse' });
    fireEvent.mouseEnter(row);
  }
  return result;
}

function longPress(el: Element) {
  vi.useFakeTimers();
  fireEvent.pointerDown(el, { clientX: 10, clientY: 10, pointerType: 'touch' });
  act(() => {
    vi.advanceTimersByTime(MESSAGE_LONG_PRESS_MS + 10);
  });
  vi.useRealTimers();
}

beforeEach(() => {
  mockApiFetch.mockClear();
  mockWatchers = [];
  mockRoster = [];
});

afterEach(() => {
  act(() => closeRunDrawer());
});

describe('MessageItem agent affordances', () => {
  it("shows a design agent's compare button and note suggestion, never the hidden markers", () => {
    renderItem(
      makeMessage({
        agentInvokerID: 'u-1',
        body: 'v2 — tiles\n<!-- ex:before acme/REF -->\n<!-- ex:design-note acme | Radius is 4px -->',
        // Agent posts always arrive server-rendered; the server drops HTML
        // comments, so the markers never reach the rendered tree.
        rendered: { type: 'root', children: [{ type: 'element', tagName: 'p', children: [{ type: 'text', value: 'v2 — tiles' }] }] },
      }),
    );
    expect(screen.getByRole('button', { name: 'Compare with the real page' })).toBeInTheDocument();
    expect(screen.getByTestId('design-note-suggestion')).toHaveTextContent('Radius is 4px');
    expect(screen.queryByText(/ex:before/)).not.toBeInTheDocument();
  });

  it('shows who invoked an agent post and opens the run drawer from the badge for the invoker', () => {
    const userMap = new Map([['u-1', { displayName: 'Me' }]]);
    renderItem(makeMessage({ agentInvokerID: 'u-1', agentRunID: 'run-7' }), { userMap });
    const badge = screen.getByLabelText('Invoked by Me');
    expect(badge).toHaveTextContent('for Me');
    expect(badge).toHaveAttribute('title', 'Show agent activity');
    fireEvent.click(badge);
    expect(useRunDrawerStore.getState().runID).toBe('run-7');
  });

  it("someone else's run gets an inert badge and no activity menu — logs are invoker-only", () => {
    const userMap = new Map([['u-9', { displayName: 'Bob' }]]);
    renderItem(makeMessage({ agentInvokerID: 'u-9', agentRunID: 'run-7', parentMessageID: 'root-1' }), { userMap });
    const badge = screen.getByLabelText('Invoked by Bob');
    expect(badge).toBeDisabled();
    expect(badge).not.toHaveAttribute('title');
    fireEvent.click(badge);
    expect(useRunDrawerStore.getState().runID).toBeNull();
    expect(screen.queryByLabelText('Show agent activity')).not.toBeInTheDocument();
  });

  it('renders the badge inert without a run link and generic without a user map', () => {
    renderItem(makeMessage({ agentInvokerID: 'u-9' }));
    const badge = screen.getByLabelText('Invoked by a teammate');
    expect(badge).toBeDisabled();
    expect(badge).not.toHaveAttribute('title');
    fireEvent.click(badge);
    expect(useRunDrawerStore.getState().runID).toBeNull();
  });

  it('opens the whole-thread activity from the menu on a thread root', () => {
    renderItem(makeMessage({ replyCount: 2 }));
    fireEvent.click(screen.getByLabelText('Show agent activity'));
    expect(useRunDrawerStore.getState().thread).toEqual({ parentID: 'ch-1', rootID: 'msg-1' });
  });

  it('opens the single run from the menu on an agent reply', () => {
    renderItem(makeMessage({ parentMessageID: 'root-1', agentRunID: 'run-3' }));
    fireEvent.click(screen.getByLabelText('Show agent activity'));
    expect(useRunDrawerStore.getState().runID).toBe('run-3');
  });

  it('offers no activity entry for plain human messages', () => {
    renderItem(makeMessage());
    expect(screen.queryByLabelText('Show agent activity')).not.toBeInTheDocument();
  });

  it('opens the add-watcher dialog from "Watch thread…" with the thread root', () => {
    renderItem(makeMessage({ parentMessageID: 'root-9', parentType: 'conversation' }), {
      channelId: undefined,
      conversationId: 'ch-1',
    });
    // The shared dropdown mock rewrites data-testid, so target the aria-label.
    fireEvent.click(screen.getByLabelText('Add a watcher to this thread'));
    expect(screen.getByTestId('watcher-dialog')).toBeInTheDocument();
    expect(screen.getByText('Add watcher to this thread')).toBeInTheDocument();
  });

  it('opens the add-watcher dialog for a channel thread root keyed by the message itself', () => {
    renderItem(makeMessage());
    fireEvent.click(screen.getByLabelText('Add a watcher to this thread'));
    expect(screen.getByTestId('watcher-dialog')).toBeInTheDocument();
  });

  // The same actions on a phone as with a mouse: the sheet offers it too.
  it('opens the add-watcher dialog from the mobile action sheet', () => {
    const { container } = renderItem(makeMessage());
    longPress(container.querySelector('#msg-msg-1') as Element);
    const sheet = screen.getByTestId('mobile-message-actions');
    fireEvent.click(within(sheet).getByLabelText('Add a watcher to this thread'));
    expect(screen.queryByTestId('mobile-message-actions')).toBeNull();
    expect(screen.getByTestId('watcher-dialog')).toBeInTheDocument();
  });

  it('routes a replyless agent root through the run drawer on desktop and mobile', () => {
    const first = renderItem(makeMessage({ agentRunID: 'run-8' }));
    fireEvent.click(screen.getByLabelText('Show agent activity'));
    expect(useRunDrawerStore.getState().runID).toBe('run-8');
    act(() => closeRunDrawer());
    first.unmount();

    const { container } = renderItem(makeMessage({ agentRunID: 'run-9' }));
    longPress(container.querySelector('#msg-msg-1') as Element);
    fireEvent.click(within(screen.getByTestId('mobile-message-actions')).getByLabelText('Show agent activity'));
    expect(useRunDrawerStore.getState().runID).toBe('run-9');
  });

  it('badges a watched thread root and manages the watchers behind it', () => {
    mockWatchers = [
      watcher({ id: 'w-1', agentID: 'ag-1', instruction: 'ping me', actionMode: 'notify' }),
      watcher({ id: 'w-2', agentID: 'ag-ghost' }),
      watcher({ id: 'w-other', threadRootID: 'other-msg' }),
    ];
    mockRoster = [agent('ag-1', 'gg', 'GG')];
    renderItem(makeMessage());
    const indicator = screen.getByTestId('watcher-indicator');
    expect(indicator).toHaveTextContent('Watching ·2');

    fireEvent.click(indicator);
    const dialog = screen.getByTestId('watcher-dialog');
    expect(within(dialog).getByText('Manage watcher')).toBeInTheDocument();
    // Roster-resolved and unknown agents both appear in the picker.
    const options = Array.from((within(dialog).getByLabelText('Which watcher') as HTMLSelectElement).options).map(
      (o) => o.textContent,
    );
    expect(options).toEqual(['GG', 'an agent']);

    // Closing the dialog clears the manage state.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('watcher-dialog')).not.toBeInTheDocument();
  });

  it('labels a single watcher without a count and manages it on conversation parents too', () => {
    mockWatchers = [watcher({ id: 'w-1', agentID: 'ag-1', parentType: 'conversation' })];
    mockRoster = [agent('ag-1', 'gg', 'GG')];
    renderItem(makeMessage({ parentType: 'conversation' }), { channelId: undefined, conversationId: 'ch-1' });
    const indicator = screen.getByTestId('watcher-indicator');
    expect(indicator).toHaveTextContent(/^Watching$/);
    fireEvent.click(indicator);
    expect(screen.getByText('Manage watcher')).toBeInTheDocument();
  });

  it('long-press opens the mobile sheet whose activity entry routes to the thread drawer', () => {
    const { container } = renderItem(makeMessage({ replyCount: 1 }));
    longPress(container.querySelector('#msg-msg-1') as Element);
    const sheet = screen.getByTestId('mobile-message-actions');
    fireEvent.click(within(sheet).getByLabelText('Show agent activity'));
    expect(useRunDrawerStore.getState().thread).toEqual({ parentID: 'ch-1', rootID: 'msg-1' });
    expect(screen.queryByTestId('mobile-message-actions')).not.toBeInTheDocument();
  });

  it('routes the mobile activity entry to the run drawer for agent replies', () => {
    const { container } = renderItem(makeMessage({ parentMessageID: 'root-1', agentRunID: 'run-5' }));
    longPress(container.querySelector('#msg-msg-1') as Element);
    fireEvent.click(within(screen.getByTestId('mobile-message-actions')).getByLabelText('Show agent activity'));
    expect(useRunDrawerStore.getState().runID).toBe('run-5');
  });

  it('badges the skills a run used next to the invoker tag', () => {
    const userMap = new Map([['u-9', { displayName: 'Bob' }]]);
    renderItem(
      makeMessage({ agentInvokerID: 'u-9', agentRunID: 'run-7', agentSkills: ['Weekly Report', 'Audit'] }),
      { userMap },
    );
    // An icon, not an emoji (no emojis in the UI).
    const badge = screen.getByLabelText('Used skill Weekly Report');
    expect(badge.textContent).toBe('Weekly Report');
    expect(badge.querySelector('svg.lucide-zap')).not.toBeNull();
    expect(screen.getByLabelText('Used skill Audit')).toBeInTheDocument();
  });

  it('renders known /pick tokens (installed connector, skill) as pills in the sent message', () => {
    renderItem(makeMessage({ body: 'use /gitlab and /weekly-report but /trello stays text' }));
    const pills = Array.from(document.querySelectorAll('[data-testid="pick-pill"]')).map(
      (p) => p.textContent,
    );
    // trello isn't installed, so its token stays plain text.
    expect(pills).toEqual(['/gitlab', '/weekly-report']);
  });

  it('renders artifact markers as artifact cards and task markers as task cards', () => {
    // Cards are for agent-run posts: the server stamps agentRunID.
    renderItem(makeMessage({ agentRunID: 'RUN1', body: '[artifact:RUN1:ART1|Design doc|markdown|2048]' }));
    expect(screen.getByTestId('artifact-card')).toBeInTheDocument();
    expect(screen.getByText('Design doc')).toBeInTheDocument();

    renderItem(makeMessage({ id: 'msg-2', agentRunID: 'RUN2', body: '[task:TSK1|Fix login|created|bug|ex]' }));
    expect(screen.getByTestId('task-card')).toBeInTheDocument();
    expect(screen.getByText('Fix login')).toBeInTheDocument();
  });

  it('leaves markers a person typed as plain text — no live card, no sign-off', () => {
    renderItem(makeMessage({ id: 'msg-3', body: '[task:TSK1|Fix login|awaiting_user_test|bug|ex]' }));
    renderItem(makeMessage({ id: 'msg-4', body: '[artifact:RUN1:ART1|Design doc|markdown|2048]' }));
    expect(screen.queryByTestId('task-card')).toBeNull();
    expect(screen.queryByTestId('artifact-card')).toBeNull();
    // (":RUN1:" renders through the emoji-shortcode element, so match the text
    // across elements.)
    expect(document.body).toHaveTextContent('[task:TSK1|Fix login|awaiting_user_test|bug|ex]');
    expect(document.body).toHaveTextContent('[artifact:RUN1:ART1|Design doc|markdown|2048]');
  });

  it('shows no artifact card for an artifact of another run', () => {
    renderItem(makeMessage({ id: 'msg-5', agentRunID: 'RUN9', body: '[artifact:RUN1:ART1|Design doc|markdown|2048]' }));
    expect(screen.queryByTestId('artifact-card')).toBeNull();
    expect(document.body).toHaveTextContent('[artifact:RUN1:ART1|Design doc|markdown|2048]');
  });
});
