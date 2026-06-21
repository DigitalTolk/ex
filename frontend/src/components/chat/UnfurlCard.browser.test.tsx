import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';

const useUnfurlMock = vi.hoisted(() => vi.fn());
const dismissMutate = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useUnfurl', () => ({
  useUnfurl: (url: string) => useUnfurlMock(url),
}));

vi.mock('@/hooks/useMessages', () => ({
  useSetNoUnfurl: () => ({ mutate: dismissMutate, isPending: false }),
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojiMap: () => ({ data: {} }),
}));

import { UnfurlCard } from './UnfurlCard';

describe('UnfurlCard browser behaviour', () => {
  it('renders nothing while the preview is loading', async () => {
    useUnfurlMock.mockReturnValue({ data: undefined, isLoading: true });
    await render(<UnfurlCard url="https://example.org" messageId="m-1" isAuthor={false} />);
    expect(document.querySelector('[data-testid="unfurl-card"]')).toBeNull();
  });

  it('renders nothing when the preview has no title, description, or image', async () => {
    useUnfurlMock.mockReturnValue({ data: { url: 'https://example.org' }, isLoading: false });
    await render(<UnfurlCard url="https://example.org" messageId="m-1" isAuthor={false} />);
    expect(document.querySelector('[data-testid="unfurl-card"]')).toBeNull();
  });

  it('renders the preview title, description, and image when populated', async () => {
    useUnfurlMock.mockReturnValue({
      data: {
        url: 'https://example.org/page',
        title: 'Example title',
        description: 'A short description.',
        image: 'https://example.org/og.png',
        siteName: 'Example',
      },
      isLoading: false,
    });
    const screen = await render(<UnfurlCard url="https://example.org" messageId="m-1" isAuthor={false} />);
    await expect.element(screen.getByText('Example title')).toBeVisible();
    await expect.element(screen.getByText('A short description.')).toBeVisible();
    const img = document.querySelector('[data-testid="unfurl-card-image"]') as HTMLImageElement;
    expect(img.src).toContain('og.png');
    expect(img.width).toBe(64);
    expect(img.height).toBe(64);
  });

  it('shows the dismiss button only when the viewer is the author', async () => {
    useUnfurlMock.mockReturnValue({
      data: { url: 'https://example.org', title: 'X' },
      isLoading: false,
    });
    await render(<UnfurlCard url="https://example.org" messageId="m-1" isAuthor={true} />);
    const btn = document.querySelector('[data-testid="unfurl-card-dismiss"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    btn.click();
    expect(dismissMutate).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'm-1', noUnfurl: true }),
    );
  });

  it('does not render the dismiss button when the viewer is not the author', async () => {
    useUnfurlMock.mockReturnValue({
      data: { url: 'https://example.org', title: 'X' },
      isLoading: false,
    });
    await render(<UnfurlCard url="https://example.org" messageId="m-1" isAuthor={false} />);
    expect(document.querySelector('[data-testid="unfurl-card-dismiss"]')).toBeNull();
  });

  it('renders the internal message-link card (avatar, author, body, image, channel)', async () => {
    useUnfurlMock.mockReturnValue({
      data: {
        url: 'https://ex.test/channel/incidents#msg-1',
        kind: 'message',
        siteName: 'ex.test',
        authorName: 'Günter Grodotzki',
        authorAvatarURL: 'https://img/g.png',
        channelLabel: '~Incidents',
        body: 'please do proper RCA',
        createdAt: '2026-06-15T10:00:00Z',
        image: 'https://img/chart.png',
      },
      isLoading: false,
    });
    const screen = await render(<UnfurlCard url="https://ex.test/channel/incidents#msg-1" messageId="m-1" isAuthor={false} />);
    await expect.element(screen.getByText('Günter Grodotzki')).toBeVisible();
    await expect.element(screen.getByText('please do proper RCA')).toBeVisible();
    await expect.element(screen.getByText('Only visible to users in ~Incidents')).toBeVisible();
    expect(document.querySelector('[data-testid="unfurl-message-avatar"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="unfurl-card-image"]')).not.toBeNull();
  });

  it('renders file-type icon rows for non-image attachments (no paperclip emoji)', async () => {
    useUnfurlMock.mockReturnValue({
      data: {
        url: 'https://ex.test/channel/incidents#msg-att',
        kind: 'message',
        siteName: 'ex.test',
        authorName: 'Günter Grodotzki',
        channelLabel: '~Incidents',
        // No body/image — the card stands on the attachment rows alone,
        // exercising hasContent()'s attachments branch too. One entry has
        // no contentType to cover the `?? ''` icon fallback.
        attachments: [
          { filename: 'report.pdf', contentType: 'application/pdf' },
          { filename: 'notes.txt' },
        ],
      },
      isLoading: false,
    });
    const screen = await render(<UnfurlCard url="https://ex.test/channel/incidents#msg-att" messageId="m-att" isAuthor={false} />);
    await expect.element(screen.getByTestId('unfurl-card-attachments')).toBeVisible();
    await expect.element(screen.getByText('report.pdf')).toBeVisible();
    await expect.element(screen.getByText('notes.txt')).toBeVisible();
    expect(document.body.textContent).not.toContain('📎');
  });

  it('renders the message card with an initials fallback and no image/body', async () => {
    useUnfurlMock.mockReturnValue({
      data: {
        url: 'https://ex.test/channel/incidents#msg-2',
        kind: 'message',
        siteName: 'ex.test',
        channelLabel: '~Incidents',
        image: 'https://img/only.png',
      },
      isLoading: false,
    });
    const screen = await render(<UnfurlCard url="https://ex.test/channel/incidents#msg-2" messageId="m-2" isAuthor={false} />);
    await expect.element(screen.getByText('Unknown')).toBeVisible();
    expect(document.querySelector('[data-testid="unfurl-message-avatar"]')).toBeNull();
  });

  it('replaces a broken image with the placeholder slot', async () => {
    useUnfurlMock.mockReturnValue({
      data: { url: 'https://example.org', title: 'X', image: 'https://example.org/missing.png' },
      isLoading: false,
    });
    const screen = await render(<UnfurlCard url="https://example.org" messageId="m-1" isAuthor={false} />);
    const img = document.querySelector('[data-testid="unfurl-card-image"]') as HTMLImageElement;
    img.dispatchEvent(new Event('error'));
    await expect.element(screen.getByTestId('unfurl-card-image-placeholder')).toBeInTheDocument();
  });

  // The left accent bar is bold near-black in light. In dark, primary is
  // white — a 4px white bar reads as a glaring stripe that doesn't match
  // the design's restrained dark unfurl card — so it's toned to the
  // subtle border-strong grey (#A7A5A6), never pure white.
  function leftBarRGB(): [number, number, number] {
    const link = document.querySelector('[data-testid="unfurl-card"] a') as HTMLElement;
    const m = getComputedStyle(link).borderLeftColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)!;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }

  it('paints the left bar near-black in light mode', async () => {
    document.documentElement.classList.remove('dark');
    useUnfurlMock.mockReturnValue({ data: { url: 'https://example.org', title: 'X' }, isLoading: false });
    await render(<UnfurlCard url="https://example.org" messageId="m-1" isAuthor={false} />);
    const [r, g, b] = leftBarRGB();
    expect(r).toBeLessThan(60);
    expect(g).toBeLessThan(60);
    expect(b).toBeLessThan(60);
  });

  it('tones the left bar to a subtle grey in dark mode (not glaring white)', async () => {
    document.documentElement.classList.add('dark');
    try {
      useUnfurlMock.mockReturnValue({ data: { url: 'https://example.org', title: 'X' }, isLoading: false });
      await render(<UnfurlCard url="https://example.org" messageId="m-1" isAuthor={false} />);
      const [r, g, b] = leftBarRGB();
      // border-strong #A7A5A6 ≈ rgb(167,165,166): a mid grey, well below
      // pure white on every channel.
      expect(r).toBeLessThan(210);
      expect(g).toBeLessThan(210);
      expect(b).toBeLessThan(210);
      expect(r).toBeGreaterThan(120);
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });
});
