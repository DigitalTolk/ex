import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { UnfurlCard } from './UnfurlCard';
import type { UnfurlPreview } from '@/hooks/useUnfurl';
import type { ComponentProps } from 'react';

// useUnfurl is mocked per-test so we can drive what the card renders
// without touching the network. Cast to a function so TS lets us
// re-stub the return value via mockReturnValue in each test.
const mockUseUnfurl = vi.fn();
vi.mock('@/hooks/useUnfurl', () => ({
  useUnfurl: (url: string | null) => mockUseUnfurl(url),
}));

vi.mock('@/hooks/useMessages', () => ({
  useSetNoUnfurl: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojiMap: () => ({ data: {} }),
}));

function renderCard(props: Partial<ComponentProps<typeof UnfurlCard>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <UnfurlCard
          url="https://example.com/post"
          messageId="msg-1"
          channelId="chan-1"
          isAuthor={false}
          {...props}
        />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

function makePreview(overrides: Partial<UnfurlPreview> = {}): UnfurlPreview {
  return {
    url: 'https://example.com/post',
    title: 'A Post',
    description: 'About things',
    image: 'https://s3.example/unfurl/abc.png',
    ...overrides,
  };
}

beforeEach(() => {
  mockUseUnfurl.mockReset();
});

describe('UnfurlCard', () => {
  it('renders the image when it loads successfully', () => {
    mockUseUnfurl.mockReturnValue({ data: makePreview(), isLoading: false });
    renderCard();
    const img = screen.getByTestId('unfurl-card-image') as HTMLImageElement;
    expect(img.src).toBe('https://s3.example/unfurl/abc.png');
    expect(img.getAttribute('width')).toBe('64');
    expect(img.getAttribute('height')).toBe('64');
    expect(screen.queryByTestId('unfurl-card-image-placeholder')).toBeNull();
  });

  it('does not report height changes for fixed-size image load or error events', async () => {
    const onContentHeightChange = vi.fn();
    mockUseUnfurl.mockReturnValue({ data: makePreview(), isLoading: false });
    renderCard({ onContentHeightChange });
    await vi.waitFor(() => expect(onContentHeightChange).toHaveBeenCalledTimes(1));
    const img = screen.getByTestId('unfurl-card-image');
    fireEvent.load(img);
    fireEvent.error(img);
    expect(onContentHeightChange).toHaveBeenCalledTimes(1);
  });

  it('renders a placeholder when the image fails to load', () => {
    mockUseUnfurl.mockReturnValue({ data: makePreview(), isLoading: false });
    renderCard();
    const img = screen.getByTestId('unfurl-card-image');
    // Simulate the browser firing onError (404, network, CORS).
    fireEvent.error(img);
    // The img element is removed and replaced by an aria-hidden
    // placeholder slot showing the ImageOff icon.
    expect(screen.queryByTestId('unfurl-card-image')).toBeNull();
    expect(screen.getByTestId('unfurl-card-image-placeholder')).toBeInTheDocument();
    // The rest of the card (title, description) is still rendered —
    // the placeholder only swaps the image slot.
    expect(screen.getByText('A Post')).toBeInTheDocument();
    expect(screen.getByText('About things')).toBeInTheDocument();
  });

  it('renders nothing when preview has no fields', () => {
    mockUseUnfurl.mockReturnValue({
      data: { url: 'https://example.com/x' },
      isLoading: false,
    });
    const { container } = renderCard();
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing while loading', () => {
    mockUseUnfurl.mockReturnValue({ data: undefined, isLoading: true });
    const { container } = renderCard();
    expect(container.firstChild).toBeNull();
  });

  describe('internal message-link preview', () => {
    function messagePreview(overrides: Partial<UnfurlPreview> = {}): UnfurlPreview {
      return {
        url: 'https://ex.test/channel/incidents#msg-1',
        kind: 'message',
        siteName: 'ex.test',
        authorName: 'Günter Grodotzki',
        authorAvatarURL: 'https://img/g.png',
        channelLabel: '~Incidents',
        body: 'please do proper RCA',
        createdAt: '2026-06-15T10:00:00Z',
        image: 'https://img/chart.png',
        ...overrides,
      };
    }

    it('renders the Slack-style author/body/channel card with avatar and image (no host, not dismissible)', () => {
      mockUseUnfurl.mockReturnValue({ data: messagePreview(), isLoading: false });
      renderCard({ isAuthor: true });
      expect(screen.getByTestId('unfurl-message-card')).toBeInTheDocument();
      const avatar = screen.getByTestId('unfurl-message-avatar') as HTMLImageElement;
      expect(avatar.src).toBe('https://img/g.png');
      expect(screen.getByText('Günter Grodotzki')).toBeInTheDocument();
      // Hostname is not shown on message-link previews.
      expect(screen.queryByText('ex.test')).toBeNull();
      expect(screen.getByText('please do proper RCA')).toBeInTheDocument();
      expect(screen.getByText('Only visible to users in ~Incidents')).toBeInTheDocument();
      expect((screen.getByTestId('unfurl-card-image') as HTMLImageElement).src).toBe('https://img/chart.png');
      // Message previews are never dismissible, even for the author.
      expect(screen.queryByTestId('unfurl-card-dismiss')).toBeNull();
    });

    it('makes the whole card a stretched link to the message without underlining the author', () => {
      mockUseUnfurl.mockReturnValue({ data: messagePreview(), isLoading: false });
      renderCard();
      const link = screen.getByTestId('unfurl-message-card');
      expect(link.tagName).toBe('A');
      expect(link).toHaveAttribute('href', 'https://ex.test/channel/incidents#msg-1');
      // Stretched-link overlay covers the whole card box.
      expect(link).toHaveClass('absolute');
      expect(link).toHaveClass('inset-0');
      // The author name is plain text (not wrapped in the link) so hovering the
      // card never underlines the username.
      expect(screen.getByText('Günter Grodotzki').closest('a')).toBeNull();
    });

    it('falls back to author initials when there is no avatar, and renders without an image', () => {
      mockUseUnfurl.mockReturnValue({
        data: messagePreview({ authorAvatarURL: undefined, image: undefined }),
        isLoading: false,
      });
      renderCard();
      expect(screen.queryByTestId('unfurl-message-avatar')).toBeNull();
      expect(screen.queryByTestId('unfurl-card-image')).toBeNull();
      // Initials fallback ("GG") is shown.
      expect(screen.getByText('GG')).toBeInTheDocument();
    });

    it('renders with a body but no author name (falls back to Unknown + "?" initials)', () => {
      mockUseUnfurl.mockReturnValue({
        data: messagePreview({ authorName: undefined, authorAvatarURL: undefined, image: undefined, body: 'just a body' }),
        isLoading: false,
      });
      renderCard();
      expect(screen.getByText('just a body')).toBeInTheDocument();
      expect(screen.getByText('Unknown')).toBeInTheDocument();
    });

    it('renders an image-only message preview (no author name, no body)', () => {
      mockUseUnfurl.mockReturnValue({
        data: messagePreview({ authorName: undefined, authorAvatarURL: undefined, body: undefined }),
        isLoading: false,
      });
      renderCard();
      expect(screen.getByTestId('unfurl-message-card')).toBeInTheDocument();
      expect(screen.getByTestId('unfurl-card-image')).toBeInTheDocument();
    });

    it('swaps a broken message image for nothing but keeps the rest of the card', () => {
      mockUseUnfurl.mockReturnValue({ data: messagePreview(), isLoading: false });
      renderCard();
      fireEvent.error(screen.getByTestId('unfurl-card-image'));
      expect(screen.queryByTestId('unfurl-card-image')).toBeNull();
      expect(screen.getByText('Günter Grodotzki')).toBeInTheDocument();
    });
  });
});
