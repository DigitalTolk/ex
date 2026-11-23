import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useThreadParticipantIds } from './useThreadParticipantIds';
import type { Message } from '@/types';

const msg = (id: string, authorID: string) => ({ id, authorID }) as Message;

describe('useThreadParticipantIds', () => {
  it('lists each writer once, in order', () => {
    const { result } = renderHook(() => useThreadParticipantIds([msg('r', 'u-1'), msg('a', 'u-2'), msg('b', 'u-1'), msg('c', '')]));
    expect(result.current).toEqual(['u-1', 'u-2']);
  });

  it('is undefined with no messages yet', () => {
    expect(renderHook(() => useThreadParticipantIds(undefined)).result.current).toBeUndefined();
    expect(renderHook(() => useThreadParticipantIds([])).result.current).toBeUndefined();
  });

  it('keeps its identity until someone new writes', () => {
    let messages = [msg('r', 'u-1'), msg('a', 'u-2')];
    const { result, rerender } = renderHook(() => useThreadParticipantIds(messages));
    const first = result.current;
    messages = [...messages, msg('b', 'u-1')];
    rerender();
    expect(result.current).toBe(first);
    messages = [...messages, msg('c', 'u-3')];
    rerender();
    expect(result.current).toEqual(['u-1', 'u-2', 'u-3']);
  });
});
