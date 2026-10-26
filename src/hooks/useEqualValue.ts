import { useState } from 'react';

// useEqualValue returns the previous value while `isEqual` says the new one
// has the same content, so a value rebuilt with identical content (a lookup
// map recomputed after a refetch) keeps its identity and doesn't re-render
// every memoized consumer. A changed value is adopted during this render (the
// "adjust state while rendering" pattern), so consumers never see it late.
export function useEqualValue<T>(value: T, isEqual: (a: T, b: T) => boolean): T {
  const [kept, setKept] = useState(value);
  const same = kept === value || isEqual(kept, value);
  if (!same) setKept(value);
  return same ? kept : value;
}
