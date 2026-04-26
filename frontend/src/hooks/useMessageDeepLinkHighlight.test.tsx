import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { type ReactNode } from 'react';
import { useMessageDeepLinkHighlight } from './useMessageDeepLinkHighlight';

function wrapperWithHash(hash: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={[`/foo${hash}`]}>{children}</MemoryRouter>;
  };
}

describe('useMessageDeepLinkHighlight', () => {
  let scrollSpy: ReturnType<typeof vi.fn>;
  let rafSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    document.body.innerHTML = '';
    scrollSpy = vi.fn();
    // jsdom does not implement scrollIntoView
    Element.prototype.scrollIntoView = scrollSpy as unknown as typeof Element.prototype.scrollIntoView;
    // requestAnimationFrame: invoke the callback synchronously so the
    // effect runs deterministically.
    rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    rafSpy.mockRestore();
  });

  it('does nothing when the hash is missing or not a #msg- target', () => {
    const el = document.createElement('div');
    el.id = 'msg-123';
    document.body.appendChild(el);

    renderHook(() => useMessageDeepLinkHighlight([]), { wrapper: wrapperWithHash('') });
    expect(scrollSpy).not.toHaveBeenCalled();
    expect(el.classList.contains('ring-2')).toBe(false);

    renderHook(() => useMessageDeepLinkHighlight([]), { wrapper: wrapperWithHash('#other') });
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('does nothing when the target element is not in the DOM', () => {
    renderHook(() => useMessageDeepLinkHighlight([]), {
      wrapper: wrapperWithHash('#msg-missing'),
    });
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('scrolls to the matching element and applies/clears the highlight class', () => {
    const el = document.createElement('div');
    el.id = 'msg-abc';
    document.body.appendChild(el);

    renderHook(() => useMessageDeepLinkHighlight([]), {
      wrapper: wrapperWithHash('#msg-abc'),
    });

    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(el.classList.contains('ring-2')).toBe(true);
    expect(el.classList.contains('ring-amber-400')).toBe(true);

    act(() => {
      vi.advanceTimersByTime(2300);
    });
    expect(el.classList.contains('ring-2')).toBe(false);
  });

  it('cleans up the timer + raf on unmount without throwing', () => {
    const el = document.createElement('div');
    el.id = 'msg-xyz';
    document.body.appendChild(el);

    const { unmount } = renderHook(() => useMessageDeepLinkHighlight([]), {
      wrapper: wrapperWithHash('#msg-xyz'),
    });
    expect(() => unmount()).not.toThrow();
  });
});
