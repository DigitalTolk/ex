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

  it('replaces a broken image with the placeholder slot', async () => {
    useUnfurlMock.mockReturnValue({
      data: { url: 'https://example.org', title: 'X', image: 'https://example.org/missing.png' },
      isLoading: false,
    });
    await render(<UnfurlCard url="https://example.org" messageId="m-1" isAuthor={false} />);
    const img = document.querySelector('[data-testid="unfurl-card-image"]') as HTMLImageElement;
    // Synthesise the error event the broken-image path responds to.
    img.dispatchEvent(new Event('error'));
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="unfurl-card-image-placeholder"]')).not.toBeNull();
    });
  });
});
