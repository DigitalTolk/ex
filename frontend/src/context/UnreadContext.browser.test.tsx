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

  it('clearConversationUnread on a conversation with no recorded count is a no-op for the count map', async () => {
    const getState = await mountUnread();
    // Never marked → not in the unread set nor the count map; clear short-
    // circuits both updaters (the `!prev.has(id)` early returns).
    getState().clearConversationUnread('conv-never');
    await new Promise((r) => setTimeout(r, 10));
    expect(getState().unreadConversations.has('conv-never')).toBe(false);
  });
});
