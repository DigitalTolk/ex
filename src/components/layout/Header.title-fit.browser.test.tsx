import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import type { Channel } from '@/types';
import { Header } from './Header';

// Every kind of chat header, on every screen size: a title that fits is
// shown whole, and one that doesn't is truncated inside the header, never
// pushing its buttons out. Two shipped bugs: a group's title lost its last
// letters ("Kaneez, Ta…") with the header empty — its menu trigger was sized
// 4px short of its own text — and a channel's name was squeezed to "in…" by
// a long description sharing its row.

const channel: Channel = {
  id: 'ch-1',
  name: 'general',
  slug: 'general',
  type: 'public',
  createdBy: 'u-1',
  archived: false,
  createdAt: '2026-05-08T10:00:00.000Z',
};
const longDescription = 'Internal announcements, release notes and everything the whole company should read first';

const asChannel = (name: string, extra: Partial<Channel> = {}): Channel => ({ ...channel, name, slug: name, ...extra });

// Each kind renders a header around a given title. Channel names are slugs,
// people's names are not.
const kinds: { name: string; slug: boolean; render: (title: string) => ReactElement }[] = [
  { name: 'a public channel', slug: true, render: (t) => <Header channel={asChannel(t)} memberCount={4} onFilesClick={vi.fn()} /> },
  {
    name: 'a public channel with a long description',
    slug: true,
    render: (t) => <Header channel={asChannel(t, { description: longDescription })} memberCount={4} onFilesClick={vi.fn()} onPinnedClick={vi.fn()} />,
  },
  { name: 'a private channel', slug: true, render: (t) => <Header channel={asChannel(t, { type: 'private' })} memberCount={4} onFilesClick={vi.fn()} /> },
  {
    name: 'a private channel with a long description',
    slug: true,
    render: (t) => <Header channel={asChannel(t, { type: 'private', description: longDescription })} memberCount={4} onFilesClick={vi.fn()} />,
  },
  { name: 'an archived channel', slug: true, render: (t) => <Header channel={asChannel(t, { archived: true })} memberCount={4} onFilesClick={vi.fn()} /> },
  { name: 'a channel still loading', slug: true, render: (t) => <Header loadingChannel={{ name: t, type: 'private' }} /> },
  {
    name: 'a group with its convert menu',
    slug: false,
    render: (t) => <Header title={t} memberCount={3} onMembersClick={vi.fn()} onFilesClick={vi.fn()} onConvertToChannel={vi.fn()} />,
  },
  { name: 'a group without the menu', slug: false, render: (t) => <Header title={t} memberCount={3} onMembersClick={vi.fn()} /> },
  { name: 'a DM', slug: false, render: (t) => <Header title={t} userId="u-k" currentUserId="u-me" showAvatar onFilesClick={vi.fn()} /> },
  {
    name: 'a DM with a status and an inactive account',
    slug: false,
    render: (t) => (
      <Header title={t} userId="u-k" currentUserId="u-me" showAvatar userStatus={{ emoji: ':palm_tree:', text: 'On leave' }} inactive onFilesClick={vi.fn()} />
    ),
  },
  { name: 'a DM without a profile card', slug: false, render: (t) => <Header title={t} subtitle="Active now" showAvatar onFilesClick={vi.fn()} /> },
];

function inApp(ui: ReactElement, width: number) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <div style={{ width }}>{ui}</div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function heading(): HTMLElement {
  return document.querySelector<HTMLElement>('h1')!;
}

const width = () => Math.min(window.innerWidth, 900);

describe('chat header title', () => {
  for (const kind of kinds) {
    it(`shows ${kind.name} whole when it fits`, async () => {
      await inApp(kind.render(kind.slug ? 'kaneez-tahir' : 'Kaneez, Tahir'), width());
      await expect.element(heading()).toBeVisible();
      expect(heading().scrollWidth).toBeLessThanOrEqual(heading().clientWidth);
    });

    it(`truncates ${kind.name} that doesn't fit, inside the header`, async () => {
      const words = Array.from({ length: 40 }, (_, i) => `name${i}`);
      await inApp(kind.render(kind.slug ? words.join('-') : words.join(', ')), width());
      await expect.element(heading()).toBeVisible();
      expect(heading().scrollWidth).toBeGreaterThan(heading().clientWidth);
      const header = document.querySelector('header')!.getBoundingClientRect();
      expect(heading().getBoundingClientRect().right).toBeLessThanOrEqual(header.right + 1);
      for (const button of document.querySelectorAll('header button')) {
        expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(header.right + 1);
      }
      // What sits beside the name stays whole and in view.
      const badge = document.querySelector('[data-testid="header-status-inactive"]');
      if (badge) {
        const box = badge.getBoundingClientRect();
        expect(box.width).toBeGreaterThan(0);
        expect(box.right).toBeLessThanOrEqual(header.right + 1);
      }
    });
  }

  // The description shares the row: it gets what the name leaves, never
  // the other way round.
  it('gives a long description only what the channel name leaves', async () => {
    if (window.innerWidth <= 767) return; // phones hide the description
    await inApp(<Header channel={asChannel('internal', { description: longDescription })} memberCount={4} onFilesClick={vi.fn()} />, 700);
    await expect.element(heading()).toBeVisible();
    expect(heading().scrollWidth).toBeLessThanOrEqual(heading().clientWidth);
    const desc = [...document.querySelectorAll<HTMLElement>('header span, header button')].find((el) => el.textContent === longDescription)!;
    expect(desc.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(desc.scrollWidth).toBeGreaterThan(desc.clientWidth);
    expect(desc.getBoundingClientRect().left).toBeGreaterThanOrEqual(heading().getBoundingClientRect().right);
  });
});
