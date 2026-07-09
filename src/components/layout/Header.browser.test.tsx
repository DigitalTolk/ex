import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Header } from './Header';
import { expectPaintedAtCenter } from '@/test/browser-assertions';

const channel = {
  id: 'ch-1',
  name: 'general',
  slug: 'general',
  type: 'public' as const,
  createdBy: 'u-1',
  archived: false,
  createdAt: '2026-05-08T10:00:00.000Z',
  description: 'General discussion for the whole team',
};

describe('Header browser behavior', () => {
  // Kill CSS animations/transitions so base-ui dialog exits resolve
  // synchronously — without this, WebKit races the exit animation and the
  // dismissed dialog is still in the DOM (data-closed/data-ending-style)
  // when assertions poll for its removal. Same pattern as
  // ui/dialog.browser.test.tsx.
  let killAnims: HTMLStyleElement | null = null;
  beforeEach(() => {
    killAnims = document.createElement('style');
    killAnims.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
    document.head.appendChild(killAnims);
  });
  afterEach(() => {
    killAnims?.remove();
    killAnims = null;
  });

  it('hides channel descriptions on mobile and leaves a short channel name untruncated', async () => {
    if (window.innerWidth > 767) return;

    const screen = await render(
      <div style={{ width: 390 }}>
        <Header
          channel={channel}
          memberCount={8}
          onFilesClick={vi.fn()}
        />
      </div>,
    );

    const title = screen.getByRole('heading', { name: 'general' });
    await expect.element(title).toBeVisible();
    expect(document.body.textContent).not.toContain(channel.description);
    expect(title.element().scrollWidth).toBeLessThanOrEqual(title.element().clientWidth + 1);
    expectPaintedAtCenter(title.element());
    expectPaintedAtCenter(screen.getByLabelText('View shared files').element());
  });

  it('keeps the desktop channel description on the same row as the channel name', async () => {
    if (window.innerWidth <= 767) return;

    const screen = await render(
      <div style={{ width: 960 }}>
        <Header
          channel={channel}
          memberCount={8}
          onFilesClick={vi.fn()}
          onPinnedClick={vi.fn()}
        />
      </div>,
    );

    const title = screen.getByRole('heading', { name: 'general' });
    const description = screen.getByText(channel.description);
    const files = screen.getByLabelText('View shared files');

    await expect.element(description).toBeVisible();

    const titleRect = title.element().getBoundingClientRect();
    const descriptionRect = description.element().getBoundingClientRect();
    const filesRect = files.element().getBoundingClientRect();
    const titleMidY = titleRect.top + titleRect.height / 2;
    const descriptionMidY = descriptionRect.top + descriptionRect.height / 2;

    expect(descriptionRect.left).toBeGreaterThan(titleRect.right - 1);
    expect(descriptionRect.right).toBeLessThan(filesRect.left - 8);
    expect(Math.abs(descriptionMidY - titleMidY)).toBeLessThanOrEqual(4);
    expectPaintedAtCenter(description.element());
    expectPaintedAtCenter(files.element());
  });

  it('renders a DM header subtitle and avatar (non-hover-card path)', async () => {
    const screen = await render(
      <Header title="Alice" subtitle="Active now" showAvatar avatarOnline />,
    );
    await expect.element(screen.getByText('Alice')).toBeVisible();
    await expect.element(screen.getByText('Active now')).toBeVisible();
  });

  it('renders a DM header via the hover-card path with a status indicator (userId set)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <Header
            title="Bob"
            userId="u-bob"
            currentUserId="u-me"
            subtitle="In a meeting"
            userStatus={{ emoji: '📅', text: 'In a meeting' }}
            showAvatar
            avatarURL="https://x/bob.png"
            avatarOnline
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await expect.element(screen.getByRole('heading', { name: 'Bob' })).toBeVisible();
    await expect.element(screen.getByText('In a meeting').first()).toBeVisible();
  });

  it('edits the channel description from the desktop dropdown and saves on Enter', async () => {
    if (window.innerWidth <= 767) return;
    const onDescriptionSave = vi.fn();
    const screen = await render(
      <div style={{ width: 960 }}>
        <Header channel={channel} memberCount={3} canEdit onDescriptionSave={onDescriptionSave} />
      </div>,
    );
    await screen.getByRole('button', { name: /general/ }).click();
    await screen.getByText('Edit description').click();
    const input = screen.getByPlaceholder('Add a description...');
    await expect.element(input).toBeVisible();
    await input.fill('Updated topic');
    input.element().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(onDescriptionSave).toHaveBeenCalledWith('Updated topic'));
  });

  it('cancels the desktop inline description edit on Escape', async () => {
    if (window.innerWidth <= 767) return;
    const onDescriptionSave = vi.fn();
    const screen = await render(
      <div style={{ width: 960 }}>
        <Header channel={channel} memberCount={3} canEdit onDescriptionSave={onDescriptionSave} />
      </div>,
    );
    // Clicking the existing description text enters edit mode directly.
    await screen.getByText(channel.description).click();
    const input = screen.getByPlaceholder('Add a description...');
    await expect.element(input).toBeVisible();
    input.element().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector('input[placeholder="Add a description..."]')).toBeNull();
    });
    expect(onDescriptionSave).not.toHaveBeenCalled();
  });

  it('toggles mute (unmute label) via the desktop dropdown', async () => {
    if (window.innerWidth <= 767) return;
    const onToggleMute = vi.fn();
    const screen = await render(
      <div style={{ width: 960 }}>
        <Header channel={channel} memberCount={3} muted onToggleMute={onToggleMute} canLeave onLeave={vi.fn()} />
      </div>,
    );
    await screen.getByRole('button', { name: /general/ }).click();
    // muted=true → the item reads "Unmute channel". Leave is also present.
    await expect.element(screen.getByRole('menuitem', { name: 'Leave channel' })).toBeVisible();
    await screen.getByRole('menuitem', { name: 'Unmute channel' }).click();
    expect(onToggleMute).toHaveBeenCalledTimes(1);
  });

  it('archives via the desktop dropdown through the confirmation dialog', async () => {
    if (window.innerWidth <= 767) return;
    const onArchive = vi.fn();
    const screen = await render(
      <div style={{ width: 960 }}>
        <Header channel={channel} memberCount={3} canArchive onArchive={onArchive} />
      </div>,
    );
    await screen.getByRole('button', { name: /general/ }).click();
    // Exact menuitem role avoids the substring clash with the "Archive
    // channel?" dialog title.
    await screen.getByRole('menuitem', { name: 'Archive channel' }).click();
    await expect.element(screen.getByText('Archive channel?')).toBeVisible();
    await screen.getByRole('button', { name: 'Archive' }).click();
    await vi.waitFor(() => expect(onArchive).toHaveBeenCalledTimes(1));
  });

  it('opens notification preferences via the desktop dropdown', async () => {
    if (window.innerWidth <= 767) return;
    const onNotificationPrefsClick = vi.fn();
    const screen = await render(
      <div style={{ width: 960 }}>
        <Header channel={channel} memberCount={3} onNotificationPrefsClick={onNotificationPrefsClick} />
      </div>,
    );
    await screen.getByRole('button', { name: /general/ }).click();
    await screen.getByRole('menuitem', { name: 'Notification preferences' }).click();
    expect(onNotificationPrefsClick).toHaveBeenCalledTimes(1);
  });

  it('opens notification preferences via the mobile channel menu', async () => {
    if (window.innerWidth > 767) return;
    const onNotificationPrefsClick = vi.fn();
    const screen = await render(
      <div style={{ width: 390 }}>
        <Header channel={channel} memberCount={3} onNotificationPrefsClick={onNotificationPrefsClick} />
      </div>,
    );
    await screen.getByRole('button', { name: /general/ }).click();
    const menu = document.querySelector('[data-testid="mobile-channel-menu"]') as HTMLElement;
    (Array.from(menu.querySelectorAll('button')).find((b) => b.textContent?.includes('Notification preferences')) as HTMLButtonElement).click();
    expect(onNotificationPrefsClick).toHaveBeenCalledTimes(1);
  });

  // Open the mobile channel menu once and return its container. A single
  // open per test keeps the Radix trigger state from desyncing on WebKit
  // (repeated open/close cycles in one test can hang).
  async function openMobileMenu(screen: Awaited<ReturnType<typeof render>>) {
    await screen.getByRole('button', { name: /general/ }).click();
    let menu: HTMLElement | null = null;
    await vi.waitFor(() => {
      menu = document.querySelector('[data-testid="mobile-channel-menu"]');
      expect(menu).not.toBeNull();
    });
    return menu as unknown as HTMLElement;
  }

  it('fires mute from the mobile channel menu', async () => {
    if (window.innerWidth > 767) return;
    const onToggleMute = vi.fn();
    const screen = await render(
      <div style={{ width: 390 }}>
        <Header channel={channel} memberCount={3} muted={false} onToggleMute={onToggleMute} />
      </div>,
    );
    const menu = await openMobileMenu(screen);
    (menu.querySelector('[aria-label="Mute channel"]') as HTMLButtonElement).click();
    expect(onToggleMute).toHaveBeenCalledTimes(1);
  });

  it('fires leave from the mobile channel menu', async () => {
    if (window.innerWidth > 767) return;
    const onLeave = vi.fn();
    const screen = await render(
      <div style={{ width: 390 }}>
        <Header channel={channel} memberCount={3} canLeave onLeave={onLeave} />
      </div>,
    );
    const menu = await openMobileMenu(screen);
    (Array.from(menu.querySelectorAll('button')).find((b) => b.textContent?.includes('Leave channel')) as HTMLButtonElement).click();
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('opens the archive confirmation from the mobile channel menu', async () => {
    if (window.innerWidth > 767) return;
    const screen = await render(
      <div style={{ width: 390 }}>
        <Header channel={channel} memberCount={3} canArchive onArchive={vi.fn()} />
      </div>,
    );
    const menu = await openMobileMenu(screen);
    (Array.from(menu.querySelectorAll('button')).find((b) => b.textContent?.includes('Archive channel')) as HTMLButtonElement).click();
    await expect.element(screen.getByText('Archive channel?')).toBeVisible();
  });

  it('edits the channel description from the mobile menu via the dialog editor', async () => {
    if (window.innerWidth > 767) return;
    const onDescriptionSave = vi.fn();
    const screen = await render(
      <div style={{ width: 390 }}>
        <Header channel={channel} memberCount={3} canEdit onDescriptionSave={onDescriptionSave} />
      </div>,
    );
    await screen.getByRole('button', { name: /general/ }).click();
    const menu = document.querySelector('[data-testid="mobile-channel-menu"]') as HTMLElement;
    (Array.from(menu.querySelectorAll('button')).find((b) => b.textContent?.includes('Edit description')) as HTMLButtonElement).click();
    // The mobile editor dialog opens with a textarea + Save.
    await expect.element(screen.getByTestId('mobile-description-editor')).toBeVisible();
    const textarea = document.querySelector('#mobile-channel-description') as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    await screen.getByRole('button', { name: 'Save' }).click();
    await vi.waitFor(() => expect(onDescriptionSave).toHaveBeenCalled());
  });

  it('mobile description editor: typing updates the draft and Save persists the edited text', async () => {
    if (window.innerWidth > 767) return;
    const onDescriptionSave = vi.fn();
    const screen = await render(
      <div style={{ width: 390 }}>
        <Header channel={channel} memberCount={3} canEdit onDescriptionSave={onDescriptionSave} />
      </div>,
    );
    await screen.getByRole('button', { name: /general/ }).click();
    const menu = document.querySelector('[data-testid="mobile-channel-menu"]') as HTMLElement;
    (Array.from(menu.querySelectorAll('button')).find((b) => b.textContent?.includes('Edit description')) as HTMLButtonElement).click();
    await expect.element(screen.getByTestId('mobile-description-editor')).toBeVisible();
    await screen.getByRole('textbox', { name: 'Description' }).fill('rewritten on mobile');
    await screen.getByRole('button', { name: 'Save' }).click();
    await vi.waitFor(() => expect(onDescriptionSave).toHaveBeenCalledWith('rewritten on mobile'));
  });

  it('mobile description editor: Cancel dismisses the dialog without saving', async () => {
    if (window.innerWidth > 767) return;
    const onDescriptionSave = vi.fn();
    const screen = await render(
      <div style={{ width: 390 }}>
        <Header channel={channel} memberCount={3} canEdit onDescriptionSave={onDescriptionSave} />
      </div>,
    );
    await screen.getByRole('button', { name: /general/ }).click();
    const menu = document.querySelector('[data-testid="mobile-channel-menu"]') as HTMLElement;
    (Array.from(menu.querySelectorAll('button')).find((b) => b.textContent?.includes('Edit description')) as HTMLButtonElement).click();
    await expect.element(screen.getByTestId('mobile-description-editor')).toBeVisible();
    // The header Cancel dismisses via the dialog's onOpenChange(false) →
    // cancelDescriptionEdit; nothing is saved.
    await screen.getByRole('button', { name: 'Cancel' }).click();
    // Dismissed = removed from the DOM, or mid-exit (`data-closed`, which
    // base-ui stamps synchronously on close). Asserting removal alone races
    // React's unmount commit under full-suite CPU load even with animations
    // disabled — the closed STATE is the user-visible contract.
    await vi.waitFor(() => {
      const el = document.querySelector('[data-testid="mobile-description-editor"]');
      expect(el === null || el.hasAttribute('data-closed')).toBe(true);
    }, { timeout: 10000 });
    expect(onDescriptionSave).not.toHaveBeenCalled();
  });
});
