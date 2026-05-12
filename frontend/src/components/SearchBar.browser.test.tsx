import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SearchBar } from './SearchBar';

const useChannelBySlugMock = vi.hoisted(() => vi.fn(() => ({ data: undefined as unknown })));
const useUserConversationsMock = vi.hoisted(() => vi.fn(() => ({ data: undefined as unknown })));

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/hooks/useChannels', () => ({
  useChannelBySlug: (slug?: string) => useChannelBySlugMock(slug as never),
}));

vi.mock('@/hooks/useConversations', () => ({
  useUserConversations: () => useUserConversationsMock(),
}));

function renderSearchBar(initialPath = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <div data-app-chrome="true" style={{ background: 'var(--color-sidebar)', padding: 12 }}>
          <SearchBar />
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function colorToRGBA(color: string): [number, number, number, number] {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const { data } = ctx.getImageData(0, 0, 1, 1);
  return [data[0], data[1], data[2], data[3] / 255];
}

function effectiveBackground(el: HTMLElement): string {
  let node: HTMLElement | null = el;
  while (node) {
    const bg = getComputedStyle(node).backgroundColor;
    const [, , , a] = colorToRGBA(bg);
    if (a > 0) return bg;
    node = node.parentElement;
  }
  return 'rgb(255, 255, 255)';
}

function relativeLuminance(color: string) {
  const [r, g, b] = colorToRGBA(color).slice(0, 3).map((value) => {
    const srgb = value / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string) {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('SearchBar browser behavior', () => {
  it('keeps search input text readable inside light app chrome', async () => {
    useChannelBySlugMock.mockReturnValue({ data: undefined });
    useUserConversationsMock.mockReturnValue({ data: undefined });
    document.documentElement.classList.remove('dark');
    const screen = await renderSearchBar();

    const input = screen.getByTestId('searchbar-input').element();
    const shell = input.parentElement as HTMLElement;
    await expect.element(input).toBeVisible();

    const inputColor = getComputedStyle(input).color;
    const shellColor = effectiveBackground(shell);
    expect(contrastRatio(inputColor, shellColor)).toBeGreaterThanOrEqual(4.5);
  });

  it('opens the dropdown with the "Show results for" row when typing on a generic route', async () => {
    useChannelBySlugMock.mockReturnValue({ data: undefined });
    useUserConversationsMock.mockReturnValue({ data: undefined });
    const screen = await renderSearchBar('/');
    await screen.getByTestId('searchbar-input').fill('foo');
    await expect.element(screen.getByTestId('searchbar-dropdown')).toBeVisible();
    await expect.element(screen.getByTestId('searchbar-show-results')).toBeVisible();
    expect(document.querySelector('[data-testid="searchbar-show-in-scope"]')).toBeNull();
  });

  it('adds a channel-scoped row when the route is /channel/:slug and the channel resolves', async () => {
    useChannelBySlugMock.mockReturnValue({
      data: { id: 'ch-1', name: 'general', slug: 'general', type: 'public' },
    });
    useUserConversationsMock.mockReturnValue({ data: undefined });
    const screen = await renderSearchBar('/channel/general');
    await screen.getByTestId('searchbar-input').fill('bug');
    const scopeRow = await screen.getByTestId('searchbar-show-in-scope');
    await expect.element(scopeRow).toBeVisible();
    const el = scopeRow.element() as HTMLElement;
    expect(el.dataset.scopeKind).toBe('channel');
    expect(el.textContent).toContain('~general');
  });

  it('adds a DM-scoped row for a 1:1 conversation route', async () => {
    useChannelBySlugMock.mockReturnValue({ data: undefined });
    useUserConversationsMock.mockReturnValue({
      data: [{ conversationID: 'cv-1', type: 'dm', displayName: 'Bob' }],
    });
    const screen = await renderSearchBar('/conversation/cv-1');
    await screen.getByTestId('searchbar-input').fill('hey');
    const scopeRow = await screen.getByTestId('searchbar-show-in-scope');
    await expect.element(scopeRow).toBeVisible();
    expect((scopeRow.element() as HTMLElement).dataset.scopeKind).toBe('dm');
  });

  it('adds a group-scoped row for a group conversation route', async () => {
    useChannelBySlugMock.mockReturnValue({ data: undefined });
    useUserConversationsMock.mockReturnValue({
      data: [{ conversationID: 'cv-2', type: 'group', displayName: 'Eng huddle' }],
    });
    const screen = await renderSearchBar('/conversation/cv-2');
    await screen.getByTestId('searchbar-input').fill('roadmap');
    const scopeRow = await screen.getByTestId('searchbar-show-in-scope');
    await expect.element(scopeRow).toBeVisible();
    expect((scopeRow.element() as HTMLElement).dataset.scopeKind).toBe('group');
  });

  it('clear button empties the input', async () => {
    useChannelBySlugMock.mockReturnValue({ data: undefined });
    useUserConversationsMock.mockReturnValue({ data: undefined });
    const screen = await renderSearchBar();
    await screen.getByTestId('searchbar-input').fill('foo');
    const clear = await screen.getByLabelText('Clear search');
    await clear.click();
    const input = screen.getByTestId('searchbar-input').element() as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('Enter submits and clears the input', async () => {
    useChannelBySlugMock.mockReturnValue({ data: undefined });
    useUserConversationsMock.mockReturnValue({ data: undefined });
    const screen = await renderSearchBar();
    const input = screen.getByTestId('searchbar-input');
    await input.fill('foo');
    await input.element().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    // After submission, the input is cleared.
    await new Promise((r) => setTimeout(r, 50));
    expect((input.element() as HTMLInputElement).value).toBe('');
  });
});
