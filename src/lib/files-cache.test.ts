import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { invalidateParentFiles } from './files-cache';

describe('invalidateParentFiles', () => {
  it('refetches the parent Files panel, every filter of it', () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    invalidateParentFiles(qc, 'ch-1', 'channel');
    invalidateParentFiles(qc, 'dm-1', 'conversation');
    invalidateParentFiles(qc, 'x', undefined);
    expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual([
      ['files', 'channels/ch-1'],
      ['files', 'conversations/dm-1'],
    ]);
  });
});
