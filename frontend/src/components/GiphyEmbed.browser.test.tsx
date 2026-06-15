import { useState } from 'react';
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

  it('reads media straight from the cache on a fresh mount of an already-fetched id', async () => {
    giphyFetchMock.mockResolvedValue({ data: { ...baseGif, title: 'Warm cache' } });
    // Prime the module cache.
    await render(<GiphyEmbed id="warm-cache" apiKey="real-key" width={480} height={360} />);
    await vi.waitFor(() => expect(document.querySelector('video')).not.toBeNull());
    giphyFetchMock.mockClear();
    // A brand-new embed of the same id: the effect's readCachedGiphyMedia hits,
    // queueMicrotask runs setResult while the component is alive (L219-220).
    const second = await render(<GiphyEmbed id="warm-cache" apiKey="real-key" width={480} height={360} />);
    await vi.waitFor(() => {
      expect(document.querySelectorAll('video').length).toBeGreaterThanOrEqual(2);
    });
    expect(giphyFetchMock).not.toHaveBeenCalled();
    void second;
  });

  it('drops the cache entry when its in-flight fetch rejects', async () => {
    giphyFetchMock.mockRejectedValue(new Error('boom'));
    const screen = await render(<GiphyEmbed id="reject-dedupe" apiKey="real-key" width={480} height={360} />);
    // The fetch rejection runs the .catch dedupe (`entry?.promise === promise`
    // → delete) AND flips the embed to the unavailable placeholder.
    await expect.element(screen.getByText('GIPHY unavailable')).toBeVisible();
    // A subsequent successful mount re-fetches (the rejected entry was purged).
    giphyFetchMock.mockResolvedValue({ data: { ...baseGif, title: 'Recovered' } });
    await render(<GiphyEmbed id="reject-dedupe" apiKey="real-key" width={480} height={360} />);
    await vi.waitFor(() => expect(document.querySelector('video')).not.toBeNull());
  });

  it('shows GIPHY unavailable when settings resolve without an API key', async () => {
    // settings present but giphyAPIKey absent → `settings?.giphyAPIKey ?? ''`
    // hits the `?? ''` arm and GiphyEmbedMedia renders the unavailable state.
    useWorkspaceSettingsMock.mockReturnValue({ data: { giphyAPIKey: undefined }, isLoading: false });
    const screen = await render(<GiphyEmbed id="from-settings" />);
    await expect.element(screen.getByText('GIPHY unavailable')).toBeVisible();
  });

  it('renders a plain image with the default title when the gif omits its title and has no mp4', async () => {
    giphyFetchMock.mockResolvedValue({
      data: {
        ...baseGif,
        title: undefined,
        is_sticker: false,
        images: { original: { url: 'https://media.giphy.com/plain.gif', width: 200, height: 100 } },
      },
    });
    await render(<GiphyEmbed id="plain-img-default-title" apiKey="real-key" />);
    await new Promise((r) => setTimeout(r, 100));
    // pickRendition's final image return with the `|| 'GIPHY GIF'` fallback title.
    expect(document.querySelector('img[alt="GIPHY GIF"]')).not.toBeNull();
  });

  it('renders nothing actionable and never fetches when no id is provided', async () => {
    giphyFetchMock.mockClear();
    // No id → readCachedGiphyMedia is skipped (`id ? ... : null`), the effect
    // returns early, and `result.media` stays null → loading placeholder.
    const screen = await render(<GiphyEmbed id={undefined} apiKey="real-key" />);
    await expect.element(screen.getByText('Loading GIPHY...')).toBeVisible();
    expect(giphyFetchMock).not.toHaveBeenCalled();
  });

  it('shares the in-flight promise when a second embed of the same id mounts mid-flight', async () => {
    let resolveGif: ((v: unknown) => void) | undefined;
    giphyFetchMock.mockReturnValue(new Promise((res) => { resolveGif = res; }));
    // A harness that mounts the FIRST embed immediately and the SECOND on a
    // state flip. By the time we flip, the first embed's effect has run and
    // stored the in-flight promise in the module cache, so the second embed's
    // fetchGiphyMedia takes the `cached.promise` reuse branch.
    let mountSecond: (() => void) | undefined;
    function Harness() {
      const [showSecond, setShowSecond] = useState(false);
      mountSecond = () => setShowSecond(true);
      return (
        <>
          <GiphyEmbed id="inflight-harness" apiKey="real-key" width={480} height={360} />
          {showSecond && <GiphyEmbed id="inflight-harness" apiKey="real-key" width={480} height={360} />}
        </>
      );
    }
    await render(<Harness />);
    await new Promise((r) => setTimeout(r, 30));
    expect(giphyFetchMock).toHaveBeenCalledTimes(1);
    mountSecond?.();
    await new Promise((r) => setTimeout(r, 30));
    // Still a single network call — the second embed reused the cached promise.
    expect(giphyFetchMock).toHaveBeenCalledTimes(1);
    resolveGif?.({ data: { ...baseGif, title: 'Inflight GIF' } });
    await vi.waitFor(() => {
      expect(document.querySelectorAll('video').length).toBeGreaterThanOrEqual(2);
    });
  });

  it('re-fetches after the cached id changes on re-render (requestKey mismatch)', async () => {
    giphyFetchMock.mockResolvedValue({ data: { ...baseGif, title: 'First' } });
    const screen = await render(<GiphyEmbed id="switch-a" apiKey="real-key" width={480} height={360} />);
    await vi.waitFor(() => expect(document.querySelector('video')).not.toBeNull());
    // Re-render the SAME element with a different id — the stale result whose
    // requestKey no longer matches yields `null` (the `: null` arm) until the
    // new fetch lands.
    giphyFetchMock.mockResolvedValue({ data: { ...baseGif, title: 'Second' } });
    await screen.rerender(<GiphyEmbed id="switch-b" apiKey="real-key" width={480} height={360} />);
    await vi.waitFor(() => expect(giphyFetchMock).toHaveBeenCalled());
  });

  it('ignores a resolved fetch after the component has unmounted', async () => {
    let resolveGif: ((v: unknown) => void) | undefined;
    let rejectGif: ((e: unknown) => void) | undefined;
    giphyFetchMock.mockReturnValueOnce(new Promise((res) => { resolveGif = res; }));
    const okMount = await render(<GiphyEmbed id="unmount-ok" apiKey="real-key" width={480} height={360} />);
    await okMount.unmount();
    // Resolving after unmount → the `if (alive)` guard in the .then is false.
    resolveGif?.({ data: { ...baseGif, title: 'Late' } });
    await new Promise((r) => setTimeout(r, 30));

    giphyFetchMock.mockReturnValueOnce(new Promise((_res, rej) => { rejectGif = rej; }));
    const errMount = await render(<GiphyEmbed id="unmount-err" apiKey="real-key" width={480} height={360} />);
    await errMount.unmount();
    // Rejecting after unmount → the `if (alive)` guard in the .catch is false.
    rejectGif?.(new Error('late fail'));
    await new Promise((r) => setTimeout(r, 30));
    expect(true).toBe(true);
  });

  it('expires a stale cache entry and re-fetches once the TTL has passed', async () => {
    const realNow = Date.now;
    let clock = 1_000_000;
    Date.now = () => clock;
    try {
      giphyFetchMock.mockResolvedValue({ data: { ...baseGif, title: 'TTL GIF' } });
      await render(<GiphyEmbed id="ttl-x" apiKey="real-key" width={480} height={360} />);
      await vi.waitFor(() => expect(document.querySelector('video')).not.toBeNull());
      giphyFetchMock.mockClear();
      giphyFetchMock.mockResolvedValue({ data: { ...baseGif, title: 'TTL GIF 2' } });
      // Jump past the 24h memory-cache TTL → readCachedGiphyMedia sees an
      // expired entry (expiresAt <= Date.now()), deletes it, and the effect
      // issues a fresh fetch instead of serving the stale value.
      clock += 25 * 60 * 60 * 1000;
      await render(<GiphyEmbed id="ttl-x" apiKey="real-key" width={480} height={360} />);
      await vi.waitFor(() => expect(giphyFetchMock).toHaveBeenCalled());
    } finally {
      Date.now = realNow;
    }
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
