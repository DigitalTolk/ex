import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemberList } from './MemberList';
import { apiFetch } from '@/lib/api';
import { MEMBER_LIST_WIDTH, PANEL_WIDTHS_RESET_EVENT } from '@/lib/panel-width';
import type { ChannelMembership } from '@/types';

vi.mock('@/lib/api', async (importOriginal) => ({
  // Strict-ESM: the graph also imports ApiError etc. from this module.
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(async () => undefined),
}));

// Regression pin for "cannot remove members anymore": the remove X must be
// VISIBLE at rest on desktop (muted, emphasized on row hover) and
// always-visible on touch. The old tests clicked the button through its a11y
// role, which works even at opacity 0 — so they could never catch an
// invisible affordance. Drive a REAL pointer hover and assert computed
// visibility, then click through to the DELETE.

function makeMember(over: Partial<ChannelMembership> = {}): ChannelMembership {
  return { channelID: 'ch-1', userID: 'u-2', displayName: 'Bob', role: 1, ...over } as ChannelMembership;
}

let active: { unmount: () => Promise<void> } | null = null;
afterEach(async () => {
  if (active) await active.unmount();
  active = null;
  vi.mocked(apiFetch).mockClear();
});
beforeEach(() => {
  localStorage.clear();
});

async function renderList(channelSlug?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = await render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <MemberList
          members={[makeMember({ userID: 'admin-1', displayName: 'Admin', role: 4 }), makeMember()]}
          channelId="ch-1"
          channelSlug={channelSlug}
          currentUserId="admin-1"
          currentUserRole={4}
        />
      </BrowserRouter>
    </QueryClientProvider>,
  );
  active = result;
  return result;
}

describe('MemberList remove (real hover)', () => {
  it('desktop: the X is visible at rest, emphasized on hover, and clicking issues the DELETE', async () => {
    if (window.innerWidth < 768) return;
    const screen = await renderList();
    const removeBtn = document.querySelector('[aria-label="Remove Bob"]') as HTMLElement;
    expect(removeBtn).not.toBeNull();
    // Discoverable without hovering (muted)…
    expect(Number(getComputedStyle(removeBtn).opacity)).toBeGreaterThanOrEqual(0.6);
    // …and full-strength once the row is hovered.
    await screen.getByText('Bob').hover();
    await expect.poll(() => getComputedStyle(removeBtn).opacity).toBe('1');
    // …and clickable.
    removeBtn.click();
    await expect
      .poll(() =>
        vi
          .mocked(apiFetch)
          .mock.calls.some(
            (c) => String(c[0]) === '/api/v1/channels/ch-1/members/u-2' && (c[1] as { method?: string })?.method === 'DELETE',
          ),
      )
      .toBe(true);
  });

  it('touch: the X is always visible and tappable', async () => {
    if (window.innerWidth >= 768) return;
    await renderList();
    const removeBtn = document.querySelector('[aria-label="Remove Bob"]') as HTMLElement;
    expect(removeBtn).not.toBeNull();
    expect(getComputedStyle(removeBtn).opacity).toBe('1');
    removeBtn.click();
    await expect
      .poll(() => vi.mocked(apiFetch).mock.calls.some((c) => (c[1] as { method?: string })?.method === 'DELETE'))
      .toBe(true);
  });

  it('~general never renders remove buttons — the backend rejects removal there', async () => {
    await renderList('general');
    expect(document.querySelector('[data-testid="member-list-scroll-area"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Remove Bob"]')).toBeNull();
  });

  it('a failed DELETE surfaces its error instead of silently doing nothing', async () => {
    const screen = await renderList();
    vi.mocked(apiFetch)
      .mockRejectedValueOnce(new Error('cannot remove members from the general channel'))
      // Non-Error rejection exercises the fallback copy.
      .mockRejectedValueOnce('nope');
    const removeBtn = document.querySelector('[aria-label="Remove Bob"]') as HTMLElement;

    removeBtn.click();
    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent('cannot remove members from the general channel');

    removeBtn.click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('Failed to remove member');
  });
});

describe('MemberList resize (desktop)', () => {
  function pointer(type: string, clientX: number) {
    return new PointerEvent(type, { bubbles: true, clientX, pointerId: 1, button: 0 });
  }
  function panelRect() {
    return document.querySelector('[data-mobile-right-sidebar]')!.getBoundingClientRect();
  }

  it('starts at the default width, drags wider from its left edge, persists, and resets on the global event', async () => {
    if (window.innerWidth < 768) return; // desktop rail only — mobile is a full-width sheet
    await renderList();
    expect(panelRect().width).toBe(MEMBER_LIST_WIDTH.defaultWidth);

    const handle = document.querySelector('[data-testid="member-list-resize-handle"]') as HTMLElement;
    expect(handle).not.toBeNull();
    // Left-edge handle: leftwards pointer = wider panel.
    handle.dispatchEvent(pointer('pointerdown', 800));
    handle.dispatchEvent(pointer('pointermove', 740));
    handle.dispatchEvent(pointer('pointerup', 740));
    await expect.poll(() => panelRect().width).toBe(MEMBER_LIST_WIDTH.defaultWidth + 60);
    expect(localStorage.getItem(MEMBER_LIST_WIDTH.key)).toBe(String(MEMBER_LIST_WIDTH.defaultWidth + 60));

    // Profile-settings reset snaps the live panel back.
    window.dispatchEvent(new Event(PANEL_WIDTHS_RESET_EVENT));
    await expect.poll(() => panelRect().width).toBe(MEMBER_LIST_WIDTH.defaultWidth);
  });
});
