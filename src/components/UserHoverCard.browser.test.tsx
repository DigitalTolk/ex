import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UserHoverCard } from './UserHoverCard';

// Browser coverage for UserHoverCard — exercises trigger render,
// open-on-click (mobile) / hover (desktop), inline status display.

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue({
    id: 'u-1',
    displayName: 'Alice',
    avatarURL: undefined,
    status: 'active',
    userStatus: undefined,
  });
});

import { usePresenceStore } from '@/stores/presence';

// The hover card reads presence via the per-user store selector now —
// seed the real store instead of mocking the context.
usePresenceStore.setState({ online: new Set<string>(['u-2']) });

function Wrap({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>{children}</BrowserRouter>
    </QueryClientProvider>
  );
}

describe('UserHoverCard browser', () => {
  it('renders the trigger children only when closed', async () => {
    const screen = await render(
      <Wrap>
        <UserHoverCard userId="u-1" displayName="Alice">
          <span>Alice</span>
        </UserHoverCard>
      </Wrap>,
    );
    await expect.element(screen.getByText('Alice')).toBeVisible();
  });

  it('renders the trigger inside a clickable span', async () => {
    await render(
      <Wrap>
        <UserHoverCard userId="u-1" displayName="Alice">
          <span data-testid="user-trigger">Alice</span>
        </UserHoverCard>
      </Wrap>,
    );
    // The trigger span wraps the children; just confirm the structure.
    const wrapper = document.querySelector('[data-testid="user-trigger"]');
    expect(wrapper).not.toBeNull();
    // Trigger's parent is the UserHoverCard's wrapping <span>.
    expect(wrapper!.parentElement?.tagName).toBe('SPAN');
  });

  it('shows the inline status indicator when showInlineStatus and userStatus are set', async () => {
    await render(
      <Wrap>
        <UserHoverCard
          userId="u-1"
          displayName="Alice"
          userStatus={{ emoji: ':wave:', text: 'around', clearAt: '' }}
          showInlineStatus={true}
        >
          <span>Alice</span>
        </UserHoverCard>
      </Wrap>,
    );
    // The inline status component renders inside the trigger.
    const indicator = document.querySelector('[aria-label*="around"], [title*="around"]');
    expect(indicator).not.toBeNull();
  });

  it('respects online prop override', async () => {
    await render(
      <Wrap>
        <UserHoverCard userId="u-1" displayName="Alice" online={true}>
          <span data-testid="online-trigger">Alice</span>
        </UserHoverCard>
      </Wrap>,
    );
    const trigger = document.querySelector('[data-testid="online-trigger"]');
    expect(trigger).not.toBeNull();
  });

  it('renders the rich profile (email + timezone + inactive) when the card is opened', async () => {
    apiFetchMock.mockResolvedValue({
      id: 'u-1',
      displayName: 'Alice',
      email: 'alice@example.com',
      timeZone: 'Asia/Tokyo',
      status: 'inactive',
      userStatus: undefined,
    });
    await render(
      <Wrap>
        <UserHoverCard userId="u-1" displayName="Alice">
          <span data-testid="rich-trigger">Alice</span>
        </UserHoverCard>
      </Wrap>,
    );
    // Open the card (the wrapping span's onClick toggles it).
    (document.querySelector('[data-testid="rich-trigger"]') as HTMLElement).click();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('alice@example.com');
    });
    // The valid timezone surfaces its city name (Tokyo).
    expect(document.body.textContent).toMatch(/Tokyo/);
  });

  it('dismisses the open card with Escape (PopoverPortal onDismiss closes it)', async () => {
    apiFetchMock.mockResolvedValue({
      id: 'u-1',
      displayName: 'Alice',
      email: 'alice@example.com',
      status: 'active',
      userStatus: undefined,
    });
    await render(
      <Wrap>
        <UserHoverCard userId="u-1" displayName="Alice">
          <span data-testid="dismiss-trigger">Alice</span>
        </UserHoverCard>
      </Wrap>,
    );
    (document.querySelector('[data-testid="dismiss-trigger"]') as HTMLElement).click();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('alice@example.com');
    });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => {
      expect(document.body.textContent).not.toContain('alice@example.com');
    });
  });

  it('shows an Inactive badge when the fetched user is deactivated', async () => {
    apiFetchMock.mockResolvedValue({
      id: 'u-1',
      displayName: 'Alice',
      status: 'deactivated',
      userStatus: undefined,
    });
    await render(
      <Wrap>
        <UserHoverCard userId="u-1" displayName="Alice">
          <span data-testid="inactive-trigger">Alice</span>
        </UserHoverCard>
      </Wrap>,
    );
    (document.querySelector('[data-testid="inactive-trigger"]') as HTMLElement).click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="hover-status-inactive"]')).not.toBeNull();
    });
  });

  it('starts a DM via the "Direct message" button when viewing someone else', async () => {
    apiFetchMock.mockReset();
    // First call: the lazy /users fetch on open. Second: the DM create.
    apiFetchMock
      .mockResolvedValueOnce({ id: 'u-1', displayName: 'Alice', status: 'active' })
      .mockResolvedValueOnce({ id: 'conv-new', type: 'dm' });
    await render(
      <Wrap>
        <UserHoverCard userId="u-1" displayName="Alice" currentUserId="u-me">
          <span data-testid="dm-trigger">Alice</span>
        </UserHoverCard>
      </Wrap>,
    );
    (document.querySelector('[data-testid="dm-trigger"]') as HTMLElement).click();
    // The card is open (not self) → the Direct message button renders.
    await vi.waitFor(() => {
      expect(document.querySelector('button')).not.toBeNull();
    });
    const dmBtn = Array.from(document.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Direct message'),
    ) as HTMLButtonElement;
    expect(dmBtn).toBeDefined();
    dmBtn.click();
    // startDM.mutate → POST /conversations → onSuccess navigates.
    await vi.waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/v1/conversations',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });
});
