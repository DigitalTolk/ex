// In-app preview for HTML attachments (design mockups agents post as .html).
//
// The file's markup is rendered in an <iframe srcdoc> that is sandboxed to
// scripts ONLY. Two rules carry the whole security story:
//
//  1. The sandbox never grants allow-same-origin. A srcdoc document with it
//     would run as the chat origin — reading the session, calling the API as
//     the viewer. Without it the frame is an opaque origin. Forms, popups,
//     top navigation, modals and downloads stay off too.
//  2. A srcdoc frame inherits the PAGE's CSP, which allows `connect-src https:`
//     and remote images — enough to beacon data out. buildPreviewDocument
//     prepends a stricter meta CSP that must be the first thing the parser
//     sees, so it applies before any of the file's own markup. A later meta
//     CSP in the file can only add restrictions, never lift these.
//
// What neither rule stops is the frame navigating itself (a link click,
// `location = …`) to an outside page, where our CSP no longer applies. See
// the frame guard below.

// The exact sandbox token list. Tests pin this value — widening it is a
// security review, not a refactor.
export const HTML_PREVIEW_SANDBOX = 'allow-scripts';

export const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

// ---------------------------------------------------------------------------
// Frame guard: is the frame still showing OUR document?
//
// Counting load events alone is not enough. A script at the top of the file
// that sets `location` before parsing finishes means the srcdoc never fires
// its own load — the outside page's load is the FIRST one the frame reports
// (measured in Chromium and WebKit). So the srcdoc carries a tiny beacon,
// injected right after the CSP meta and before any of the file's markup:
//
//  - it holds a per-preview nonce in a closure and removes its own <script>
//    element, so the file's scripts (which run later) cannot read the nonce;
//  - on the document's own trusted `load` it posts `<nonce>:ready`;
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

// How long the srcdoc's `ready` may trail its first load. In practice it
// arrives within milliseconds of it (the frame stays hidden meanwhile).
export const READY_GRACE_MS = 3000;
// While shown, the parent pings this often. Once MAX_MISSED_PINGS pings in a
// row went unanswered, the next tick closes the frame (2–3 s of silence).
export const PING_INTERVAL_MS = 1000;
export const MAX_MISSED_PINGS = 2;

// newPreviewNonce: getRandomValues (not randomUUID) because the latter needs a
// secure context, and a LAN dev server is not one. Hex only, so it can sit in
// a JS string literal unescaped.
export function newPreviewNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function beaconScript(nonce: string): string {
  return (
    '<script>(function(){' +
    `var p=parent,d=document,n="${nonce}";` +
    'd.currentScript.remove();' +
    'function s(k){p.postMessage(n+":"+k,"*")}' +
    'addEventListener("load",function(e){if(e.isTrusted&&e.target===d)s("ready")},true);' +
    'addEventListener("pagehide",function(){s("gone")},true);' +
    'addEventListener("message",function(e){if(e.source===p)s("alive")},true)' +
    '})()</script>'
  );
}

// buildPreviewDocument returns the srcdoc for the preview frame: our CSP meta
// first, then the guard beacon, then the file verbatim. A doctype inside the
// file is ignored by the parser at that point, which is harmless.
export function buildPreviewDocument(html: string, nonce: string): string {
  return (
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">` +
    beaconScript(nonce) +
    html
  );
}

export type FrameSignal = 'ready' | 'alive' | 'gone';

// readFrameSignal decodes a beacon message; anything without the nonce
// (including whatever the file's own scripts post) is null.
export function readFrameSignal(data: unknown, nonce: string): FrameSignal | null {
  if (typeof data !== 'string' || !data.startsWith(`${nonce}:`)) return null;
  const kind = data.slice(nonce.length + 1);
  return kind === 'ready' || kind === 'alive' || kind === 'gone' ? kind : null;
}

export interface FrameGuardState {
  // Load events the iframe element has fired.
  loads: number;
  // The srcdoc's own trusted load reported in.
  ready: boolean;
  // Liveness pings sent since the last answer.
  missed: number;
  // pending: not yet proven to be our document (kept hidden).
  // live: shown. closed: navigated away / lost — unmount it.
  status: 'pending' | 'live' | 'closed';
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
  if (state.status === 'closed') return state;
  switch (event.type) {
    case 'load': {
      const loads = state.loads + 1;
      // The first load is the srcdoc; any later one is somewhere else.
      if (loads > 1) return { ...state, loads, status: 'closed' };
      return { ...state, loads, status: state.ready ? 'live' : 'pending' };
    }
    case 'ready':
      return { ...state, ready: true, status: state.loads === 1 ? 'live' : state.status };
    case 'alive':
      return { ...state, missed: 0 };
    case 'gone':
      return { ...state, status: 'closed' };
    case 'ready-timeout':
      // Loaded, but not our document: the srcdoc never got to its own load.
      return state.status === 'pending' && state.loads > 0 ? { ...state, status: 'closed' } : state;
    case 'ping':
      if (state.status !== 'live') return state;
      if (state.missed >= MAX_MISSED_PINGS) return { ...state, status: 'closed' };
      return { ...state, missed: state.missed + 1 };
  }
}
