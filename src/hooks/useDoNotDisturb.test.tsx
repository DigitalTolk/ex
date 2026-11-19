import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDoNotDisturb } from './useDoNotDisturb';
import { apiFetch, getAccessToken } from '@/lib/api';
import { INDEFINITE_SNOOZE_MINUTES } from '@/lib/notification-snooze';
import { showToast } from '@/lib/toast';
import type { User } from '@/types';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(), getAccessToken: vi.fn() }));
vi.mock('@/lib/toast', () => ({ showToast: vi.fn() }));

// The signed-in user as the hook sees them. setAuth swaps the user the way
// the provider does; the test re-renders to pick the new one up.
let mockUser: User | null = null;
const setAuth = vi.fn((_token: string, user: User) => {
  mockUser = user;
});
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: mockUser, setAuth }) }));

const MINUTE = 60_000;
const START = new Date(2026, 0, 15, 10, 0).getTime();

function alice(snoozeUntil?: string): User {
  return {
    id: 'u-1',
    email: 'alice@example.com',
    displayName: 'Alice',
    systemRole: 'member',
    notificationSettings: snoozeUntil ? { snoozeUntil } : {},
  } as User;
}

const inMinutes = (minutes: number) => new Date(START + minutes * MINUTE).toISOString();

describe('useDoNotDisturb', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    mockUser = alice();
    vi.mocked(apiFetch).mockReset();
    vi.mocked(getAccessToken).mockReset().mockReturnValue('token-1');
    vi.mocked(showToast).mockReset();
    setAuth.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is off, with nothing waiting, for a user who never snoozed', () => {
    const { result } = renderHook(() => useDoNotDisturb());
    expect(result.current.until).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is off before anyone is signed in', () => {
    mockUser = null;
    const { result } = renderHook(() => useDoNotDisturb());
    expect(result.current.until).toBeNull();
  });

  it('is off for a snooze that already ended', () => {
    mockUser = alice(inMinutes(-5));
    const { result } = renderHook(() => useDoNotDisturb());
    expect(result.current.until).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives the end of a running snooze and turns itself off the moment it runs out', () => {
    mockUser = alice(inMinutes(30));
    const { result } = renderHook(() => useDoNotDisturb());
    expect(result.current.until?.toISOString()).toBe(inMinutes(30));

    act(() => {
      vi.advanceTimersByTime(30 * MINUTE - 1);
    });
    expect(result.current.until).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(251);
    });
    expect(result.current.until).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('checks a snooze longer than a timer can hold again when its timer fires', () => {
    const setTimer = vi.spyOn(globalThis, 'setTimeout');
    mockUser = alice(inMinutes(INDEFINITE_SNOOZE_MINUTES));
    const { result } = renderHook(() => useDoNotDisturb());
    const longest = 2 ** 31 - 1;
    expect(setTimer).toHaveBeenLastCalledWith(expect.any(Function), longest);

    act(() => {
      vi.advanceTimersByTime(longest);
    });
    // Still on, and waiting again for the rest.
    expect(result.current.until?.toISOString()).toBe(inMinutes(INDEFINITE_SNOOZE_MINUTES));
    expect(setTimer).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    setTimer.mockRestore();
  });

  it('stops waiting when it unmounts', () => {
    mockUser = alice(inMinutes(30));
    const { unmount } = renderHook(() => useDoNotDisturb());
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('turns on for some minutes: asks the server and takes the user it answers with', async () => {
    const snoozed = alice(inMinutes(60));
    vi.mocked(apiFetch).mockResolvedValue(snoozed);
    const { result, rerender } = renderHook(() => useDoNotDisturb());

    await act(() => result.current.snooze(60));

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/users/me/notification-snooze', {
      method: 'PUT',
      body: JSON.stringify({ minutes: 60 }),
    });
    expect(setAuth).toHaveBeenCalledWith('token-1', snoozed);
    rerender();
    expect(result.current.until?.toISOString()).toBe(inMinutes(60));
    expect(showToast).not.toHaveBeenCalled();
  });

  it('turns off with 0 minutes', async () => {
    mockUser = alice(inMinutes(60));
    vi.mocked(apiFetch).mockResolvedValue(alice());
    const { result, rerender } = renderHook(() => useDoNotDisturb());
    expect(result.current.until).not.toBeNull();

    await act(() => result.current.snooze(0));

    expect(apiFetch).toHaveBeenCalledWith('/api/v1/users/me/notification-snooze', {
      method: 'PUT',
      body: JSON.stringify({ minutes: 0 }),
    });
    rerender();
    expect(result.current.until).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves the session alone when it ended while the request was out', async () => {
    vi.mocked(apiFetch).mockResolvedValue(alice(inMinutes(60)));
    vi.mocked(getAccessToken).mockReturnValue(null);
    const { result } = renderHook(() => useDoNotDisturb());

    await act(() => result.current.snooze(60));

    expect(setAuth).not.toHaveBeenCalled();
    expect(result.current.until).toBeNull();
  });

  it('says why when the server refuses, and stays as it was', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('minutes out of range'));
    const { result } = renderHook(() => useDoNotDisturb());

    await act(() => result.current.snooze(60));

    expect(showToast).toHaveBeenCalledWith('minutes out of range', 'error');
    expect(setAuth).not.toHaveBeenCalled();
    expect(result.current.until).toBeNull();
  });

  it('falls back to a plain message when the failure carries none', async () => {
    vi.mocked(apiFetch).mockRejectedValue('offline');
    const { result } = renderHook(() => useDoNotDisturb());

    await act(() => result.current.snooze(60));

    expect(showToast).toHaveBeenCalledWith("Couldn't change Do Not Disturb", 'error');
  });
});
