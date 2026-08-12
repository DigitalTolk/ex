import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { useMarkReadOnReturn } from './useMarkReadOnReturn';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useMarkReadOnReturn', () => {
  it('fires on window focus while the document is visible and focused', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const markRead = vi.fn();
    renderHook(() => useMarkReadOnReturn('c-1', markRead));
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead).toHaveBeenCalledWith('c-1');
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
    expect(markRead).toHaveBeenCalledWith('c-2');
    unmount();
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(markRead).toHaveBeenCalledTimes(1);
  });
});
