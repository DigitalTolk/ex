import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { useMarkReadOnReturn } from './useMarkReadOnReturn';
import { markUserActivity, resetUserActivityForTests, suppressionWindowMs } from '@/lib/user-activity';

afterEach(() => {
  vi.restoreAllMocks();
  resetUserActivityForTests();
});

// The user's first input after an idle spell.
function inputAfterIdle() {
  markUserActivity(Date.now() - suppressionWindowMs - 1_000);
  act(() => markUserActivity());
}

describe('useMarkReadOnReturn', () => {
  it('fires on window focus while the document is visible and focused', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const markRead = vi.fn();
    renderHook(() => useMarkReadOnReturn('c-1', markRead));
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead).toHaveBeenCalledWith('c-1', 'window');
  });

  it('fires on visibilitychange to visible while focused', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const markRead = vi.fn();
    renderHook(() => useMarkReadOnReturn('c-1', markRead));
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(markRead).toHaveBeenCalledTimes(1);
  });

  it('calls the latest callback, not the one it was mounted with', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = renderHook(({ cb }) => useMarkReadOnReturn('c-1', cb), { initialProps: { cb: first } });
    rerender({ cb: latest });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith('c-1', 'window');
  });

  // A window that stayed in front while the user was idle gets no focus
  // event when they come back to it.
  it('fires on the first input after an idle spell', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const markRead = vi.fn();
    renderHook(() => useMarkReadOnReturn('c-1', markRead));
    act(() => markUserActivity());
    expect(markRead).not.toHaveBeenCalled();
    inputAfterIdle();
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead).toHaveBeenCalledWith('c-1', 'input');
  });

  it('does NOT fire on input after an idle spell in another window', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const markRead = vi.fn();
    renderHook(() => useMarkReadOnReturn('c-1', markRead));
    inputAfterIdle();
    expect(markRead).not.toHaveBeenCalled();
  });

  it('does NOT fire while the window is unfocused', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const markRead = vi.fn();
    renderHook(() => useMarkReadOnReturn('c-1', markRead));
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(markRead).not.toHaveBeenCalled();
  });

  it('does NOT fire while the document is hidden', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');
    const markRead = vi.fn();
    renderHook(() => useMarkReadOnReturn('c-1', markRead));
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(markRead).not.toHaveBeenCalled();
    visibility.mockRestore();
  });

  it('is inert without an id and after unmount', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const markRead = vi.fn();
    const { unmount, rerender } = renderHook(
      ({ id }: { id: string | undefined }) => useMarkReadOnReturn(id, markRead),
      { initialProps: { id: undefined as string | undefined } },
    );
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(markRead).not.toHaveBeenCalled();
    rerender({ id: 'c-2' });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead).toHaveBeenCalledWith('c-2', 'window');
    unmount();
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    inputAfterIdle();
    expect(markRead).toHaveBeenCalledTimes(1);
  });
});
