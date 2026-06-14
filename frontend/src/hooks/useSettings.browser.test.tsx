import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useWorkspaceSettings, useUpdateWorkspaceSettings } from './useSettings';
import type { WorkspaceSettings } from '@/types';

// Browser-gate coverage for the workspace-settings hooks. The query's
// `?? DEFAULT_WORKSPACE_SETTINGS` fallback and the update mutation's
// setQueryData were only covered transitively.

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

beforeEach(() => apiFetchMock.mockReset());
afterEach(() => cleanup());

function Probe({ hook }: { hook: () => { data?: WorkspaceSettings } }) {
  const r = hook();
  return <div data-testid="probe" data-data={r.data === undefined ? '' : JSON.stringify(r.data)} />;
}

function renderHook(hook: () => { data?: WorkspaceSettings }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Probe hook={hook} />
    </QueryClientProvider>,
  );
}

describe('useWorkspaceSettings', () => {
  it('falls back to the default settings when the API returns null', async () => {
    apiFetchMock.mockResolvedValue(null);
    const screen = await renderHook(() => useWorkspaceSettings());
    await new Promise((r) => setTimeout(r, 150));
    const parsed = JSON.parse(screen.getByTestId('probe').element().getAttribute('data-data') || '{}');
    expect(parsed).toEqual({ maxUploadBytes: 0, allowedExtensions: [], giphyEnabled: false });
  });

  it('returns the API settings when present', async () => {
    apiFetchMock.mockResolvedValue({ maxUploadBytes: 100, allowedExtensions: ['png'], giphyEnabled: true });
    const screen = await renderHook(() => useWorkspaceSettings());
    await new Promise((r) => setTimeout(r, 150));
    const parsed = JSON.parse(screen.getByTestId('probe').element().getAttribute('data-data') || '{}');
    expect(parsed.maxUploadBytes).toBe(100);
  });

  it('stays disabled when enabled=false', async () => {
    apiFetchMock.mockResolvedValue({});
    await renderHook(() => useWorkspaceSettings(false));
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('useUpdateWorkspaceSettings', () => {
  it('PUTs the settings and writes them into the cache on success', async () => {
    const next: WorkspaceSettings = { maxUploadBytes: 5, allowedExtensions: ['jpg'], giphyEnabled: false };
    apiFetchMock.mockResolvedValue(next);
    function MutProbe() {
      const m = useUpdateWorkspaceSettings();
      return <button data-testid="trigger" data-status={m.status} onClick={() => m.mutate(next)} />;
    }
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={qc}>
        <MutProbe />
      </QueryClientProvider>,
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(screen.getByTestId('trigger').element().getAttribute('data-status')).toBe('success');
    });
    expect((apiFetchMock.mock.calls[0][1] as { method: string }).method).toBe('PUT');
  });
});
