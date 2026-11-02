import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { UnreadProvider, useUnread } from './UnreadContext';
import { useEffect, useRef } from 'react';
import { setActiveParent } from '@/stores/active-parent';

const apiFetchMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined));
vi.mock('@/lib/api', () => ({
  apiFetch: apiFetchMock,
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
  it('active channel/conversation scope comes from the active-parent store and fires no API', async () => {
    const getState = await mountUnread();
    apiFetchMock.mockClear();
    expect(getState().isActiveChannel('ch-y')).toBe(false);
    setActiveParent({ kind: 'channel', id: 'ch-y' });
    expect(getState().isActiveChannel('ch-y')).toBe(true);
    expect(getState().isActiveConversation('conv-z')).toBe(false);
    setActiveParent({ kind: 'conversation', id: 'conv-z' });
    expect(getState().isActiveConversation('conv-z')).toBe(true);
    // One active parent: the conversation replaced the channel.
    expect(getState().isActiveChannel('ch-y')).toBe(false);
    setActiveParent(null);
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

  it('setActiveThread tracks the active thread', async () => {
    const getState = await mountUnread();
    expect(getState().isActiveThread('thr-active')).toBe(false);
    getState().setActiveThread('thr-active');
    expect(getState().isActiveThread('thr-active')).toBe(true);
    // Closing it clears the active scope again.
    getState().setActiveThread(null);
    expect(getState().isActiveThread('thr-active')).toBe(false);
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
});
