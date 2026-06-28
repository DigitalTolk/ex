import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { UnreadProvider, useUnread, USER_STATE_CHANGED_EVENT } from './UnreadContext';
import { useEffect, useRef } from 'react';

const apiFetchMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined));
vi.mock('@/lib/api', () => ({
  apiFetch: apiFetchMock,
}));

vi.mock('@/hooks/useThreads', () => ({
  THREAD_SEEN_CHANGED_EVENT: 'ex:thread-seen-changed',
}));

function Probe({ onState }: { onState: (s: ReturnType<typeof useUnread>) => void }) {
  const s = useUnread();
  const ref = useRef(onState);
  useEffect(() => {
    ref.current = onState;
  }, [onState]);
  useEffect(() => { ref.current(s); });
  return null;
}

async function mountUnread() {
  let captured: ReturnType<typeof useUnread> | null = null;
  await render(
    <UnreadProvider>
      <Probe onState={(s) => { captured = s; }} />
    </UnreadProvider>,
  );
  await vi.waitFor(() => expect(captured).not.toBeNull());
  return () => captured!;
}

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue(undefined);
  try { localStorage.removeItem('hidden_conversations'); } catch { /* noop */ }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UnreadContext (browser)', () => {
  it('markThreadNotificationUnread adds to the set and fires user-state-changed', async () => {
    const getState = await mountUnread();
    let fired = 0;
    const handler = () => { fired++; };
    window.addEventListener(USER_STATE_CHANGED_EVENT, handler);
    getState().markThreadNotificationUnread('thr-1');
    await vi.waitFor(() => expect(getState().unreadThreadNotifications.has('thr-1')).toBe(true));
    expect(fired).toBeGreaterThan(0);
    window.removeEventListener(USER_STATE_CHANGED_EVENT, handler);
  });

  it('active channel/conversation scope is ref-only — reflected by isActive*, fires no API', async () => {
    const getState = await mountUnread();
    apiFetchMock.mockClear();
    expect(getState().isActiveChannel('ch-y')).toBe(false);
    getState().setActiveChannel('ch-y');
    expect(getState().isActiveChannel('ch-y')).toBe(true);
    expect(getState().isActiveConversation('conv-z')).toBe(false);
    getState().setActiveConversation('conv-z');
    expect(getState().isActiveConversation('conv-z')).toBe(true);
    // Setting null clears the ref.
    getState().setActiveChannel(null);
    getState().setActiveConversation(null);
    expect(getState().isActiveChannel('ch-y')).toBe(false);
    expect(getState().isActiveConversation('conv-z')).toBe(false);
    // Active scope no longer persists anything server-side.
    await new Promise((r) => setTimeout(r, 10));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('hideConversation persists + fires API PUT; unhideConversation reverses it', async () => {
    const getState = await mountUnread();
    getState().hideConversation('conv-h');
    await vi.waitFor(() => expect(getState().hiddenConversations.has('conv-h')).toBe(true));
    expect(localStorage.getItem('hidden_conversations')).toContain('conv-h');
    expect(apiFetchMock).toHaveBeenCalledWith(expect.stringContaining('/hidden'), expect.objectContaining({ method: 'PUT' }));

    getState().unhideConversation('conv-h');
    await vi.waitFor(() => expect(getState().hiddenConversations.has('conv-h')).toBe(false));
    expect(apiFetchMock).toHaveBeenCalledWith(expect.stringContaining('/hidden'), expect.objectContaining({ method: 'DELETE' }));
  });

  it('unhideConversation is a no-op when the id is not hidden', async () => {
    const getState = await mountUnread();
    apiFetchMock.mockClear();
    getState().unhideConversation('conv-not-hidden');
    await new Promise((r) => setTimeout(r, 10));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('setActiveThread tracks the active thread and clears its pending notification', async () => {
    const getState = await mountUnread();
    // A reply landed just before the thread was opened.
    getState().markThreadNotificationUnread('thr-active');
    await vi.waitFor(() => expect(getState().unreadThreadNotifications.has('thr-active')).toBe(true));
    expect(getState().isActiveThread('thr-active')).toBe(false);
    // Opening the thread marks it active and drops the pending highlight.
    getState().setActiveThread('thr-active');
    expect(getState().isActiveThread('thr-active')).toBe(true);
    await vi.waitFor(() => expect(getState().unreadThreadNotifications.has('thr-active')).toBe(false));
    // Closing it clears the active scope again.
    getState().setActiveThread(null);
    expect(getState().isActiveThread('thr-active')).toBe(false);
  });

  it('setActiveThread(null) / activating a thread with no notification leaves other notifications intact', async () => {
    const getState = await mountUnread();
    getState().markThreadNotificationUnread('thr-keep-2');
    await vi.waitFor(() => expect(getState().unreadThreadNotifications.has('thr-keep-2')).toBe(true));
    // Closing (null) doesn't touch notifications.
    getState().setActiveThread(null);
    // Activating an unrelated thread that has no pending notification is a
    // no-op on the set (covers the !has(id) early return).
    getState().setActiveThread('thr-no-notif');
    await new Promise((r) => setTimeout(r, 10));
    expect(getState().unreadThreadNotifications.has('thr-keep-2')).toBe(true);
    expect(getState().isActiveThread('thr-no-notif')).toBe(true);
  });

  it('thread-seen window event clears matching unreadThreadNotification', async () => {
    const getState = await mountUnread();
    getState().markThreadNotificationUnread('thr-x');
    await vi.waitFor(() => expect(getState().unreadThreadNotifications.has('thr-x')).toBe(true));
    window.dispatchEvent(new CustomEvent('ex:thread-seen-changed', { detail: { threadRootID: 'thr-x' } }));
    await vi.waitFor(() => expect(getState().unreadThreadNotifications.has('thr-x')).toBe(false));
  });

  it('thread-seen event without threadRootID is a no-op', async () => {
    const getState = await mountUnread();
    getState().markThreadNotificationUnread('thr-keep');
    await vi.waitFor(() => expect(getState().unreadThreadNotifications.has('thr-keep')).toBe(true));
    window.dispatchEvent(new CustomEvent('ex:thread-seen-changed', { detail: {} }));
    await new Promise((r) => setTimeout(r, 10));
    expect(getState().unreadThreadNotifications.has('thr-keep')).toBe(true);
  });

  it('useUnread throws when called outside an UnreadProvider', async () => {
    function Boom() {
      let threw = false;
      try {
        useUnread();
      } catch {
        threw = true;
      }
      return <div data-testid="boom" data-threw={String(threw)} />;
    }
    const screen = await render(<Boom />);
    expect(screen.getByTestId('boom').element().getAttribute('data-threw')).toBe('true');
  });

  it('swallows API rejections from hide/unhide and still updates local state', async () => {
    apiFetchMock.mockRejectedValue(new Error('server down'));
    const getState = await mountUnread();
    // hideConversation PUT + unhideConversation DELETE both reject → `.catch` arm.
    getState().hideConversation('conv-rej');
    await vi.waitFor(() => expect(getState().hiddenConversations.has('conv-rej')).toBe(true));
    getState().unhideConversation('conv-rej');
    await vi.waitFor(() => expect(getState().hiddenConversations.has('conv-rej')).toBe(false));
  });

  it('thread-seen event for an unknown thread id is a no-op (has-false arm)', async () => {
    const getState = await mountUnread();
    // No matching unreadThreadNotification → `!prev.has(threadRootID)` returns
    // the previous set unchanged.
    window.dispatchEvent(new CustomEvent('ex:thread-seen-changed', { detail: { threadRootID: 'thr-unknown' } }));
    await new Promise((r) => setTimeout(r, 10));
    expect(getState().unreadThreadNotifications.has('thr-unknown')).toBe(false);
  });
});
