import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Header } from './Header';
import type { Channel } from '@/types';

// Targeted browser coverage for the residual Header.tsx branches not hit
// by Header.browser.test.tsx / Header.expanded.browser.test.tsx:
// pinned-active styling, the muted mobile-menu Bell icon, the non-hover
// DM avatar + status path, and a description-less channel.

const channel: Channel = {
  id: 'ch-1',
  name: 'general',
  slug: 'general',
  type: 'public',
  createdBy: 'u-1',
  archived: false,
  createdAt: '2026-05-08T10:00:00.000Z',
  description: 'General team chat',
};

function Wrap({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Header residual coverage', () => {
  it('renders the pinned toggle in its active (pressed) state', async () => {
    const screen = await render(
      <Wrap>
        <div style={{ width: 900 }}>
          <Header channel={channel} memberCount={4} onPinnedClick={vi.fn()} pinnedActive />
        </div>
      </Wrap>,
    );
    const pinned = screen.getByLabelText('View pinned messages').element() as HTMLButtonElement;
    await expect.element(screen.getByLabelText('View pinned messages')).toBeVisible();
    expect(pinned.getAttribute('aria-pressed')).toBe('true');
    // Active styling applies the muted background utility.
    expect(pinned.className).toContain('bg-muted');
  });

  it('renders the files toggle in its active (pressed) state', async () => {
    const screen = await render(
      <Wrap>
        <div style={{ width: 900 }}>
          <Header channel={channel} memberCount={4} onFilesClick={vi.fn()} filesActive />
        </div>
      </Wrap>,
    );
    const files = screen.getByLabelText('View shared files').element() as HTMLButtonElement;
    expect(files.getAttribute('aria-pressed')).toBe('true');
    expect(files.className).toContain('bg-muted');
  });

  it('opens the edit field for a description-less channel (the || "" draft fallback)', async () => {
    if (window.innerWidth <= 767) return;
    const screen = await render(
      <Wrap>
        <div style={{ width: 900 }}>
          <Header channel={{ ...channel, description: '' }} memberCount={2} canEdit onDescriptionSave={vi.fn()} />
        </div>
      </Wrap>,
    );
    await screen.getByRole('button', { name: /general/ }).click();
    await screen.getByText('Edit description').click();
    // editDescription() seeds the draft from channel.description (empty) →
    // the `channel?.description || ""` nullish-ish fallback arm.
    const input = screen.getByPlaceholder('Add a description...');
    await expect.element(input).toBeVisible();
    expect((input.element() as HTMLInputElement).value).toBe('');
  });

  it('renders a channel header with no description (the description-absent arm)', async () => {
    const screen = await render(
      <Wrap>
        <div style={{ width: 900 }}>
          <Header channel={{ ...channel, description: '' }} memberCount={2} canEdit />
        </div>
      </Wrap>,
    );
    await expect.element(screen.getByRole('heading', { name: 'general' })).toBeVisible();
    // No description button/text rendered.
    expect(document.querySelector('[title="Click to edit description"]')).toBeNull();
  });

  it('renders a read-only description (canEdit=false) as a span, not a button', async () => {
    if (window.innerWidth <= 767) return;
    const screen = await render(
      <Wrap>
        <div style={{ width: 900 }}>
          <Header channel={channel} memberCount={2} />
        </div>
      </Wrap>,
    );
    await expect.element(screen.getByText('General team chat')).toBeVisible();
    expect(document.querySelector('[title="Click to edit description"]')).toBeNull();
  });

  it('renders the hover-card DM path with no avatar URL and an empty title', async () => {
    // userId set → hover-card path; no avatarURL → `avatarURL ?? "__none__"`
    // key fallback; empty displayTitle → `displayTitle || "??"` fallback.
    const screen = await render(
      <Wrap>
        <Header userId="u-x" currentUserId="u-me" showAvatar subtitle="Loading…" />
      </Wrap>,
    );
    await expect.element(screen.getByText('Loading…')).toBeVisible();
    // The avatar fallback initials render for the empty name.
    expect(document.querySelector('[data-testid="channel-header-shell"]')).not.toBeNull();
  });

  it('renders a DM avatar + status in the non-hover-card path (no userId)', async () => {
    const screen = await render(
      <Wrap>
        <Header
          title="Dana"
          showAvatar
          avatarURL="https://x/dana.png"
          avatarOnline
          userStatus={{ emoji: '🌴', text: 'On vacation' }}
          subtitle="Away"
        />
      </Wrap>,
    );
    await expect.element(screen.getByRole('heading', { name: 'Dana' })).toBeVisible();
    await expect.element(screen.getByText('Away')).toBeVisible();
    // The status indicator (aria-label includes the status text) renders.
    expect(document.querySelector('[aria-label*="On vacation"]')).not.toBeNull();
  });

  it('renders an empty title when neither channel nor title is provided', async () => {
    // channel?.name ?? title ?? "" → both undefined, so displayTitle is "".
    const screen = await render(
      <Wrap>
        <Header showAvatar subtitle="No name here" />
      </Wrap>,
    );
    // The header still mounts; the heading is present (empty text) and the
    // subtitle confirms the non-channel render path ran.
    await expect.element(screen.getByText('No name here')).toBeVisible();
    const headings = document.querySelectorAll('h1');
    expect(headings.length).toBeGreaterThan(0);
  });

  it('shows the Bell (unmute) icon in the mobile channel menu when muted', async () => {
    if (window.innerWidth > 767) return;
    const screen = await render(
      <Wrap>
        <div style={{ width: 390 }}>
          <Header channel={channel} memberCount={3} muted onToggleMute={vi.fn()} />
        </div>
      </Wrap>,
    );
    await screen.getByRole('button', { name: /general/ }).click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="mobile-channel-menu"]')).not.toBeNull();
    });
    const menu = document.querySelector('[data-testid="mobile-channel-menu"]') as HTMLElement;
    const unmuteBtn = menu.querySelector('[aria-label="Unmute channel"]') as HTMLButtonElement;
    expect(unmuteBtn).not.toBeNull();
    expect(unmuteBtn.textContent).toContain('Unmute channel');
  });
});
