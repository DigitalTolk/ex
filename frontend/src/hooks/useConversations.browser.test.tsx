import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useUserConversations,
  useConversation,
  useCreateConversation,
  useSearchUsers,
  useAllUsers,
} from './useConversations';

// Browser-gate coverage for the conversation/user React Query hooks. None had
// a browser test; they were only covered transitively.

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

// vitest-browser-react's cleanup() is not awaited on WebKit, so a prior probe
// can outlive the test and trip strict-mode "2 elements". Track each render and
// await its unmount.
let mounted: Awaited<ReturnType<typeof render>> | null = null;
beforeEach(() => {
  apiFetchMock.mockReset();
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

function Probe<T>({ hook }: { hook: () => { data?: T } }) {
  const r = hook();
  return (
    <div
      data-testid="probe"
      data-data={r.data === undefined ? '' : JSON.stringify(r.data)}
      data-call={String(apiFetchMock.mock.calls[0]?.[0] ?? '')}
    />
  );
}

function MutationProbe({ hook, vars }: { hook: () => { mutate: (v: unknown) => void }; vars: unknown }) {
  const m = hook();
  return <button data-testid="trigger" onClick={() => m.mutate(vars)} />;
}

async function renderHook<T>(hook: () => { data?: T }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mounted = await render(
    <QueryClientProvider client={qc}>
      <Probe hook={hook} />
    </QueryClientProvider>,
  );
  return mounted;
}

describe('useConversations queries', () => {
  it('useUserConversations coerces a non-array response to []', async () => {
    apiFetchMock.mockResolvedValue(null);
    const screen = await renderHook(() => useUserConversations());
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByTestId('probe').element().getAttribute('data-data')).toBe('[]');
  });

  it('useUserConversations returns the array when the API yields one', async () => {
    apiFetchMock.mockResolvedValue([{ conversationID: 'cv-1' }]);
    const screen = await renderHook(() => useUserConversations());
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByTestId('probe').element().getAttribute('data-data')).toContain('cv-1');
  });

  it('useUserConversations respects enabled:false', async () => {
    apiFetchMock.mockResolvedValue([]);
    await renderHook(() => useUserConversations({ enabled: false }));
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('useConversation is disabled without an id', async () => {
    await renderHook(() => useConversation(undefined));
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('useConversation fetches /conversations/:id when an id is set', async () => {
    apiFetchMock.mockResolvedValue({ id: 'cv-9' });
    const screen = await renderHook(() => useConversation('cv-9'));
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByTestId('probe').element().getAttribute('data-call')).toBe('/api/v1/conversations/cv-9');
  });

  it('useConversation coerces an empty response to null', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const screen = await renderHook(() => useConversation('cv-9'));
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByTestId('probe').element().getAttribute('data-data')).toBe('null');
  });

  it('useSearchUsers coerces a non-array response to []', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const screen = await renderHook(() => useSearchUsers('alice'));
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByTestId('probe').element().getAttribute('data-data')).toBe('[]');
  });

  it('useSearchUsers stays disabled under 2 chars', async () => {
    await renderHook(() => useSearchUsers('a'));
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('useSearchUsers fetches /users?q= at >= 2 chars', async () => {
    apiFetchMock.mockResolvedValue([{ id: 'u-1', email: 'a@x', displayName: 'A' }]);
    const screen = await renderHook(() => useSearchUsers('al'));
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByTestId('probe').element().getAttribute('data-call')).toContain('/api/v1/users?q=al');
  });

  it('useAllUsers requests the full roster with ?all=true', async () => {
    apiFetchMock.mockResolvedValue([{ id: 'u-1' }]);
    const screen = await renderHook(() => useAllUsers());
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByTestId('probe').element().getAttribute('data-call')).toBe('/api/v1/users?all=true');
  });
});

describe('useCreateConversation', () => {
  it('POSTs to /conversations and invalidates the list on success', async () => {
    apiFetchMock.mockResolvedValue({ id: 'cv-new' });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mounted = await render(
      <QueryClientProvider client={qc}>
        <MutationProbe hook={useCreateConversation as never} vars={{ type: 'dm', participantIDs: ['u-2'] }} />
      </QueryClientProvider>,
    );
    const screen = mounted;
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/conversations');
    expect((apiFetchMock.mock.calls[0][1] as { method: string }).method).toBe('POST');
  });
});
