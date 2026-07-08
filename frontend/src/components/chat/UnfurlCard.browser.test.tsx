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
        channelLabel: '~Incidents',
        // No author/body/image — the card stands on the attachment rows
        // ALONE, so hasContent() reaches its final attachments arm. One entry
        // has no contentType to cover the `?? ''` icon fallback.
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

  it('sizes a shared image to the same scaled dimensions as the original message', async () => {
    useUnfurlMock.mockReturnValue({
      data: {
        url: 'https://ex.test/channel/incidents#msg-img',
        kind: 'message',
        siteName: 'ex.test',
        authorName: 'Günter Grodotzki',
        // 1920×1080 → min(1, 320/1920, 288/1080) = 0.1667 → 320×180.
        image: 'https://img/big.png',
        imageWidth: 1920,
        imageHeight: 1080,
      },
      isLoading: false,
    });
    const screen = await render(<UnfurlCard url="https://ex.test/channel/incidents#msg-img" messageId="m-img" isAuthor={false} />);
    const img = (screen.getByTestId('unfurl-card-image').element() as HTMLImageElement);
    expect(img.getAttribute('width')).toBe('320');
    expect(img.getAttribute('height')).toBe('180');
  });

  it('drops an unsafe message-card href and unsafe image src', async () => {
    useUnfurlMock.mockReturnValue({
      data: {
        url: 'javascript:alert(1)',
        kind: 'message',
        siteName: 'ex.test',
        authorName: 'Günter Grodotzki',
        image: 'javascript:alert(1)',
        imageWidth: 1920,
        imageHeight: 1080,
      },
      isLoading: false,
    });
    const screen = await render(<UnfurlCard url="https://ex.test/channel/incidents#msg-x" messageId="m-x" isAuthor={false} />);
    // Card renders (author is shown) but the stretched link has no href and
    // the javascript: image is never mounted.
    await expect.element(screen.getByText('Günter Grodotzki')).toBeVisible();
    expect(document.querySelector('[data-testid="unfurl-message-card"]')?.getAttribute('href')).toBeNull();
    expect(document.querySelector('[data-testid="unfurl-card-image"]')).toBeNull();
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

  // Per the design spec the web (OpenGraph) card is bg/base with a UNIFORM
  // subtle border — no coloured left accent. Lock both: the four borders
  // share one colour, and the fill is the base background.
  function cardStyle(screen: Awaited<ReturnType<typeof render>>) {
    const card = screen.getByTestId('unfurl-card').element() as HTMLElement;
    return getComputedStyle(card.querySelector('a') as HTMLElement);
  }

  it('uses a uniform subtle border (no coloured left accent) on the web card', async () => {
    document.documentElement.classList.remove('dark');
    useUnfurlMock.mockReturnValue({ data: { url: 'https://example.org', title: 'X' }, isLoading: false });
    const screen = await render(<UnfurlCard url="https://example.org" messageId="m-1" isAuthor={false} />);
    const s = cardStyle(screen);
    // Subtle border #E9E9E9 ≈ rgb(233,233,233) on ALL sides (no dark left bar).
    expect(s.borderLeftColor).toBe(s.borderTopColor);
    const [r, g, b] = s.borderTopColor.match(/\d+/g)!.map(Number);
    expect(r).toBeGreaterThan(210);
    expect(g).toBeGreaterThan(210);
    expect(b).toBeGreaterThan(210);
  });

  it('fills the web card with the base background in light mode (#FFFFFF)', async () => {
    document.documentElement.classList.remove('dark');
    useUnfurlMock.mockReturnValue({ data: { url: 'https://example.org', title: 'X' }, isLoading: false });
    const screen = await render(<UnfurlCard url="https://example.org" messageId="m-1" isAuthor={false} />);
    expect(cardStyle(screen).backgroundColor).toBe('rgb(255, 255, 255)');
  });

  it('fills the web card with the base background in dark mode (#231F20)', async () => {
    document.documentElement.classList.add('dark');
    try {
      useUnfurlMock.mockReturnValue({ data: { url: 'https://example.org', title: 'X' }, isLoading: false });
      const screen = await render(<UnfurlCard url="https://example.org" messageId="m-2" isAuthor={false} />);
      // #231F20 → rgb(35, 31, 32)
      expect(cardStyle(screen).backgroundColor).toBe('rgb(35, 31, 32)');
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });
});
