import { describe, expect, it } from 'vitest';
import {
  frameGuard,
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
    expect(readFrameSignal(`${NONCE}:failed`, NONCE)).toBe('failed');
    expect(readFrameSignal(`${NONCE}:alive`, NONCE)).toBe('alive');
    expect(readFrameSignal(`${NONCE}:gone`, NONCE)).toBe('gone');
  });

  it('ignores anything else, including what the file itself posts', () => {
    expect(readFrameSignal(`${NONCE}:other`, NONCE)).toBeNull();
    expect(readFrameSignal(`other-nonce:ready`, NONCE)).toBeNull();
    // A document whose frame had no name (one the file navigated to).
    expect(readFrameSignal(':ready', NONCE)).toBeNull();
    expect(readFrameSignal('ready', NONCE)).toBeNull();
    expect(readFrameSignal({ nonce: NONCE }, NONCE)).toBeNull();
    expect(readFrameSignal(undefined, NONCE)).toBeNull();
  });
});

describe('frameGuard', () => {
  function run(...events: FrameGuardEvent['type'][]): FrameGuardState {
    return events.reduce<FrameGuardState>((s, type) => frameGuard(s, { type } as FrameGuardEvent), initialFrameGuard);
  }

  it('starts hidden and shows once the first load and the document ready both arrived', () => {
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
    // Nothing loaded yet: still waiting on the document.
    expect(run('ready-timeout').status).toBe('pending');
    // Already proven.
    expect(run('load', 'ready', 'ready-timeout').status).toBe('live');
  });

  it('closes when the document reports it is going away', () => {
    expect(run('load', 'ready', 'gone').status).toBe('closed');
    expect(run('gone').status).toBe('closed');
  });

  it('fails when the server had no file to show, in either order with the load', () => {
    expect(run('failed').status).toBe('failed');
    expect(run('load', 'failed').status).toBe('failed');
    expect(run('failed', 'load').status).toBe('failed');
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

  it('stays closed or failed until reset, which starts over', () => {
    const closed = run('load', 'load');
    expect(frameGuard(closed, { type: 'ready' })).toBe(closed);
    expect(frameGuard(closed, { type: 'load' })).toBe(closed);
    expect(frameGuard(closed, { type: 'failed' })).toBe(closed);
    expect(frameGuard(closed, { type: 'reset' })).toEqual(initialFrameGuard);
    // The frame of a failed preview unloads: its `gone` must not turn the
    // error into the "tried to open another page" notice.
    const failed = run('load', 'failed');
    expect(frameGuard(failed, { type: 'gone' })).toBe(failed);
    expect(frameGuard(failed, { type: 'ready' })).toBe(failed);
    expect(frameGuard(failed, { type: 'reset' })).toEqual(initialFrameGuard);
  });
});
