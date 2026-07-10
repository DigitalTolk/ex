import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { useIsOnline, usePresenceStore } from './presence';

// Browser twin of presence.test.ts — the store file is graded by both
// suites. Hook subscription is exercised through a rendered probe
// (RTL's renderHook is jsdom-only).

function Probe({ id, tid }: { id?: string; tid: string }) {
  const online = useIsOnline(id);
  return <span data-testid={tid}>{String(online)}</span>;
}

describe('presence store (browser)', () => {
  it('setUserOnline adds and removes users', () => {
    usePresenceStore.getState().setUserOnline('u-1', true);
    expect(usePresenceStore.getState().online.has('u-1')).toBe(true);
    usePresenceStore.getState().setUserOnline('u-1', false);
    expect(usePresenceStore.getState().online.has('u-1')).toBe(false);
  });

  it('setUserOnline bails out identity-stable on no-op transitions', () => {
    usePresenceStore.getState().setUserOnline('u-1', true);
    const before = usePresenceStore.getState().online;
    usePresenceStore.getState().setUserOnline('u-1', true);
    expect(usePresenceStore.getState().online).toBe(before);
    usePresenceStore.getState().setUserOnline('u-ghost', false);
    expect(usePresenceStore.getState().online).toBe(before);
  });

  it('replaceOnline swaps the whole set', () => {
    usePresenceStore.getState().setUserOnline('u-old', true);
    usePresenceStore.getState().replaceOnline(['u-a', 'u-b']);
    const online = usePresenceStore.getState().online;
    expect(online.has('u-old')).toBe(false);
    expect(online.has('u-a')).toBe(true);
    expect(online.has('u-b')).toBe(true);
  });

  it('useIsOnline tracks a single user and treats undefined as offline', async () => {
    usePresenceStore.getState().setUserOnline('u-1', true);
    const screen = await render(
      <>
        <Probe id="u-1" tid="p-online" />
        <Probe id="u-2" tid="p-offline" />
        <Probe tid="p-none" />
      </>,
    );
    await expect.element(screen.getByTestId('p-online')).toHaveTextContent('true');
    await expect.element(screen.getByTestId('p-offline')).toHaveTextContent('false');
    await expect.element(screen.getByTestId('p-none')).toHaveTextContent('false');
  });
});
