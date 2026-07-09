import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  };
});

import { UnfurlCard } from '@/components/chat/UnfurlCard';

function renderCard(props: Partial<React.ComponentProps<typeof UnfurlCard>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <UnfurlCard
        url="https://example.com/post"
        messageId="m-1"
        channelId="ch-1"
        isAuthor={false}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe('UnfurlCard', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('renders nothing when the unfurl endpoint returns 204 / null', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const { container } = renderCard();
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('renders title + description + image when the endpoint returns metadata', async () => {
    apiFetchMock.mockResolvedValue({
      url: 'https://example.com/post',
      title: 'Hello',
      description: 'A page',
      image: 'https://example.com/cover.jpg',
      siteName: 'Example',
    });
    renderCard();
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());
    expect(screen.getByText('A page')).toBeInTheDocument();
    expect(screen.getByText('Example')).toBeInTheDocument();
  });

  it('hides the dismiss X for non-authors', async () => {
    apiFetchMock.mockResolvedValue({
      url: 'https://example.com/post',
      title: 'Hello',
    });
    renderCard({ isAuthor: false });
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());
    expect(screen.queryByTestId('unfurl-card-dismiss')).toBeNull();
  });

  it('shows the X for the author and clicking it PUTs noUnfurl=true', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/unfurl')) {
        return Promise.resolve({ url: 'https://example.com/post', title: 'Hello' });
      }
      // The dismiss mutation hits the no-unfurl endpoint.
      return Promise.resolve({});
    });
    renderCard({ isAuthor: true });
    await waitFor(() => expect(screen.getByTestId('unfurl-card-dismiss')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('unfurl-card-dismiss'));

    await waitFor(() => {
      const calls = apiFetchMock.mock.calls.map((c) => c[0]);
      expect(calls).toContain('/api/v1/channels/ch-1/messages/m-1/no-unfurl');
    });
    const dismissCall = apiFetchMock.mock.calls.find((c) =>
      typeof c[0] === 'string' && c[0].endsWith('/no-unfurl'),
    );
    expect(dismissCall?.[1]).toMatchObject({
      method: 'PUT',
      body: JSON.stringify({ noUnfurl: true }),
    });
  });
});
