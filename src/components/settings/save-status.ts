import { createContext, useContext } from 'react';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface SaveStatusValue {
  state: SaveState;
  // Wrap an async save so the dialog shows "Saving…" → "Saved". Failures flip
  // the state to "error"; the page shows its own message inline.
  track: <T>(p: Promise<T>) => Promise<T>;
}

export const SaveStatusContext = createContext<SaveStatusValue | null>(null);

function passThrough<T>(p: Promise<T>): Promise<T> {
  return p;
}

// Pages route their saves through the shared indicator with this. Outside a
// provider (e.g. a page rendered on its own) saves pass straight through.
export function useSaveTracker(): SaveStatusValue['track'] {
  return useContext(SaveStatusContext)?.track ?? passThrough;
}
