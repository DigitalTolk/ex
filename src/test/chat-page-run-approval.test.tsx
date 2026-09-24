// Coverage for ChatPage's onRunApproval WS handler: the blocking-gate desktop
// alert derived from run.approval frames (guards, invoker addressing, deep-link
// resolution for conversation/channel parents, and payload normalization into
// NotificationContext.notifyApproval). Mock harness mirrors
// chat-page-events.test.tsx — with notifyApproval actually mocked, which that
// suite omits (its useNotifications stub predates the approval path).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ChatPage from '@/pages/ChatPage';
import { resetAgentApprovalsSessionState } from '@/stores/agent-approvals';
import { resetAgentRunsSessionState, useAgentRunsStore } from '@/stores/agent-runs';

let capturedOptions: Record<string, ((data: unknown) => void) | boolean | undefined> = {};

const authUserMock = vi.hoisted(() => ({
  current: { id: 'u-me', email: 'a@b.c', displayName: 'Me', systemRole: 'member', status: 'active' } as {
    id: string;
    email: string;
    displayName: string;
    systemRole: string;
    status: string;
  } | null,
}));

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: (opts: Record<string, ((data: unknown) => void) | boolean | undefined>) => {
    capturedOptions = opts;
  },
}));

const logoutMock = vi.fn().mockResolvedValue(undefined);
const patchUserMock = vi.fn();
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: authUserMock.current,
    isAuthenticated: true,
    isLoading: false,
    logout: logoutMock,
    patchUser: patchUserMock,
  }),
}));

const markThreadNotificationUnread = vi.fn();
vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({
    markThreadNotificationUnread,
    unhideConversation: vi.fn(),
    unreadThreadNotifications: new Set(),
    hiddenConversations: new Set(),
    hideConversation: vi.fn(),
    setActiveChannel: vi.fn(),
    setActiveConversation: vi.fn(),
    isActiveChannel: vi.fn(() => false),
    isActiveConversation: vi.fn(() => false),
    setActiveThread: vi.fn(),
    isActiveThread: vi.fn(() => false),
  }),
}));

const setUserOnline = vi.fn();
const refreshPresence = vi.fn();
vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({
    online: new Set<string>(),
    isOnline: () => false,
    setUserOnline,
    refreshPresence,
  }),
  PresenceProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const notifyApproval = vi.fn();
const dispatchNotification = vi.fn();
const setCurrentUserID = vi.fn();
const setActiveParent = vi.fn();
vi.mock('@/context/NotificationContext', () => ({
  useNotifications: () => ({
    dispatch: dispatchNotification,
    notifyApproval,
    setCurrentUserID,
    setActiveParent,
    permission: 'default',
  }),
  NotificationProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/hooks/useChannels', () => ({
  useUserChannels: () => ({ data: [] }),
  useChannelBySlug: () => ({ data: undefined }),
  useCreateChannel: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useConversations', () => ({
  useOpenDM: () => ({ openDM: vi.fn(), isPending: false }),
  useUserConversations: () => ({ data: [] }),
  useCreateConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useSearchUsers: () => ({ data: [] }),
}));

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue(undefined),
  getAccessToken: () => null,
  ApiError: class extends Error {
    status = 0;
  },
}));

vi.mock('@/context/ThemeContext', () => ({
  useTheme: () => ({ theme: 'system', setTheme: vi.fn() }),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

function renderAt(path: string, qcSeed?: (qc: QueryClient) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qcSeed?.(qc);
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/*" element={<ChatPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

function fireApproval(data: unknown) {
  const handler = capturedOptions.onRunApproval as (d: unknown) => void;
  act(() => handler(data));
}

// A frame that passes every guard: fresh pending gate addressed to u-me.
function approval(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    approvalID: 'ap-1',
    runID: 'run-1',
    invokerID: 'u-me',
    parentID: 'dm-9',
    parentType: 'conversation',
    state: 'pending',
    summary: 'Run a shell command',
    ...overrides,
  };
}

describe('ChatPage onRunApproval — blocking-gate desktop alert', () => {
  beforeEach(() => {
    capturedOptions = {};
    notifyApproval.mockReset();
    authUserMock.current = {
      id: 'u-me',
      email: 'a@b.c',
      displayName: 'Me',
      systemRole: 'member',
      status: 'active',
    };
  });

  afterEach(() => {
    // The approvals store is module-global; drop entries (and their sweep
    // timer) so one test's pending gate can't leak into the next.
    act(() => resetAgentApprovalsSessionState());
    act(() => resetAgentRunsSessionState());
  });

  it('exposes an onRunApproval handler', () => {
    renderAt('/');
    expect(typeof capturedOptions.onRunApproval).toBe('function');
  });

  it('ignores frames that are not a fresh pending gate', () => {
    renderAt('/');
    // Not an object at all.
    fireApproval(null);
    // No approvalID.
    fireApproval({ runID: 'run-1', parentID: 'dm-9', state: 'pending' });
    // No parentID.
    fireApproval({ approvalID: 'ap-1', runID: 'run-1', state: 'pending' });
    // Settle frame — clears the card, never alerts.
    fireApproval(approval({ state: 'approved' }));
    // Missing state.
    fireApproval(approval({ state: undefined }));
    expect(notifyApproval).not.toHaveBeenCalled();
  });

  it('only alerts the invoker — gates addressed to someone else stay silent', () => {
    renderAt('/');
    fireApproval(approval({ invokerID: 'u-other' }));
    expect(notifyApproval).not.toHaveBeenCalled();
  });

  it('stays silent when the session has no usable user id', () => {
    authUserMock.current = {
      id: '',
      email: 'a@b.c',
      displayName: 'Me',
      systemRole: 'member',
      status: 'active',
    };
    renderAt('/');
    fireApproval(approval({ invokerID: '' }));
    expect(notifyApproval).not.toHaveBeenCalled();
  });

  it('alerts a conversation gate with the full payload and a conversation deep link', () => {
    renderAt('/');
    fireApproval(
      approval({
        agentName: 'dev',
        options: ['Yes', 'No'],
        messageID: 'm-1',
      }),
    );
    expect(notifyApproval).toHaveBeenCalledTimes(1);
    expect(notifyApproval).toHaveBeenCalledWith({
      approvalID: 'ap-1',
      runID: 'run-1',
      parentID: 'dm-9',
      parentType: 'conversation',
      agentName: 'dev',
      summary: 'Run a shell command',
      asksChoice: true,
      options: ['Yes', 'No'],
      messageID: 'm-1',
      deepLink: '/conversation/dm-9',
    });
  });

  it('resolves a channel deep link from the cached channel list and normalizes a sparse frame', () => {
    renderAt('/', (qc) => {
      qc.setQueryData(['userChannels'], [
        { channelID: 'ch-0', channelName: 'random' },
        { channelID: 'ch-7', channelName: 'General Stuff' },
      ]);
    });
    // Sparse frame: no runID/agentName/summary/options/messageID. The alert
    // still fires with normalized fallbacks.
    fireApproval({
      approvalID: 'ap-2',
      invokerID: 'u-me',
      parentID: 'ch-7',
      parentType: 'channel',
      state: 'pending',
    });
    expect(notifyApproval).toHaveBeenCalledTimes(1);
    expect(notifyApproval).toHaveBeenCalledWith({
      approvalID: 'ap-2',
      runID: '',
      parentID: 'ch-7',
      parentType: 'channel',
      agentName: undefined,
      summary: '',
      asksChoice: false,
      options: undefined,
      messageID: undefined,
      deepLink: '/channel/general-stuff',
    });
  });

  it('still alerts (with no deep link) when the channel list is not cached yet', () => {
    renderAt('/');
    fireApproval(approval({ parentID: 'ch-9', parentType: undefined }));
    expect(notifyApproval).toHaveBeenCalledTimes(1);
    expect(notifyApproval.mock.calls[0][0]).toMatchObject({
      parentType: 'channel',
      deepLink: '',
    });
  });

  it('still alerts (with no deep link) on a cache miss for the channel', () => {
    renderAt('/', (qc) => {
      qc.setQueryData(['userChannels'], [{ channelID: 'ch-0', channelName: 'random' }]);
    });
    // options present but EMPTY: it is not a question, and the empty list is
    // passed through as-is.
    fireApproval(approval({ parentID: 'ch-9', parentType: 'channel', options: [] }));
    expect(notifyApproval).toHaveBeenCalledTimes(1);
    expect(notifyApproval.mock.calls[0][0]).toMatchObject({
      asksChoice: false,
      options: [],
      deepLink: '',
    });
  });

  it('routes run lifecycle and progress frames into the agent-runs store', () => {
    renderAt('/');
    const onRunUpdated = capturedOptions.onRunUpdated as (d: unknown) => void;
    const onRunProgress = capturedOptions.onRunProgress as (d: unknown) => void;
    expect(typeof onRunUpdated).toBe('function');
    expect(typeof onRunProgress).toBe('function');
    // Junk frames are tolerated (the store guards its own parsing)...
    act(() => {
      onRunUpdated(null);
      onRunProgress(null);
    });
    // ...and a live run lands in the per-parent activity bucket. run.updated
    // frames carry the run id as `id`; progress beats carry it as `runID`.
    act(() => {
      onRunUpdated({ id: 'run-9', agentID: 'ag-1', parentID: 'ch-1', state: 'running' });
      onRunProgress({ runID: 'run-9', agentID: 'ag-1', parentID: 'ch-1', kind: 'tool', tool: 'get_thread' });
    });
    const bucket = useAgentRunsStore.getState().runsByParent['ch-1'];
    expect(bucket).toHaveLength(1);
    expect(bucket[0].runID).toBe('run-9');
    expect(notifyApproval).not.toHaveBeenCalled();
  });


  it('stays silent when no user is signed in at all', () => {
    authUserMock.current = null;
    renderAt('/');
    fireApproval(approval());
    expect(notifyApproval).not.toHaveBeenCalled();
  });

});
