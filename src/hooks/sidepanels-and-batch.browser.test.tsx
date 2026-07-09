import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSidePanels } from './useSidePanels';
import { useUsersBatch } from './useUsersBatch';
import { useMarkThreadSeen } from './useUserState';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

beforeEach(() => {
  apiFetchMock.mockReset();
});

function Probe<T>({ hook }: { hook: () => T }) {
  const r = hook();
  return <div data-testid="probe" data-r={JSON.stringify(r)} />;
}

describe('useSidePanels', () => {
  function PanelHarness() {
    const p = useSidePanels<'pinned' | 'files'>();
    return (
      <>
        <span data-testid="active">{p.active ?? '(none)'}</span>
        <button data-testid="open-pinned" onClick={() => p.open('pinned')} />
        <button data-testid="open-files" onClick={() => p.open('files')} />
        <button data-testid="toggle-pinned" onClick={() => p.toggle('pinned')} />
        <button data-testid="close" onClick={() => p.close()} />
        <span data-testid="is-pinned">{String(p.isActive('pinned'))}</span>
      </>
    );
  }

  it('starts inactive, opens, closes, and toggles', async () => {
    const screen = await render(<PanelHarness />);
    expect(screen.getByTestId('active').element().textContent).toBe('(none)');
    (screen.getByTestId('open-pinned').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId('active').element().textContent).toBe('pinned');
    expect(screen.getByTestId('is-pinned').element().textContent).toBe('true');

    // Opening another panel replaces the active one.
    (screen.getByTestId('open-files').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId('active').element().textContent).toBe('files');

    // Toggle on a different panel switches to it.
    (screen.getByTestId('toggle-pinned').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId('active').element().textContent).toBe('pinned');

    // Toggle on the active panel closes it.
    (screen.getByTestId('toggle-pinned').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId('active').element().textContent).toBe('(none)');

    // close() also leaves it inactive.
    (screen.getByTestId('open-files').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 50));
    (screen.getByTestId('close').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId('active').element().textContent).toBe('(none)');
  });
});

describe('useUsersBatch', () => {
  it('does not fetch when given an empty id list', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(
      <QueryClientProvider client={qc}>
        <Probe hook={() => useUsersBatch([])} />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('deduplicates ids in the request body and builds an id→user map', async () => {
    apiFetchMock.mockResolvedValue([
      { id: 'u-1', displayName: 'Alice' },
      { id: 'u-2', displayName: 'Bob' },
    ]);
    function H() {
      const r = useUsersBatch(['u-1', 'u-2', 'u-1']);
      return (
        <span
          data-testid="probe"
          data-keys={[...r.map.keys()].sort().join(',')}
          data-alice={r.map.get('u-1')?.displayName ?? ''}
        />
      );
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={qc}>
        <H />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((apiFetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.ids).toEqual(['u-1', 'u-2']);
    expect(screen.getByTestId('probe').element().getAttribute('data-keys')).toBe('u-1,u-2');
    expect(screen.getByTestId('probe').element().getAttribute('data-alice')).toBe('Alice');
  });

  it('coerces non-array responses to []', async () => {
    apiFetchMock.mockResolvedValue(null);
    function H() {
      const r = useUsersBatch(['u-1']);
      return <span data-testid="probe" data-count={String(r.map.size)} />;
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={qc}>
        <H />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.getByTestId('probe').element().getAttribute('data-count')).toBe('0');
  });
});

describe('useMarkThreadSeen', () => {
  function Trigger({ target }: { target: { parentID: string; parentType: string; threadRootID: string } }) {
    const m = useMarkThreadSeen();
    return <button data-testid="t" onClick={() => m.mutate(target)} />;
  }

  it('builds the channels seen-path correctly', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={qc}>
        <Trigger target={{ parentID: 'ch-1', parentType: 'channel', threadRootID: 't-1' }} />
      </QueryClientProvider>,
    );
    (screen.getByTestId('t').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/user-state/threads/channels/ch-1/t-1/seen');
    expect((apiFetchMock.mock.calls[0][1] as { method: string }).method).toBe('PUT');
  });

  it('builds the conversations seen-path correctly', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={qc}>
        <Trigger target={{ parentID: 'cv-1', parentType: 'conversation', threadRootID: 't-1' }} />
      </QueryClientProvider>,
    );
    (screen.getByTestId('t').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/user-state/threads/conversations/cv-1/t-1/seen');
  });
});
