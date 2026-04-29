import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { type ReactNode } from 'react';
import { useDeepLinkAnchor } from './useDeepLinkAnchor';

function wrap(path: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>;
  };
}

describe('useDeepLinkAnchor', () => {
  it('returns the message ID parsed from the URL hash as mainAnchor', () => {
    const { result } = renderHook(() => useDeepLinkAnchor('ch-1'), {
      wrapper: wrap('/channel/x#msg-abc'),
    });
    expect(result.current.mainAnchor).toBe('abc');
    expect(result.current.threadAnchor).toBeUndefined();
    expect(result.current.threadParam).toBeUndefined();
  });

  it('returns undefined when the hash is missing or non-msg', () => {
    const { result } = renderHook(() => useDeepLinkAnchor('ch-1'), {
      wrapper: wrap('/channel/x#elsewhere'),
    });
    expect(result.current.mainAnchor).toBeUndefined();
    expect(result.current.threadAnchor).toBeUndefined();
  });

  it('returns undefined when the hash is empty', () => {
    const { result } = renderHook(() => useDeepLinkAnchor('ch-1'), {
      wrapper: wrap('/channel/x'),
    });
    expect(result.current.mainAnchor).toBeUndefined();
    expect(result.current.threadAnchor).toBeUndefined();
  });

  it('with ?thread=R#msg-Y promotes R to mainAnchor and Y to threadAnchor', () => {
    const { result } = renderHook(() => useDeepLinkAnchor('ch-1'), {
      wrapper: wrap('/channel/x?thread=root-1#msg-reply-1'),
    });
    expect(result.current.mainAnchor).toBe('root-1');
    expect(result.current.threadAnchor).toBe('reply-1');
    expect(result.current.threadParam).toBe('root-1');
  });

  it('with ?thread=R but no hash, mainAnchor is R and threadAnchor is undefined', () => {
    const { result } = renderHook(() => useDeepLinkAnchor('ch-1'), {
      wrapper: wrap('/channel/x?thread=root-2'),
    });
    expect(result.current.mainAnchor).toBe('root-2');
    expect(result.current.threadAnchor).toBeUndefined();
    expect(result.current.threadParam).toBe('root-2');
  });

  it('with ?thread=R#msg-R (hash equals root), threadAnchor stays undefined', () => {
    const { result } = renderHook(() => useDeepLinkAnchor('ch-1'), {
      wrapper: wrap('/channel/x?thread=root-3#msg-root-3'),
    });
    expect(result.current.mainAnchor).toBe('root-3');
    // No reply-specific anchor — the hash is just pointing at the root.
    expect(result.current.threadAnchor).toBeUndefined();
  });
});
