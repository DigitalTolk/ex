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
});
