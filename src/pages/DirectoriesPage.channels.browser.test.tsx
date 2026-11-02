import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DirectoriesPage from './DirectoriesPage';

// A workspace can have thousands of public channels: the directory mounts
// only the rows near the screen, so opening it and typing in its search stay
// quick on a phone.

const COUNT = 400;
vi.mock('@/lib/api', () => ({
  apiFetch: (url: string) =>
    Promise.resolve(
      url === '/api/v1/channels/browse'
        ? Array.from({ length: 400 }, (_, i) => ({ id: `ch-${i}`, name: `chan-${i}`, slug: `chan-${i}`, type: 'public' }))
        : [],
    ),
}));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'me', systemRole: 'member', status: 'active' } }),
}));

async function renderChannels() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/directory/channels']}>
        {/* The page's own scroller fills a fixed-height column, as in the app. */}
        <div style={{ height: 600, display: 'flex', flexDirection: 'column' }}>
          <Routes>
            <Route path="/directory/:section" element={<DirectoriesPage />} />
          </Routes>
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const rows = () => [...document.querySelectorAll('p')].filter((p) => /^chan-\d+$/.test(p.textContent ?? ''));
const row = (i: number) => rows().find((p) => p.textContent === `chan-${i}`)?.closest('.rounded-lg.border') ?? null;

describe('channel directory', () => {
  it('mounts only the rows near the screen, and the others as the page scrolls', async () => {
    await renderChannels();
    await expect.poll(() => rows().length).toBeGreaterThan(0);
    expect(rows().length).toBeLessThan(60);
    expect(row(COUNT - 1)).toBeNull();

    const scroller = document.querySelector<HTMLElement>('[data-page-scroll="true"]')!;
    await expect
      .poll(() => {
        scroller.scrollTop = scroller.scrollHeight;
        return row(COUNT - 1);
      })
      .not.toBeNull();
    expect(row(0)).toBeNull();
  });

  it('keeps its rows a gap apart', async () => {
    await renderChannels();
    await expect.poll(() => row(1)).not.toBeNull();
    expect(Math.round(row(1)!.getBoundingClientRect().top - row(0)!.getBoundingClientRect().bottom)).toBe(4);
  });
});
