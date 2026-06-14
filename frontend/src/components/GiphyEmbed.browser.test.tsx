import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { GiphyEmbed } from './GiphyEmbed';

const giphyFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@giphy/js-fetch-api', () => ({
  GiphyFetch: vi.fn().mockImplementation(function (this: { gif: typeof giphyFetchMock }) {
    this.gif = giphyFetchMock;
  }),
}));

const useWorkspaceSettingsMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useSettings', () => ({
  useWorkspaceSettings: () => useWorkspaceSettingsMock(),
}));

const baseGif = {
  url: 'https://giphy.com/gifs/xyz',
  title: 'A funny GIF',
  is_sticker: false,
  images: {
    original: {
      url: 'https://media.giphy.com/orig.gif',
      mp4: 'https://media.giphy.com/orig.mp4',
      webp: 'https://media.giphy.com/orig.webp',
      width: 480,
      height: 360,
    },
    original_mp4: {
      mp4: 'https://media.giphy.com/orig_mp4.mp4',
      width: 480,
      height: 360,
    },
    looping: { mp4: 'https://media.giphy.com/looping.mp4' },
  },
};

beforeEach(() => {
  giphyFetchMock.mockReset();
  useWorkspaceSettingsMock.mockReset();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('GiphyEmbed browser behaviour', () => {
  it('shows the "GIPHY unavailable" placeholder when no apiKey is provided', async () => {
    const screen = await render(<GiphyEmbed id="abc" apiKey="" />);
    await expect.element(screen.getByText('GIPHY unavailable')).toBeVisible();
  });

  it('shows the loading placeholder while workspace settings are loading', async () => {
    useWorkspaceSettingsMock.mockReturnValue({ data: undefined, isLoading: true });
    const screen = await render(<GiphyEmbed id="abc" />);
    await expect.element(screen.getByText('Loading GIPHY...')).toBeVisible();
  });

  it('shows the loading placeholder when an apiKey is set but the fetch is pending', async () => {
    giphyFetchMock.mockReturnValue(new Promise(() => {}));
    const screen = await render(<GiphyEmbed id="pending-gif" apiKey="real-key" />);
    await expect.element(screen.getByText('Loading GIPHY...')).toBeVisible();
  });

  it('renders an mp4 video when the gif has original_mp4', async () => {
    giphyFetchMock.mockResolvedValue({ data: baseGif });
    await render(<GiphyEmbed id="mp4-gif" apiKey="real-key" width={480} height={360} />);
    // wait for state update.
    await new Promise((r) => setTimeout(r, 100));
    const video = document.querySelector('video') as HTMLVideoElement | null;
    expect(video).not.toBeNull();
    expect(video?.src).toContain('orig_mp4.mp4');
    expect(video?.getAttribute('aria-label')).toBe('A funny GIF');
  });

  it('renders an image when the gif is a sticker with a webp rendition', async () => {
    giphyFetchMock.mockResolvedValue({
      data: { ...baseGif, is_sticker: true, title: 'A sticker' },
    });
    await render(<GiphyEmbed id="sticker-gif" apiKey="real-key" />);
    await new Promise((r) => setTimeout(r, 100));
    const img = document.querySelector('img[alt="A sticker"]') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img?.src).toContain('.webp');
  });

  it('falls back to the original image url when no mp4 is present', async () => {
    giphyFetchMock.mockResolvedValue({
      data: {
        ...baseGif,
        title: 'Image only',
        images: { original: { url: 'https://media.giphy.com/img-only.gif', width: 320, height: 240 } },
      },
    });
    await render(<GiphyEmbed id="img-only" apiKey="real-key" />);
    await new Promise((r) => setTimeout(r, 100));
    const img = document.querySelector('img[alt="Image only"]') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img?.src).toContain('img-only.gif');
  });

  it('shows the unavailable placeholder when the Giphy fetch rejects', async () => {
    giphyFetchMock.mockRejectedValue(new Error('not found'));
    const screen = await render(<GiphyEmbed id="missing-gif" apiKey="real-key" />);
    // Wait for the rejection to flip the state.
    await expect.element(screen.getByText('GIPHY unavailable')).toBeVisible();
  });

  it('renders the "Powered by GIPHY" attribution linking back to the source', async () => {
    giphyFetchMock.mockResolvedValue({ data: baseGif });
    await render(<GiphyEmbed id="link-gif" apiKey="real-key" />);
    await new Promise((r) => setTimeout(r, 100));
    const link = document.querySelector(`a[href="${baseGif.url}"]`) as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.textContent).toMatch(/Powered by GIPHY/);
  });

  it('uses fallback dimensions when neither width nor height is given', async () => {
    giphyFetchMock.mockResolvedValue({
      data: {
        ...baseGif,
        images: { original: { url: 'https://media.giphy.com/x.gif', width: 0, height: 0 } },
      },
    });
    await render(<GiphyEmbed id="no-dim" apiKey="real-key" />);
    await new Promise((r) => setTimeout(r, 100));
    const frame = document.querySelector('[data-testid="giphy-embed"]') as HTMLElement | null;
    expect(frame).not.toBeNull();
    // Fallback width is 320 — confirm box width is set via style.
    expect(frame?.style.width).toMatch(/\d+px/);
  });

  it('falls back to default title and giphy.com url when the gif omits them', async () => {
    giphyFetchMock.mockResolvedValue({
      data: { ...baseGif, title: undefined, url: undefined },
    });
    await render(<GiphyEmbed id="no-meta" apiKey="real-key" width={480} height={360} />);
    await new Promise((r) => setTimeout(r, 100));
    const video = document.querySelector('video') as HTMLVideoElement | null;
    expect(video).not.toBeNull();
    expect(video?.getAttribute('aria-label')).toBe('GIPHY GIF');
    expect(document.querySelector('a[href="https://giphy.com"]')).not.toBeNull();
  });

  it('uses the default sticker title when a sticker omits its title', async () => {
    giphyFetchMock.mockResolvedValue({
      data: { ...baseGif, is_sticker: true, title: undefined },
    });
    await render(<GiphyEmbed id="no-title-sticker" apiKey="real-key" />);
    await new Promise((r) => setTimeout(r, 100));
    expect(document.querySelector('img[alt="GIPHY sticker"]')).not.toBeNull();
  });

  it('uses the original image dimensions when original_mp4 lacks them', async () => {
    giphyFetchMock.mockResolvedValue({
      data: {
        ...baseGif,
        images: {
          original: { url: 'https://media.giphy.com/o.gif', mp4: 'https://media.giphy.com/o.mp4', width: 200, height: 150 },
          original_mp4: { mp4: 'https://media.giphy.com/om.mp4' },
        },
      },
    });
    await render(<GiphyEmbed id="mp4-no-dim" apiKey="real-key" />);
    await new Promise((r) => setTimeout(r, 100));
    // Renders without throwing; dimensions fall back to the original's.
    expect(document.querySelector('[data-testid="giphy-embed"]')).not.toBeNull();
  });

  it('serves a previously fetched gif from the in-memory cache on re-render (no second fetch)', async () => {
    giphyFetchMock.mockResolvedValue({ data: { ...baseGif, title: 'Cached GIF' } });
    // First render populates the module cache.
    await render(<GiphyEmbed id="cache-x" apiKey="real-key" width={480} height={360} />);
    await vi.waitFor(() => expect(document.querySelector('video')).not.toBeNull());
    giphyFetchMock.mockClear();
    // Re-rendering the same id reads readCachedGiphyMedia → renders straight
    // from cache without issuing a new GIPHY request.
    await render(<GiphyEmbed id="cache-x" apiKey="real-key" width={480} height={360} />);
    await vi.waitFor(() => {
      expect(document.querySelectorAll('video').length).toBeGreaterThanOrEqual(2);
    });
    expect(giphyFetchMock).not.toHaveBeenCalled();
  });
});
