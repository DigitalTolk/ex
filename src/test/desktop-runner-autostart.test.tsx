import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DesktopRunnerAutostart } from '@/components/runners/DesktopRunnerAutostart';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));

const ORIGIN = window.location.origin;
const ready = {
  supported: true,
  autoStart: true,
  binary: { version: '0.0.3', source: 'app' },
  connection: { server: ORIGIN, user: 'Alice', label: 'mac', tokenId: 'rt1', expiresAt: '2026-11-04T00:00:00Z', expired: false },
};

let runnersInApp = true;

beforeEach(() => {
  runnersInApp = true;
  mockApiFetch.mockReset();
  mockApiFetch.mockImplementation(() => Promise.resolve({ maxUploadBytes: 0, allowedExtensions: [], runnersInApp }));
});

afterEach(() => {
  delete window.__EX_RUNNER__;
});

function bridgeWith(state: Record<string, unknown>, start: () => Promise<unknown> = () => Promise.resolve()) {
  let listener: ((s: unknown) => void) | null = null;
  const call = vi.fn((op: string) => (op === 'getState' ? Promise.resolve(state) : start()));
  window.__EX_RUNNER__ = {
    call,
    subscribe: (l) => {
      listener = l;
      return () => {
        listener = null;
      };
    },
  };
  return { call, push: (s: Record<string, unknown>) => act(() => listener?.(s)) };
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DesktopRunnerAutostart />
    </QueryClientProvider>,
  );
}

const starts = (call: ReturnType<typeof vi.fn>) => call.mock.calls.filter((c) => c[0] === 'start').length;

describe('DesktopRunnerAutostart', () => {
  it('starts ex-runner once when ex opens, if asked to', async () => {
    const { call, push } = bridgeWith(ready);
    mount();
    await waitFor(() => expect(starts(call)).toBe(1));
    // Later pushes in the same launch never start it again.
    push({ ...ready, process: 'stopped' });
    expect(starts(call)).toBe(1);
  });

  it('swallows a failed start (the card shows the app’s error)', async () => {
    const { call } = bridgeWith(ready, () => Promise.reject(new Error('no')));
    mount();
    await waitFor(() => expect(starts(call)).toBe(1));
  });

  it.each([
    ['the switch is off', { ...ready, autoStart: false }],
    ['the app cannot run it', { ...ready, supported: false }],
    ['it is not connected', { ...ready, connection: null }],
    ['it already runs', { ...ready, process: 'running' }],
    ['the app is busy', { ...ready, busy: 'installing' }],
  ])('does nothing when %s', async (_why, state) => {
    const { call } = bridgeWith(state);
    mount();
    await waitFor(() => expect(call).toHaveBeenCalledWith('getState', undefined));
    await act(async () => {});
    expect(starts(call)).toBe(0);
  });

  it('does nothing while the workspace has Runners turned off', async () => {
    runnersInApp = false;
    const { call } = bridgeWith(ready);
    mount();
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    await act(async () => {});
    expect(starts(call)).toBe(0);
  });

  it('does nothing in a browser', async () => {
    mount();
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    expect(window.__EX_RUNNER__).toBeUndefined();
  });

  it('ignores an answer that lands after unmount', async () => {
    let answer: (s: unknown) => void = () => {};
    window.__EX_RUNNER__ = {
      call: vi.fn((op: string) => (op === 'getState' ? new Promise((r) => (answer = r)) : Promise.resolve())),
      subscribe: (l) => {
        // A push racing the unmount is dropped too.
        setTimeout(() => l(ready), 0);
        return () => {};
      },
    };
    const view = mount();
    view.unmount();
    await act(async () => {
      answer(ready);
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(window.__EX_RUNNER__.call).not.toHaveBeenCalledWith('start', undefined);
  });
});
