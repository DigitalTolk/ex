import { describe, expect, it } from 'vitest';
import {
  buildPreviewDocument,
  frameGuard,
  HTML_PREVIEW_CSP,
  HTML_PREVIEW_SANDBOX,
  initialFrameGuard,
  MAX_MISSED_PINGS,
  newPreviewNonce,
  readFrameSignal,
  type FrameGuardEvent,
  type FrameGuardState,
} from './html-preview';

const NONCE = '0123456789abcdef0123456789abcdef';

describe('HTML preview sandbox', () => {
  it('grants scripts and nothing else', () => {
    // Pinned on purpose: allow-same-origin would run the file as the chat
    // origin (account takeover); forms/popups/navigation/modals/downloads
    // stay off too. Changing this value needs a security review.
    expect(HTML_PREVIEW_SANDBOX).toBe('allow-scripts');
  });
});

describe('buildPreviewDocument', () => {
  const META = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`;

  it('puts the CSP meta first, before any of the file', () => {
    const doc = buildPreviewDocument('<h1>Mockup</h1>', NONCE);
    expect(doc.startsWith(META)).toBe(true);
    expect(doc.endsWith('<h1>Mockup</h1>')).toBe(true);
  });

  it('uses the strict policy: no network, no outside resources', () => {
    expect(HTML_PREVIEW_CSP).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; " +
        "font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'",
    );
  });

  it('keeps the meta first when the file brings its own doctype and head', () => {
    const file = '<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body>x</body></html>';
    const doc = buildPreviewDocument(file, NONCE);
    expect(doc.startsWith(META)).toBe(true);
    expect(doc.endsWith(file)).toBe(true);
    // As the parser sees it: our meta is the first element of <head>, with
    // the policy intact (no quote in the policy breaks out of the attribute).
    const parsed = new DOMParser().parseFromString(doc, 'text/html');
    const first = parsed.head.firstElementChild!;
    expect(first.tagName).toBe('META');
    expect(first.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(first.getAttribute('content')).toBe(HTML_PREVIEW_CSP);
  });

  it('places the guard beacon between the meta and the file, carrying the nonce', () => {
    const doc = buildPreviewDocument('<p>file</p>', NONCE);
    const beacon = doc.slice(META.length, doc.length - '<p>file</p>'.length);
    expect(beacon.startsWith('<script>')).toBe(true);
    expect(beacon.endsWith('</script>')).toBe(true);
    expect(beacon).toContain(`n="${NONCE}"`);
    // It hides itself before the file's scripts can read the nonce.
    expect(beacon).toContain('d.currentScript.remove()');
    // Only the document's own trusted load reports ready.
    expect(beacon).toContain('e.isTrusted&&e.target===d');
  });
});

describe('newPreviewNonce', () => {
  it('is 32 hex chars and different every time', () => {
    const a = newPreviewNonce();
    const b = newPreviewNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe('readFrameSignal', () => {
  it('decodes the beacon signals for this nonce', () => {
    expect(readFrameSignal(`${NONCE}:ready`, NONCE)).toBe('ready');
    expect(readFrameSignal(`${NONCE}:alive`, NONCE)).toBe('alive');
    expect(readFrameSignal(`${NONCE}:gone`, NONCE)).toBe('gone');
  });

  it('ignores anything else, including what the file itself posts', () => {
    expect(readFrameSignal(`${NONCE}:other`, NONCE)).toBeNull();
    expect(readFrameSignal(`other-nonce:ready`, NONCE)).toBeNull();
    expect(readFrameSignal('ready', NONCE)).toBeNull();
    expect(readFrameSignal({ nonce: NONCE }, NONCE)).toBeNull();
    expect(readFrameSignal(undefined, NONCE)).toBeNull();
  });
});

describe('frameGuard', () => {
  function run(...events: FrameGuardEvent['type'][]): FrameGuardState {
    return events.reduce<FrameGuardState>((s, type) => frameGuard(s, { type } as FrameGuardEvent), initialFrameGuard);
  }

  it('starts hidden and shows once the first load and the srcdoc ready both arrived', () => {
    expect(initialFrameGuard.status).toBe('pending');
    expect(run('load').status).toBe('pending');
    // Either order: ready usually trails the element's load event.
    expect(run('load', 'ready').status).toBe('live');
    expect(run('ready').status).toBe('pending');
    expect(run('ready', 'load').status).toBe('live');
  });

  it('closes on any load after the first', () => {
    expect(run('load', 'ready', 'load').status).toBe('closed');
    expect(run('load', 'load').status).toBe('closed');
  });

  it('closes when the first load is not followed by ready (navigated before its own load)', () => {
    expect(run('load', 'ready-timeout').status).toBe('closed');
  });

  it('ignores a ready timeout that no longer applies', () => {
    // Nothing loaded yet: still waiting on the srcdoc.
    expect(run('ready-timeout').status).toBe('pending');
    // Already proven.
    expect(run('load', 'ready', 'ready-timeout').status).toBe('live');
  });

  it('closes when the document reports it is going away', () => {
    expect(run('load', 'ready', 'gone').status).toBe('closed');
    expect(run('gone').status).toBe('closed');
  });

  it('closes after too many unanswered liveness pings, and an answer resets the count', () => {
    const pings = Array<FrameGuardEvent['type']>(MAX_MISSED_PINGS).fill('ping');
    expect(run('load', 'ready', ...pings).status).toBe('live');
    expect(run('load', 'ready', ...pings).missed).toBe(MAX_MISSED_PINGS);
    expect(run('load', 'ready', ...pings, 'ping').status).toBe('closed');
    const answered = run('load', 'ready', ...pings, 'alive');
    expect(answered.missed).toBe(0);
    expect(frameGuard(answered, { type: 'ping' }).status).toBe('live');
  });

  it('only counts pings while shown', () => {
    expect(run('ping', 'ping', 'ping', 'ping')).toEqual(initialFrameGuard);
  });

  it('stays closed until reset, which starts over', () => {
    const closed = run('load', 'load');
    expect(frameGuard(closed, { type: 'ready' })).toBe(closed);
    expect(frameGuard(closed, { type: 'load' })).toBe(closed);
    expect(frameGuard(closed, { type: 'reset' })).toEqual(initialFrameGuard);
  });
});
