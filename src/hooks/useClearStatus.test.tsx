import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useClearStatus } from './useClearStatus';
import { apiFetch, getAccessToken } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { localTimeZone } from '@/lib/user-time';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(), getAccessToken: vi.fn() }));
vi.mock('@/lib/toast', () => ({ showToast: vi.fn() }));

const setAuth = vi.fn();
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ setAuth }) }));

const cleared = { id: 'u-1', email: 'alice@example.com', displayName: 'Alice', systemRole: 'member' };

describe('useClearStatus', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(getAccessToken).mockReset().mockReturnValue('token-1');
    vi.mocked(showToast).mockReset();
    setAuth.mockReset();
  });

  it("asks the server to clear the status, in the viewer's time zone, and takes the user it answers with", async () => {
    vi.mocked(apiFetch).mockResolvedValue(cleared);
    const { result } = renderHook(() => useClearStatus());

    await result.current();

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/users/me/status', {
      method: 'DELETE',
      body: JSON.stringify({ timeZone: localTimeZone() }),
    });
    expect(setAuth).toHaveBeenCalledWith('token-1', cleared);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('leaves the session alone when it ended while the request was out', async () => {
    vi.mocked(apiFetch).mockResolvedValue(cleared);
    vi.mocked(getAccessToken).mockReturnValue(null);
    const { result } = renderHook(() => useClearStatus());

    await result.current();

    expect(setAuth).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("says why when the server refuses, and keeps the user as they were", async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('status is locked'));
    const { result } = renderHook(() => useClearStatus());

    await result.current();

    expect(showToast).toHaveBeenCalledWith('status is locked', 'error');
    expect(setAuth).not.toHaveBeenCalled();
  });

  it('falls back to a plain message when the failure carries none', async () => {
    vi.mocked(apiFetch).mockRejectedValue('offline');
    const { result } = renderHook(() => useClearStatus());

    await result.current();

    expect(showToast).toHaveBeenCalledWith('Failed to clear status', 'error');
  });
});
