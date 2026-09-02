// thread-scope tracks which thread roots the user is currently READING in
// this tab, so a reply to one of them never alerts (SPEC I-5 / GAP-4, GAP-5).
// Two registration surfaces feed it:
//   - the open ThreadPanel (URL ?thread= or "Reply in thread") — one root,
//     registered by UnreadContext.setActiveThread;
//   - /threads inline cards currently in the viewport (decision D-3:
//     "reading" on /threads = the card is in view; the attention gates —
//     visible + focused + fresh input — are applied by the suppression check
//     itself, so a background tab's registered cards never suppress).
//
// NotificationContext consults isThreadInView() for popup/sound suppression;
// UnreadContext consults it for the Threads-nav badge; tab-leader broadcasts
// the snapshot so the LEADER tab can suppress for a thread being read in a
// sibling tab.

let panelThread: string | null = null;
const inViewThreads = new Set<string>();

// Cap the broadcast snapshot so a pathological /threads viewport (zoomed out,
// hundreds of tiny cards) can't bloat the cross-tab state message.
const snapshotCap = 30;

// scopeBroadcast lets the cross-tab coordinator (tab-leader) re-broadcast
// this tab's snapshot whenever the reading scope changes. Nullable seam —
// nothing is forwarded until the coordinator registers.
let scopeBroadcast: (() => void) | null = null;

export function setThreadScopeBroadcast(cb: (() => void) | null): void {
  scopeBroadcast = cb;
}

// setPanelThread registers the thread root open in the ThreadPanel (null on
// close). Called via UnreadContext.setActiveThread.
export function setPanelThread(threadRootID: string | null): void {
  if (panelThread === threadRootID) return;
  panelThread = threadRootID;
  scopeBroadcast?.();
}

// addInViewThread / removeInViewThread register a /threads card entering /
// leaving the viewport.
export function addInViewThread(threadRootID: string): void {
  if (inViewThreads.has(threadRootID)) return;
  inViewThreads.add(threadRootID);
  scopeBroadcast?.();
}

export function removeInViewThread(threadRootID: string): void {
  if (!inViewThreads.delete(threadRootID)) return;
  scopeBroadcast?.();
}

// isThreadInView: is this thread root on screen in THIS tab right now?
export function isThreadInView(threadRootID: string): boolean {
  return panelThread === threadRootID || inViewThreads.has(threadRootID);
}

// threadScopeSnapshot returns the roots being read in this tab, for the
// cross-tab state broadcast. Panel first — it survives the cap.
export function threadScopeSnapshot(): string[] {
  const ids: string[] = [];
  if (panelThread) ids.push(panelThread);
  for (const id of inViewThreads) {
    if (ids.length >= snapshotCap) break;
    if (id !== panelThread) ids.push(id);
  }
  return ids;
}

export function resetThreadScopeForTests(): void {
  panelThread = null;
  inViewThreads.clear();
  scopeBroadcast = null;
}
