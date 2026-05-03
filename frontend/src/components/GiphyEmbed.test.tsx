import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { GiphyEmbed } from './GiphyEmbed';

const giphyFetchMocks = vi.hoisted(() => ({
  gif: vi.fn(),
}));

const settingsMock = vi.hoisted(() => ({
  value: { data: undefined, isLoading: false } as {
    data?: { giphyAPIKey?: string };
    isLoading: boolean;
  },
}));

vi.mock('@giphy/js-fetch-api', () => ({
  GiphyFetch: vi.fn(function GiphyFetch() {
    return giphyFetchMocks;
  }),
}));

vi.mock('@/hooks/useSettings', () => ({
  useWorkspaceSettings: () => settingsMock.value,
}));

describe('GiphyEmbed', () => {
  beforeEach(() => {
    giphyFetchMocks.gif.mockReset();
    settingsMock.value = { data: undefined, isLoading: false };
  });

  it('fetches a persisted Giphy ID directly and renders the returned MP4 URL unchanged', async () => {
    giphyFetchMocks.gif.mockResolvedValue({
      data: {
        id: 'g-1',
        title: 'cat dance',
        url: 'https://giphy.com/gifs/cat-dance-g-1',
        is_sticker: false,
        images: {
          original: {
            url: 'https://media.giphy.com/g-1.gif',
            mp4: 'https://media.giphy.com/g-1-fallback.mp4',
            width: 300,
            height: 200,
          },
          original_mp4: {
            mp4: 'https://media.giphy.com/g-1.mp4?cid=keep',
            width: 300,
            height: 200,
          },
        },
      },
    });

    render(<GiphyEmbed id="g-1" apiKey="browser-key" />);

    await waitFor(() => {
      expect(giphyFetchMocks.gif).toHaveBeenCalledWith('g-1');
    });
    const video = await screen.findByLabelText('cat dance');
    expect(video.tagName.toLowerCase()).toBe('video');
    expect(video.getAttribute('src')).toBe('https://media.giphy.com/g-1.mp4?cid=keep');
    expect(video.getAttribute('width')).toBe('300');
    expect(video.getAttribute('height')).toBe('200');
    expect(screen.getByTestId('giphy-embed').firstElementChild?.className).not.toContain('aspect-[4/3]');
    expect(video.className).not.toContain('object-contain');
    expect(screen.getByRole('link', { name: /powered by giphy/i })).toHaveAttribute(
      'href',
      'https://giphy.com/gifs/cat-dance-g-1',
    );
  });

  it('uses WEBP for sticker media when Giphy returns one', async () => {
    giphyFetchMocks.gif.mockResolvedValue({
      data: {
        id: 's-1',
        title: 'party sticker',
        url: 'https://giphy.com/stickers/party-s-1',
        is_sticker: true,
        images: {
          original: {
            url: 'https://media.giphy.com/s-1.gif',
            webp: 'https://media.giphy.com/s-1.webp?cid=keep',
            width: 180,
            height: 180,
          },
        },
      },
    });

    render(<GiphyEmbed id="s-1" apiKey="browser-key" />);

    const img = await screen.findByAltText('party sticker');
    expect(img.getAttribute('src')).toBe('https://media.giphy.com/s-1.webp?cid=keep');
    expect(img.getAttribute('width')).toBe('180');
    expect(img.getAttribute('height')).toBe('180');
    expect(screen.getByRole('link', { name: /powered by giphy/i })).toHaveAttribute(
      'href',
      'https://giphy.com/stickers/party-s-1',
    );
  });

  it('reuses resolved media from session memory when a virtualized row remounts', async () => {
    giphyFetchMocks.gif.mockResolvedValue({
      data: {
        id: 'cache-1',
        title: 'cached cat',
        url: 'https://giphy.com/gifs/cached-cat-g-1',
        is_sticker: false,
        images: {
          original: {
            url: 'https://media.giphy.com/cache-1.gif',
            mp4: 'https://media.giphy.com/cache-1-fallback.mp4',
            width: 300,
            height: 200,
          },
          original_mp4: {
            mp4: 'https://media.giphy.com/cache-1.mp4?cid=keep',
            width: 300,
            height: 200,
          },
        },
      },
    });

    const first = render(<GiphyEmbed id="cache-1" apiKey="browser-key" />);
    expect(await screen.findByLabelText('cached cat')).toBeInTheDocument();
    expect(giphyFetchMocks.gif).toHaveBeenCalledTimes(1);
    first.unmount();

    render(<GiphyEmbed id="cache-1" apiKey="browser-key" />);

    expect(await screen.findByLabelText('cached cat')).toBeInTheDocument();
    expect(giphyFetchMocks.gif).toHaveBeenCalledTimes(1);
  });

  it('dedupes simultaneous remount fetches for the same Giphy ID', async () => {
    giphyFetchMocks.gif.mockResolvedValue({
      data: {
        id: 'dedupe-1',
        title: 'deduped cat',
        url: 'https://giphy.com/gifs/deduped-cat-g-1',
        is_sticker: false,
        images: {
          original: {
            url: 'https://media.giphy.com/dedupe-1.gif',
            mp4: 'https://media.giphy.com/dedupe-1-fallback.mp4',
            width: 300,
            height: 200,
          },
          original_mp4: {
            mp4: 'https://media.giphy.com/dedupe-1.mp4?cid=keep',
            width: 300,
            height: 200,
          },
        },
      },
    });

    render(
      <>
        <GiphyEmbed id="dedupe-1" apiKey="browser-key" />
        <GiphyEmbed id="dedupe-1" apiKey="browser-key" />
      </>,
    );

    expect(await screen.findAllByLabelText('deduped cat')).toHaveLength(2);
    expect(giphyFetchMocks.gif).toHaveBeenCalledTimes(1);
  });

  it('does not call Giphy when no browser key is available', () => {
    render(<GiphyEmbed id="g-1" apiKey="" />);

    expect(screen.getByText('GIPHY unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /powered by giphy/i })).not.toBeInTheDocument();
    expect(giphyFetchMocks.gif).not.toHaveBeenCalled();
  });

  it('shows loading instead of unavailable while settings are still resolving', () => {
    settingsMock.value = { data: undefined, isLoading: true };

    render(<GiphyEmbed id="g-1" width={300} height={200} />);

    expect(screen.getByText('Loading GIPHY...')).toBeInTheDocument();
    expect(screen.queryByText('GIPHY unavailable')).not.toBeInTheDocument();
    expect(giphyFetchMocks.gif).not.toHaveBeenCalled();
  });

  it('uses the workspace settings API key when no explicit key is passed', async () => {
    settingsMock.value = { data: { giphyAPIKey: 'settings-key' }, isLoading: false };
    giphyFetchMocks.gif.mockResolvedValue({
      data: {
        id: 'settings-1',
        title: '',
        url: '',
        is_sticker: false,
        images: {
          original: {
            url: 'https://media.giphy.com/settings-1.gif',
            width: 120,
            height: 80,
          },
        },
      },
    });

    render(<GiphyEmbed id="settings-1" />);

    const img = await screen.findByAltText('GIPHY GIF');
    expect(img.getAttribute('src')).toBe('https://media.giphy.com/settings-1.gif');
    expect(screen.getByRole('link', { name: /powered by giphy/i })).toHaveAttribute(
      'href',
      'https://giphy.com',
    );
  });

  it('falls back to looping MP4 when original MP4 renditions are absent', async () => {
    giphyFetchMocks.gif.mockResolvedValue({
      data: {
        id: 'loop-1',
        title: '',
        url: 'https://giphy.com/gifs/loop-1',
        is_sticker: false,
        images: {
          original: {
            url: 'https://media.giphy.com/loop-1.gif',
            width: 900,
            height: 600,
          },
          looping: {
            mp4: 'https://media.giphy.com/loop-1-loop.mp4?cid=keep',
          },
        },
      },
    });

    render(<GiphyEmbed id="loop-1" apiKey="browser-key" />);

    const video = await screen.findByLabelText('GIPHY GIF');
    expect(video.tagName.toLowerCase()).toBe('video');
    expect(video.getAttribute('src')).toBe('https://media.giphy.com/loop-1-loop.mp4?cid=keep');
    expect(video).toHaveStyle({ width: '420px', height: '280px' });
  });

  it('shows unavailable when a Giphy lookup fails and clears the failed promise from cache', async () => {
    giphyFetchMocks.gif.mockRejectedValueOnce(new Error('network'));

    render(<GiphyEmbed id="fail-1" apiKey="browser-key" width={640} height={480} />);

    expect(await screen.findByText('GIPHY unavailable')).toHaveStyle({
      width: '420px',
      height: '315px',
    });
    expect(giphyFetchMocks.gif).toHaveBeenCalledTimes(1);

    giphyFetchMocks.gif.mockResolvedValueOnce({
      data: {
        id: 'fail-1',
        title: 'retry ok',
        url: 'https://giphy.com/gifs/retry-ok',
        is_sticker: false,
        images: {
          original: {
            url: 'https://media.giphy.com/retry-ok.gif',
            width: 200,
            height: 120,
          },
        },
      },
    });
    render(<GiphyEmbed id="fail-1" apiKey="browser-key" />);
    expect(await screen.findByAltText('retry ok')).toBeInTheDocument();
    expect(giphyFetchMocks.gif).toHaveBeenCalledTimes(2);
  });

  it('does not fetch when the persisted Giphy ID is empty', () => {
    render(<GiphyEmbed id="" apiKey="browser-key" />);

    expect(screen.getByText('Loading GIPHY...')).toBeInTheDocument();
    expect(giphyFetchMocks.gif).not.toHaveBeenCalled();
  });
});
