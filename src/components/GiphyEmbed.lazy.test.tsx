import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GiphyEmbed } from './GiphyEmbed';

// Own file: the SDK's module factory runs once per module graph, so counting
// its loads needs a graph no other test has touched.

const sdk = vi.hoisted(() => ({
  loads: 0,
  failNextClient: false,
  gif: vi.fn(),
}));

vi.mock('@giphy/js-fetch-api', () => {
  sdk.loads++;
  return {
    GiphyFetch: vi.fn(function GiphyFetch() {
      if (sdk.failNextClient) {
        sdk.failNextClient = false;
        throw new Error('bad key');
      }
      return { gif: sdk.gif };
    }),
  };
});

vi.mock('@/hooks/useSettings', () => ({
  useWorkspaceSettings: () => ({ data: undefined, isLoading: false }),
}));

describe('GiphyEmbed SDK loading', () => {
  it('loads the Giphy SDK only when an embed asks Giphy for a GIF', async () => {
    // GiphyEmbed sits on every message's render path; the SDK used to come
    // with it, in a vendor chunk preloaded at boot.
    expect(sdk.loads).toBe(0);
    const unavailable = render(<GiphyEmbed id="g-1" apiKey="" />);
    expect(screen.getByText('GIPHY unavailable')).toBeInTheDocument();
    unavailable.unmount();
    expect(sdk.loads).toBe(0);

    sdk.gif.mockResolvedValue({
      data: {
        id: 'g-1',
        title: 'lazy cat',
        url: 'https://giphy.com/gifs/lazy-cat',
        is_sticker: false,
        images: { original: { url: 'https://media.giphy.com/g-1.gif', width: 200, height: 100 } },
      },
    });
    render(<GiphyEmbed id="g-1" apiKey="browser-key" width={200} height={100} />);
    // The row keeps the GIF's box while the SDK loads.
    expect(screen.getByText('Loading GIPHY...')).toHaveStyle({ width: '200px', height: '100px' });
    expect(await screen.findByAltText('lazy cat')).toBeInTheDocument();
    expect(sdk.loads).toBe(1);
    expect(sdk.gif).toHaveBeenCalledWith('g-1');
  });

  it('shows unavailable when the client cannot be built, and builds it again next time', async () => {
    sdk.failNextClient = true;
    const first = render(<GiphyEmbed id="g-2" apiKey="flaky-key" />);
    expect(await screen.findByText('GIPHY unavailable')).toBeInTheDocument();
    first.unmount();

    sdk.gif.mockResolvedValue({
      data: {
        id: 'g-2',
        title: 'second try',
        url: 'https://giphy.com/gifs/second-try',
        is_sticker: false,
        images: { original: { url: 'https://media.giphy.com/g-2.gif', width: 200, height: 100 } },
      },
    });
    render(<GiphyEmbed id="g-2" apiKey="flaky-key" />);
    expect(await screen.findByAltText('second try')).toBeInTheDocument();
  });
});
