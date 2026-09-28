import { create } from 'zustand';

// Per-parent read position of the OPEN message list, shared between the list
// (which knows where the user is scrolled), the view's unread marker, and
// ChatPage's WS switchboard (which decides whether an arriving message is
// read on the spot). Module state + zustand so the WS handler can read it
// imperatively without re-subscribing, and the marker can subscribe per
// parent.
//
//   atBottom    — the list is parked at the live tail. Unknown parents read
//                 as true: before the list reports, the default open position
//                 IS the bottom (initialTopMostItemIndex 'end').
//   readThrough — the newest message ID this tab has read (optimistically,
//                 as the read is sent). Lets the marker tell "arrived while I
//                 was watching" (already read) from "arrived while scrolled
//                 up" (unread, gets the New divider).
//   ackedThrough — the newest read the SERVER confirmed. Dedups redundant
//                 PUTs without swallowing the retry of a failed one.
interface ReadPositionState {
  atBottom: Record<string, boolean>;
  readThrough: Record<string, string>;
  ackedThrough: Record<string, string>;
}

export const useReadPositionStore = create<ReadPositionState>(() => ({
  atBottom: {},
  readThrough: {},
  ackedThrough: {},
}));

export function setListAtBottom(parentID: string, atBottom: boolean): void {
  useReadPositionStore.setState((s) =>
    s.atBottom[parentID] === atBottom ? s : { atBottom: { ...s.atBottom, [parentID]: atBottom } },
  );
}

export function isListAtBottom(parentID: string): boolean {
  return useReadPositionStore.getState().atBottom[parentID] ?? true;
}

export function useListAtBottom(parentID: string | undefined): boolean {
  return useReadPositionStore((s) => (parentID ? (s.atBottom[parentID] ?? true) : true));
}

// setReadThrough only moves forward (message IDs are ULIDs, so string order is
// send order) — a late PUT for an older message can't regress it.
export function setReadThrough(parentID: string, messageID: string): void {
  useReadPositionStore.setState((s) => {
    const prev = s.readThrough[parentID];
    if (prev !== undefined && prev >= messageID) return s;
    return { readThrough: { ...s.readThrough, [parentID]: messageID } };
  });
}

export function getReadThrough(parentID: string): string | undefined {
  return useReadPositionStore.getState().readThrough[parentID];
}

// setAckedThrough: forward-only, like setReadThrough.
export function setAckedThrough(parentID: string, messageID: string): void {
  useReadPositionStore.setState((s) => {
    const prev = s.ackedThrough[parentID];
    if (prev !== undefined && prev >= messageID) return s;
    return { ackedThrough: { ...s.ackedThrough, [parentID]: messageID } };
  });
}

export function getAckedThrough(parentID: string): string | undefined {
  return useReadPositionStore.getState().ackedThrough[parentID];
}

export function useReadThrough(parentID: string | undefined): string | undefined {
  return useReadPositionStore((s) => (parentID ? s.readThrough[parentID] : undefined));
}

// clearReadPosition forgets a parent when its view closes, so reopening it
// starts from the server's read point instead of a stale local one.
export function clearReadPosition(parentID: string): void {
  useReadPositionStore.setState((s) => {
    if (!(parentID in s.atBottom) && !(parentID in s.readThrough) && !(parentID in s.ackedThrough)) return s;
    const atBottom = { ...s.atBottom };
    const readThrough = { ...s.readThrough };
    const ackedThrough = { ...s.ackedThrough };
    delete atBottom[parentID];
    delete readThrough[parentID];
    delete ackedThrough[parentID];
    return { atBottom, readThrough, ackedThrough };
  });
}
