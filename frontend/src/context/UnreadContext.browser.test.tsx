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
  it('markChannelUnread adds to the set; clearChannelUnread removes it', async () => {
    const getState = await mountUnread();
    getState().markChannelUnread('ch-1');
    await vi.waitFor(() => expect(getState().unreadChannels.has('ch-1')).toBe(true));
    getState().clearChannelUnread('ch-1');
    await vi.waitFor(() => expect(getState().unreadChannels.has('ch-1')).toBe(false));
    // clearChannelUnread DELETEs the notification.
    expect(apiFetchMock).toHaveBeenCalledWith(expect.stringContaining('/notification'), expect.objectContaining({ method: 'DELETE' }));
  });

  it('markChannelUnread is suppressed when channel is active', async () => {
    const getState = await mountUnread();
    getState().setActiveChannel('ch-active');
    getState().markChannelUnread('ch-active');
    await new Promise((r) => setTimeout(r, 10));
    expect(getState().unreadChannels.has('ch-active')).toBe(false);
  });

  it('setActiveChannel(id) clears existing unread + fires API call', async () => {
    const getState = await mountUnread();
    getState().markChannelUnread('ch-x');
    await vi.waitFor(() => expect(getState().unreadChannels.has('ch-x')).toBe(true));
    getState().setActiveChannel('ch-x');
    await vi.waitFor(() => expect(getState().unreadChannels.has('ch-x')).toBe(false));
    expect(apiFetchMock).toHaveBeenCalled();
  });

  it('setActiveChannel(null) only clears the ref — no API call', async () => {
    const getState = await mountUnread();
    apiFetchMock.mockClear();
    getState().setActiveChannel(null);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('isActiveChannel/isActiveConversation reflect the latest ref values', async () => {
    const getState = await mountUnread();
    expect(getState().isActiveChannel('ch-y')).toBe(false);
    getState().setActiveChannel('ch-y');
    expect(getState().isActiveChannel('ch-y')).toBe(true);
    expect(getState().isActiveConversation('conv-z')).toBe(false);
    getState().setActiveConversation('conv-z');
    expect(getState().isActiveConversation('conv-z')).toBe(true);
  });

  it('markChannelNotificationUnread suppresses when active and fires user-state-changed otherwise', async () => {
    const getState = await mountUnread();
    let fired = 0;
    const handler = () => { fired++; };
    window.addEventListener(USER_STATE_CHANGED_EVENT, handler);
    getState().setActiveChannel('ch-a');
    getState().markChannelNotificationUnread('ch-a');
    expect(getState().unreadChannelNotifications.has('ch-a')).toBe(false);
    getState().markChannelNotificationUnread('ch-b');
    await vi.waitFor(() => expect(getState().unreadChannelNotifications.has('ch-b')).toBe(true));
    expect(fired).toBeGreaterThan(0);
    window.removeEventListener(USER_STATE_CHANGED_EVENT, handler);
  });

  it('resetSessionUnread clears the live channel AND conversation delta layers (no-op when empty)', async () => {
    const getState = await mountUnread();
    getState().markChannelUnread('ch-a');
    getState().markChannelUnread('ch-b');
    getState().markConversationUnread('conv-a');
    await vi.waitFor(() => {
      expect(getState().unreadChannels.size).toBe(2);
      expect(getState().unreadConversations.size).toBe(1);
    });
    getState().resetSessionUnread();
    await vi.waitFor(() => {
      expect(getState().unreadChannels.size).toBe(0);
      expect(getState().channelUnreadCounts.size).toBe(0);
      expect(getState().unreadConversations.size).toBe(0);
      expect(getState().conversationUnreadCounts.size).toBe(0);
    });
    // Safe to call again on already-empty state.
    getState().resetSessionUnread();
    expect(getState().unreadChannels.size).toBe(0);
  });

  it('markConversationUnread skips active conversation; markThreadNotificationUnread always adds', async () => {
    const getState = await mountUnread();
    getState().setActiveConversation('conv-c');
    getState().markConversationUnread('conv-c');
    expect(getState().unreadConversations.has('conv-c')).toBe(false);
    getState().markConversationUnread('conv-d');
    await vi.waitFor(() => expect(getState().unreadConversations.has('conv-d')).toBe(true));
    getState().markThreadNotificationUnread('thr-1');
    await vi.waitFor(() => expect(getState().unreadThreadNotifications.has('thr-1')).toBe(true));
  });

  it('clearConversationUnread removes a conversation from the unread set', async () => {
    const getState = await mountUnread();
    getState().markConversationUnread('conv-e');
    await vi.waitFor(() => expect(getState().unreadConversations.has('conv-e')).toBe(true));
    getState().clearConversationUnread('conv-e');
    await vi.waitFor(() => expect(getState().unreadConversations.has('conv-e')).toBe(false));
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

  it('setActiveConversation(null) clears the active ref without touching unread state', async () => {
    const getState = await mountUnread();
    getState().markConversationUnread('conv-keep');
    await vi.waitFor(() => expect(getState().unreadConversations.has('conv-keep')).toBe(true));
    // Passing null takes the `if (id)` false branch — no set/count mutation.
    getState().setActiveConversation(null);
    await new Promise((r) => setTimeout(r, 10));
    expect(getState().unreadConversations.has('conv-keep')).toBe(true);
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

  it('swallows API rejections from clear/hide/unhide and still updates local state', async () => {
    apiFetchMock.mockRejectedValue(new Error('server down'));
    const getState = await mountUnread();
    // clearChannelUnread → DELETE rejects → `.catch(() => undefined)` arm.
    getState().markChannelUnread('ch-rej');
    await vi.waitFor(() => expect(getState().unreadChannels.has('ch-rej')).toBe(true));
    getState().clearChannelUnread('ch-rej');
    await vi.waitFor(() => expect(getState().unreadChannels.has('ch-rej')).toBe(false));
    // hideConversation PUT + unhideConversation DELETE both reject.
    getState().hideConversation('conv-rej');
    await vi.waitFor(() => expect(getState().hiddenConversations.has('conv-rej')).toBe(true));
    getState().unhideConversation('conv-rej');
    await vi.waitFor(() => expect(getState().hiddenConversations.has('conv-rej')).toBe(false));
    // setActiveChannel(id) also fires a DELETE that rejects.
    getState().setActiveChannel('ch-active-rej');
    await new Promise((r) => setTimeout(r, 20));
  });

  it('clearChannelUnread on a channel with no recorded count short-circuits the count map', async () => {
    const getState = await mountUnread();
    // Never marked → not in the count map; the `!prev.has(id)` early-return
    // arm fires for setChannelUnreadCounts.
    getState().clearChannelUnread('ch-no-count');
    await vi.waitFor(() => expect(getState().unreadChannels.has('ch-no-count')).toBe(false));
  });

  it('setActiveConversation clears an existing live count for that conversation', async () => {
    const getState = await mountUnread();
    getState().markConversationUnread('conv-count');
    await vi.waitFor(() => expect(getState().conversationUnreadCounts.has('conv-count')).toBe(true));
    // Activating with a recorded count → the `prev.has(id)` true arm deletes it.
    getState().setActiveConversation('conv-count');
    await vi.waitFor(() => expect(getState().conversationUnreadCounts.has('conv-count')).toBe(false));
  });

  it('thread-seen event for an unknown thread id is a no-op (has-false arm)', async () => {
    const getState = await mountUnread();
    // No matching unreadThreadNotification → `!prev.has(threadRootID)` returns
    // the previous set unchanged.
    window.dispatchEvent(new CustomEvent('ex:thread-seen-changed', { detail: { threadRootID: 'thr-unknown' } }));
    await new Promise((r) => setTimeout(r, 10));
    expect(getState().unreadThreadNotifications.has('thr-unknown')).toBe(false);
  });

  it('syncServerCounts seeds absolute counts, drops zeros, and skips the active target', async () => {
    const getState = await mountUnread();
    getState().setActiveConversation('conv-active');
    getState().syncServerCounts(
      new Map([['ch-1', 3], ['ch-zero', 0]]),
      new Map([['conv-1', 2], ['conv-active', 9]]),
    );
    await vi.waitFor(() => {
      expect(getState().channelUnreadCounts.get('ch-1')).toBe(3);
      expect(getState().channelUnreadCounts.has('ch-zero')).toBe(false); // count <= 0 dropped
      expect(getState().conversationUnreadCounts.get('conv-1')).toBe(2);
      expect(getState().conversationUnreadCounts.has('conv-active')).toBe(false); // active skipped
    });
  });

  it('a single live DM stays 1 after a server sync (no double; equality short-circuit returns prev)', async () => {
    const getState = await mountUnread();
    getState().markConversationUnread('dm-1');
    await vi.waitFor(() => expect(getState().conversationUnreadCounts.get('dm-1')).toBe(1));
    // Server now reports the same 1 → reconcile is identical → returns prev.
    getState().syncServerCounts(new Map(), new Map([['dm-1', 1]]));
    await new Promise((r) => setTimeout(r, 10));
    expect(getState().conversationUnreadCounts.get('dm-1')).toBe(1);
  });

  it('clearConversationUnread on a conversation with no recorded count is a no-op for the count map', async () => {
    const getState = await mountUnread();
    // Never marked → not in the unread set nor the count map; clear short-
    // circuits both updaters (the `!prev.has(id)` early returns).
    getState().clearConversationUnread('conv-never');
    await new Promise((r) => setTimeout(r, 10));
    expect(getState().unreadConversations.has('conv-never')).toBe(false);
  });
});
