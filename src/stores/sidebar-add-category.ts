import { create } from 'zustand';

// The sidebar header's "+" menu asks the channel list to open its
// "new category" field. A counter, so asking twice opens it twice.
export const useAddCategoryRequest = create<{ asked: number }>(() => ({ asked: 0 }));

export function requestAddCategory(): void {
  useAddCategoryRequest.setState((s) => ({ asked: s.asked + 1 }));
}
