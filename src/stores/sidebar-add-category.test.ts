import { describe, expect, it } from 'vitest';
import { requestAddCategory, useAddCategoryRequest } from './sidebar-add-category';

describe('sidebar add-category request', () => {
  it('starts with nothing asked', () => {
    expect(useAddCategoryRequest.getState().asked).toBe(0);
  });

  it('counts each request, so asking twice opens the field twice', () => {
    const seen: number[] = [];
    const unsubscribe = useAddCategoryRequest.subscribe((s) => seen.push(s.asked));
    requestAddCategory();
    requestAddCategory();
    unsubscribe();
    expect(useAddCategoryRequest.getState().asked).toBe(2);
    expect(seen).toEqual([1, 2]);
  });
});
