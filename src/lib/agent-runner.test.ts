import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { provideRunnerToken, resetRunnerHandoff } from './agent-runner';
import * as api from './api';

describe('provideRunnerToken', () => {
  beforeEach(() => {
    resetRunnerHandoff();
    delete window.__EX_AGENT_RUNNER__;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete window.__EX_AGENT_RUNNER__;
  });

  it('is a no-op outside the desktop shell (no bridge)', async () => {
    const fetchSpy = vi.spyOn(api, 'apiFetch');
    await provideRunnerToken();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('mints and hands the token to the bridge exactly once', async () => {
    const provideToken = vi.fn();
    window.__EX_AGENT_RUNNER__ = { provideToken };
    const fetchSpy = vi
      .spyOn(api, 'apiFetch')
      .mockResolvedValue({ token: 'runner-jwt', expiresAt: '2099-01-01T00:00:00Z' });

    await provideRunnerToken();
    await provideRunnerToken(); // second call must not re-mint

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('/api/v1/agents/runner-token', { method: 'POST' });
    expect(provideToken).toHaveBeenCalledTimes(1);
    expect(provideToken).toHaveBeenCalledWith('runner-jwt');
  });

  it('retries after a failed mint (latch released)', async () => {
    // The failure path warns by design; keep the suite's console clean.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provideToken = vi.fn();
    window.__EX_AGENT_RUNNER__ = { provideToken };
    const fetchSpy = vi
      .spyOn(api, 'apiFetch')
      .mockRejectedValueOnce(new Error('401'))
      .mockResolvedValueOnce({ token: 'runner-jwt-2', expiresAt: '2099-01-01T00:00:00Z' });

    await provideRunnerToken(); // fails, releases the latch
    await provideRunnerToken(); // succeeds

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(provideToken).toHaveBeenCalledWith('runner-jwt-2');
  });

  it('re-mints after resetRunnerHandoff (new login)', async () => {
    const provideToken = vi.fn();
    window.__EX_AGENT_RUNNER__ = { provideToken };
    const fetchSpy = vi
      .spyOn(api, 'apiFetch')
      .mockResolvedValue({ token: 'runner-jwt', expiresAt: '2099-01-01T00:00:00Z' });

    await provideRunnerToken();
    resetRunnerHandoff();
    await provideRunnerToken();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
