// In-app preview for HTML attachments (design mockups agents post as .html).
//
// The server serves the file as its own document from the preview route
// (htmlPreviewURL in lib/html-attachment.ts; internal/handler/html_preview.go),
// and the panel frames that URL. Three rules carry the security story:
//
//  1. The frame's sandbox never grants allow-same-origin, and the response's
//     own CSP repeats `sandbox allow-scripts`, so the file always runs in an
//     opaque origin — never as the chat origin with the viewer's session.
//     Forms, popups, top navigation, modals and downloads stay off too.
//  2. That response CSP is the document's whole policy: inline script and
//     style, data:/blob: media, and nothing that reaches the network. It is
//     NOT a srcdoc, which would inherit the app page's policy — and force the
//     page to allow every inline script.
//  3. The app page's frame-src allows the preview route and nothing else, so
//     the frame cannot navigate itself (a link, `location = …`) to an outside
//     page; the frame guard below closes it if it goes anywhere regardless.

// The exact sandbox token list. Tests pin this value — widening it is a
// security review, not a refactor.
export const HTML_PREVIEW_SANDBOX = 'allow-scripts';

// ---------------------------------------------------------------------------
// Frame guard: is the frame still showing OUR document?
//
// Counting load events alone is not enough. A script at the top of the file
// that sets `location` before parsing finishes means our document never fires
// its own load — the outside page's load is the FIRST one the frame reports
// (measured in Chromium and WebKit). So the server puts a tiny beacon ahead of
// the file:
//
//  - the panel names the frame with a per-preview nonce; the beacon reads it
//    from window.name and clears that, holds it in a closure and removes its
//    own <script> element, all before the file's scripts run;
//  - on the document's own trusted `load` it posts `<nonce>:ready` (the
//    server's "no file to show" document posts `<nonce>:failed` instead);
//  - on `pagehide` (the document going away) it posts `<nonce>:gone`;
//  - it answers every message from the parent with `<nonce>:alive`.
//
// An outside page cannot produce the nonce. The panel only reveals the frame
// once it has seen exactly one load AND `ready`, closes it on a second load,
// on `gone`, if `ready` never follows the first load, or once liveness pings
// stop being answered (a page that never finishes loading fires no second
// load; document.open() wipes the beacon's listeners). Every failure mode
// closes the frame — none of them can keep an outside page on screen.

// What the parent sends the frame on each liveness tick. The beacon answers
// any message from the parent, so the content does not matter.
export const HTML_PREVIEW_PING = 'ex-html-preview:ping';

// How long the document's `ready` may trail its first load. In practice it
// arrives within milliseconds of it (the frame stays hidden meanwhile).
export const READY_GRACE_MS = 3000;
// While shown, the parent pings this often. Once MAX_MISSED_PINGS pings in a
// row went unanswered, the next tick closes the frame (2–3 s of silence).
export const PING_INTERVAL_MS = 1000;
export const MAX_MISSED_PINGS = 2;

// newPreviewNonce: getRandomValues (not randomUUID) because the latter needs a
// secure context, and a LAN dev server is not one.
export function newPreviewNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export type FrameSignal = 'ready' | 'failed' | 'alive' | 'gone';

const SIGNALS: readonly string[] = ['ready', 'failed', 'alive', 'gone'] satisfies FrameSignal[];

// readFrameSignal decodes a beacon message; anything without the nonce
// (including whatever the file's own scripts post) is null.
export function readFrameSignal(data: unknown, nonce: string): FrameSignal | null {
  if (typeof data !== 'string' || !data.startsWith(`${nonce}:`)) return null;
  const kind = data.slice(nonce.length + 1);
  return SIGNALS.includes(kind) ? (kind as FrameSignal) : null;
}

export interface FrameGuardState {
  // Load events the iframe element has fired.
  loads: number;
  // Our document's own trusted load reported in.
  ready: boolean;
  // Liveness pings sent since the last answer.
  missed: number;
  // pending: not yet proven to be our document (kept hidden).
  // live: shown. closed: navigated away / lost — unmount it.
  // failed: the server had no file to show (expired link, not HTML, outage).
  status: 'pending' | 'live' | 'closed' | 'failed';
}

export type FrameGuardEvent =
  | { type: 'load' }
  | { type: FrameSignal }
  | { type: 'ready-timeout' }
  | { type: 'ping' }
  | { type: 'reset' };

export const initialFrameGuard: FrameGuardState = { loads: 0, ready: false, missed: 0, status: 'pending' };

export function frameGuard(state: FrameGuardState, event: FrameGuardEvent): FrameGuardState {
  if (event.type === 'reset') return initialFrameGuard;
  // Both end states hold until a reset: the frame is already gone.
  if (state.status === 'closed' || state.status === 'failed') return state;
  switch (event.type) {
    case 'load': {
      const loads = state.loads + 1;
      // The first load is our document; any later one is somewhere else.
      if (loads > 1) return { ...state, loads, status: 'closed' };
      return { ...state, loads, status: state.ready ? 'live' : 'pending' };
    }
    case 'ready':
      return { ...state, ready: true, status: state.loads === 1 ? 'live' : state.status };
    case 'failed':
      return { ...state, status: 'failed' };
    case 'alive':
      return { ...state, missed: 0 };
    case 'gone':
      return { ...state, status: 'closed' };
    case 'ready-timeout':
      // Loaded, but not our document: ours never got to its own load.
      return state.status === 'pending' && state.loads > 0 ? { ...state, status: 'closed' } : state;
    case 'ping':
      if (state.status !== 'live') return state;
      if (state.missed >= MAX_MISSED_PINGS) return { ...state, status: 'closed' };
      return { ...state, missed: state.missed + 1 };
  }
}
