import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useAgents,
  useAgentSubscriptions,
  useCreateAgent,
  useCreateAgentSubscription,
  useCreateSkill,
  useCreateWatcher,
  useDecideCatchUp,
  useDeleteAgentSubscription,
  useDeleteSkill,
  useInvalidateParentWatchers,
  useParentWatchers,
  useRemoveWatcher,
  useSkills,
  useUpdateAgentPrefs,
  useUpdateSkill,
  useUpdateWatcher,
  type AgentSubscription,
  type AgentView,
  type Skill,
} from '@/hooks/useAgents';

type ApiInit = { method?: string; body?: string };

const mockApiFetch = vi.fn<(path: string, init?: ApiInit) => Promise<unknown>>();
vi.mock('@/lib/api', () => ({
  apiFetch: (path: string, init?: ApiInit) => mockApiFetch(path, init),
}));

function wrap() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return { qc, Wrapper };
}

function agentView(slug: string, displayName = slug): AgentView {
  return {
    id: `ag-${slug}`,
    displayName,
    slug,
    status: 'active',
    prefs: { userID: 'u-1', slug },
    resolved: { harness: 'claude', model: '', persona: '', limits: {}, maxConcurrentRuns: 1 },
  };
}

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('useCreateWatcher', () => {
  it('POSTs the watcher body without the slug and invalidates subs + badges', async () => {
    mockApiFetch.mockResolvedValue({});
    const { qc, Wrapper } = wrap();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCreateWatcher(), { wrapper: Wrapper });

    result.current.mutate({
      slug: 'gg',
      parentID: 'ch-1',
      parentType: 'channel',
      threadRootID: 'msg-9',
      instruction: 'watch deploys',
      actionMode: 'notify',
      keywords: ['deploy'],
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/agents/gg/subscriptions',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(mockApiFetch.mock.calls[0][1]!.body!);
    expect(body).toEqual({
      parentID: 'ch-1',
      parentType: 'channel',
      threadRootID: 'msg-9',
      instruction: 'watch deploys',
      actionMode: 'notify',
      keywords: ['deploy'],
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['agent-subs', 'gg'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['parent-watchers'] });
  });
});

describe('useAgentSubscriptions', () => {
  it('fetches the subscriptions for one agent', async () => {
    const subs: AgentSubscription[] = [
      { id: 's1', agentID: 'ag-gg', creatorID: 'u-1', parentID: 'ch-1', parentType: 'channel' },
    ];
    mockApiFetch.mockResolvedValue({ subscriptions: subs });
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useAgentSubscriptions('gg'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/agents/gg/subscriptions', undefined);
    expect(result.current.data).toEqual(subs);
  });

  it('falls back to an empty list when the payload has no subscriptions', async () => {
    mockApiFetch.mockResolvedValue({});
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useAgentSubscriptions('gg'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });
});

describe('useCreateAgentSubscription', () => {
  it('POSTs the subscription and invalidates the agent subs list', async () => {
    mockApiFetch.mockResolvedValue({});
    const { qc, Wrapper } = wrap();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCreateAgentSubscription('gg'), { wrapper: Wrapper });

    result.current.mutate({ parentID: 'ch-1', parentType: 'channel', keywords: ['a'], heartbeatMins: 30 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/agents/gg/subscriptions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ parentID: 'ch-1', parentType: 'channel', keywords: ['a'], heartbeatMins: 30 }),
      }),
    );
    expect(spy).toHaveBeenCalledWith({ queryKey: ['agent-subs', 'gg'] });
  });
});

describe('useParentWatchers', () => {
  it('fetches channel watchers from the channels endpoint', async () => {
    const watchers: AgentSubscription[] = [
      { id: 'w1', agentID: 'ag-gg', creatorID: 'u-1', parentID: 'ch-1', parentType: 'channel' },
    ];
    mockApiFetch.mockResolvedValue({ watchers });
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useParentWatchers('channel', 'ch-1'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-1/watchers', undefined);
    expect(result.current.data).toEqual(watchers);
  });

  it('fetches conversation watchers and tolerates an empty payload', async () => {
    mockApiFetch.mockResolvedValue(undefined);
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useParentWatchers('conversation', 'dm-1'), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/conversations/dm-1/watchers', undefined);
    expect(result.current.data).toEqual([]);
  });

  it('stays disabled while there is no parent id', async () => {
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useParentWatchers('channel', undefined), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(result.current.isPending).toBe(true);
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});

describe('useDecideCatchUp', () => {
  it('POSTs the decision and refreshes the badge set', async () => {
    mockApiFetch.mockResolvedValue({});
    const { qc, Wrapper } = wrap();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useDecideCatchUp(), { wrapper: Wrapper });

    result.current.mutate({ parentID: 'ch-1', id: 'w1', process: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/watchers/ch-1/w1/catchup',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ process: true }) }),
    );
    expect(spy).toHaveBeenCalledWith({ queryKey: ['parent-watchers'] });
  });
});

describe('useInvalidateParentWatchers', () => {
  it('returns a callback that invalidates the badge queries', () => {
    const { qc, Wrapper } = wrap();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useInvalidateParentWatchers(), { wrapper: Wrapper });

    result.current();
    expect(spy).toHaveBeenCalledWith({ queryKey: ['parent-watchers'] });
  });
});

describe('useUpdateWatcher', () => {
  it('PATCHes instruction + action mode and invalidates subs + badges', async () => {
    mockApiFetch.mockResolvedValue({});
    const { qc, Wrapper } = wrap();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateWatcher(), { wrapper: Wrapper });

    result.current.mutate({
      slug: 'gg',
      parentID: 'ch-1',
      id: 'w1',
      instruction: 'be brief',
      actionMode: 'draft',
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/agents/gg/subscriptions/ch-1/w1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ instruction: 'be brief', actionMode: 'draft' }),
      }),
    );
    expect(spy).toHaveBeenCalledWith({ queryKey: ['agent-subs', 'gg'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['parent-watchers'] });
  });
});

describe('useRemoveWatcher', () => {
  it('DELETEs the watcher and invalidates subs + badges', async () => {
    mockApiFetch.mockResolvedValue({});
    const { qc, Wrapper } = wrap();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useRemoveWatcher(), { wrapper: Wrapper });

    result.current.mutate({ slug: 'gg', parentID: 'ch-1', id: 'w1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/agents/gg/subscriptions/ch-1/w1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(spy).toHaveBeenCalledWith({ queryKey: ['agent-subs', 'gg'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['parent-watchers'] });
  });
});

describe('useDeleteAgentSubscription', () => {
  it('DELETEs the subscription and invalidates subs + badges', async () => {
    mockApiFetch.mockResolvedValue({});
    const { qc, Wrapper } = wrap();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteAgentSubscription('gg'), { wrapper: Wrapper });

    result.current.mutate({ parentID: 'ch-1', id: 's1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/agents/gg/subscriptions/ch-1/s1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(spy).toHaveBeenCalledWith({ queryKey: ['agent-subs', 'gg'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['parent-watchers'] });
  });
});

describe('useAgents', () => {
  it('returns the agents list', async () => {
    const agents = [agentView('gg')];
    mockApiFetch.mockResolvedValue({ agents });
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useAgents(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/agents', undefined);
    expect(result.current.data).toEqual(agents);
  });

  it('falls back to an empty list when the payload is missing', async () => {
    mockApiFetch.mockResolvedValue(undefined);
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useAgents(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });
});

describe('skills hooks', () => {
  const skill: Skill = {
    id: 'sk-1',
    name: 'Summarize',
    description: 'd',
    instructions: 'i',
    createdBy: 'u-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };

  it('useSkills returns the skills list', async () => {
    mockApiFetch.mockResolvedValue({ skills: [skill] });
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useSkills(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/skills', undefined);
    expect(result.current.data).toEqual([skill]);
  });

  it('useSkills falls back to an empty list when skills are missing', async () => {
    mockApiFetch.mockResolvedValue({});
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useSkills(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });

  it('useCreateSkill POSTs the skill and invalidates the list', async () => {
    mockApiFetch.mockResolvedValue({ skill });
    const { qc, Wrapper } = wrap();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCreateSkill(), { wrapper: Wrapper });

    result.current.mutate({ name: 'Summarize', description: 'd', instructions: 'i' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/skills',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'Summarize', description: 'd', instructions: 'i' }),
      }),
    );
    expect(spy).toHaveBeenCalledWith({ queryKey: ['skills'] });
  });

  it('useUpdateSkill PATCHes the skill and invalidates the list', async () => {
    mockApiFetch.mockResolvedValue({ skill });
    const { qc, Wrapper } = wrap();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateSkill(), { wrapper: Wrapper });

    result.current.mutate({ id: 'sk-1', patch: { name: 'New name' } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/skills/sk-1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'New name' }) }),
    );
    expect(spy).toHaveBeenCalledWith({ queryKey: ['skills'] });
  });

  it('useDeleteSkill DELETEs the skill and invalidates the list', async () => {
    mockApiFetch.mockResolvedValue({});
    const { qc, Wrapper } = wrap();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteSkill(), { wrapper: Wrapper });

    result.current.mutate('sk-1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/skills/sk-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(spy).toHaveBeenCalledWith({ queryKey: ['skills'] });
  });
});

describe('useCreateAgent', () => {
  it('POSTs the new agent and invalidates the agents list', async () => {
    mockApiFetch.mockResolvedValue({});
    const { qc, Wrapper } = wrap();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCreateAgent(), { wrapper: Wrapper });

    const body = {
      slug: 'res-1',
      displayName: 'Res',
      harness: 'claude',
      model: '',
      executionMode: '',
      persona: 'Be helpful.',
    };
    result.current.mutate(body);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/agents',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }),
    );
    expect(spy).toHaveBeenCalledWith({ queryKey: ['agents'] });
  });
});

describe('useUpdateAgentPrefs', () => {
  it('PATCHes prefs and swaps the updated agent into the cached list', async () => {
    const gg = agentView('gg');
    const qib = agentView('qib');
    const updated: AgentView = { ...gg, prefs: { ...gg.prefs, model: 'opus' } };
    mockApiFetch.mockResolvedValue(updated);

    const { qc, Wrapper } = wrap();
    qc.setQueryData(['agents'], [gg, qib]);
    const { result } = renderHook(() => useUpdateAgentPrefs(), { wrapper: Wrapper });

    result.current.mutate({ slug: 'gg', patch: { model: 'opus' } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/agents/gg/prefs',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ model: 'opus' }) }),
    );
    expect(qc.getQueryData(['agents'])).toEqual([updated, qib]);
  });

  it('leaves the cache untouched when the agents list was never fetched', async () => {
    const updated = agentView('gg');
    mockApiFetch.mockResolvedValue(updated);

    const { qc, Wrapper } = wrap();
    const { result } = renderHook(() => useUpdateAgentPrefs(), { wrapper: Wrapper });

    result.current.mutate({ slug: 'gg', patch: {} });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(qc.getQueryData(['agents'])).toBeUndefined();
  });
});
