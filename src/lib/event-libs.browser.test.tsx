import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  dispatchEditMessage,
  dispatchFocusComposer,
  registerEditMessageHandler,
  onFocusComposer,
  WINDOW_EVENTS,
} from './window-events';
import {
  formatDocumentTitle,
  setDocumentNotificationCount,
  getDocumentNotificationCount,
  subscribeDocumentNotificationCount,
} from './document-title';

describe('window-events — edit message handlers', () => {
  beforeEach(() => {
    // Reset any leftover registrations from earlier tests.
  });

  it('dispatchEditMessage fires the registered handler for the matching id', () => {
    const handler = vi.fn();
    const unsubscribe = registerEditMessageHandler('m-1', handler);
    dispatchEditMessage({ messageId: 'm-1' });
    expect(handler).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('dispatchEditMessage does NOT fire handlers for other ids', () => {
    const handler = vi.fn();
    const unsubscribe = registerEditMessageHandler('m-1', handler);
    dispatchEditMessage({ messageId: 'other' });
    expect(handler).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('returned unsubscribe removes the handler', () => {
    const handler = vi.fn();
    const unsubscribe = registerEditMessageHandler('m-2', handler);
    unsubscribe();
    dispatchEditMessage({ messageId: 'm-2' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores an edit-message event dispatched with no messageId in detail', () => {
    const handler = vi.fn();
    const unsubscribe = registerEditMessageHandler('m-x', handler);
    // A raw event with empty detail → the singleton listener's `if (id)` guard
    // (id undefined) takes its false side and no handler is invoked.
    window.dispatchEvent(new CustomEvent(WINDOW_EVENTS.EditMessage, { detail: {} }));
    expect(handler).not.toHaveBeenCalled();
    // And an event with no detail at all (ce.detail?.messageId → undefined).
    window.dispatchEvent(new CustomEvent(WINDOW_EVENTS.EditMessage));
    expect(handler).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('unsubscribe is a no-op if a different handler has since replaced ours', () => {
    const oldHandler = vi.fn();
    const newHandler = vi.fn();
    const unsubscribeOld = registerEditMessageHandler('m-3', oldHandler);
    registerEditMessageHandler('m-3', newHandler);
    unsubscribeOld();
    dispatchEditMessage({ messageId: 'm-3' });
    expect(newHandler).toHaveBeenCalled();
  });
});

describe('window-events — focus composer', () => {
  it('onFocusComposer delivers detail payload to the listener', () => {
    const handler = vi.fn();
    const off = onFocusComposer(handler);
    dispatchFocusComposer({ parentID: 'ch-1', inThread: false });
    expect(handler).toHaveBeenCalledWith({ parentID: 'ch-1', inThread: false });
    off();
  });

  it('onFocusComposer can be torn down', () => {
    const handler = vi.fn();
    const off = onFocusComposer(handler);
    off();
    dispatchFocusComposer({ parentID: 'ch-2', inThread: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it('falls back silently when the event is dispatched with no detail', () => {
    const handler = vi.fn();
    const off = onFocusComposer(handler);
    window.dispatchEvent(new CustomEvent(WINDOW_EVENTS.FocusComposer));
    expect(handler).not.toHaveBeenCalled();
    off();
  });
});

describe('document-title', () => {
  beforeEach(() => {
    setDocumentNotificationCount(0);
  });

  it('formatDocumentTitle prefixes the count when positive', () => {
    expect(formatDocumentTitle('General', 3)).toBe('(3) General · ex');
    expect(formatDocumentTitle(null, 0)).toBe('ex');
    expect(formatDocumentTitle(undefined, 5)).toBe('(5) ex');
  });

  it('formatDocumentTitle uses the live count when no override is passed', () => {
    setDocumentNotificationCount(7);
    expect(formatDocumentTitle('General')).toBe('(7) General · ex');
    setDocumentNotificationCount(0);
  });

  it('setDocumentNotificationCount notifies subscribers and floors negatives', () => {
    const listener = vi.fn();
    const off = subscribeDocumentNotificationCount(listener);
    setDocumentNotificationCount(2);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getDocumentNotificationCount()).toBe(2);

    // Setting the same value is a no-op.
    setDocumentNotificationCount(2);
    expect(listener).toHaveBeenCalledTimes(1);

    // Negative / non-finite inputs floor to 0.
    setDocumentNotificationCount(-5);
    expect(getDocumentNotificationCount()).toBe(0);
    setDocumentNotificationCount(Number.NaN);
    expect(getDocumentNotificationCount()).toBe(0);

    off();
  });
});
