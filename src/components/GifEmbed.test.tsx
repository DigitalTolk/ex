import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { GifBox } from '@/components/GifBox';
import { GifEmbed } from '@/components/GifEmbed';

// GifFile arrives via React.lazy. Pre-load its module so the lazy
// resolution is a deterministic microtask inside the tests' own awaited
// act()s rather than chunk I/O between them.
beforeAll(async () => {
  await import('@/components/GifFile');
});

// jsdom loads no images, so nothing here reaches ohmagif; fetch is watched
// to prove the GIF needs no request at all.
let fetchSpy: MockInstance<typeof fetch>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => fetchSpy.mockRestore());

describe('GifEmbed', () => {
  it('shows the GIF from its id alone: its file at its lasting address, linking to its page', async () => {
    render(<GifEmbed id="eTxuLnWv7C" width={480} height={320} />);

    const gif = await screen.findByRole('link', { name: 'GIF' });
    expect(gif).toHaveAttribute('href', 'https://ohmagif.com/g/eTxuLnWv7C');
    expect(gif).toHaveAttribute('target', '_blank');
    // 480x320 fits 420 wide, in the file's own shape: its credit strip shows.
    expect(gif).toHaveStyle({ width: '420px', aspectRatio: '480 / 320' });
    const picture = gif.querySelector('picture')!;
    expect(picture.querySelector('source')).toHaveAttribute('type', 'image/avif');
    expect(picture.querySelector('source')).toHaveAttribute('srcset', 'https://i.ohmagif.com/g/eTxuLnWv7C/full.avif');
    // The poster, for a browser without AVIF.
    expect(picture.querySelector('img')).toHaveAttribute('src', 'https://i.ohmagif.com/g/eTxuLnWv7C/poster.jpg');
    // No key and no lookup: nothing asks the API.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('holds a 4:3 room for a GIF a message kept no size for', async () => {
    render(<GifEmbed id="eTxuLnWv7C" />);
    expect(await screen.findByRole('link', { name: 'GIF' })).toHaveStyle({ width: '320px', aspectRatio: '320 / 240' });
  });

  it('says the GIF is unavailable when its file does not load, in the same room', async () => {
    render(<GifEmbed id="eTxuLnWv7C" width={480} height={320} />);
    const gif = await screen.findByRole('link', { name: 'GIF' });
    act(() => {
      fireEvent.error(gif.querySelector('img')!);
    });
    expect(screen.queryByRole('link')).toBeNull();
    const box = screen.getByTestId('gif-embed-box');
    expect(box).toHaveTextContent('GIF unavailable');
    expect(box).toHaveStyle({ width: '420px', aspectRatio: '480 / 320' });
    expect(box).not.toHaveAttribute('aria-busy');
  });

  it('shows nothing to load for an id that is no ohmagif id', () => {
    render(<GifEmbed id="../../x" width={480} height={320} />);
    expect(screen.getByTestId('gif-embed-box')).toHaveTextContent('GIF unavailable');
    expect(screen.getByTestId('gif-embed-box')).toHaveStyle({ width: '420px' });
    expect(document.querySelector('picture')).toBeNull();
  });

  it('tells the message list once its file has loaded', async () => {
    const onMediaLoad = vi.fn();
    render(<GifEmbed id="eTxuLnWv7C" width={480} height={320} onMediaLoad={onMediaLoad} />);
    const gif = await screen.findByRole('link', { name: 'GIF' });
    expect(onMediaLoad).not.toHaveBeenCalled();
    act(() => {
      fireEvent.load(gif.querySelector('img')!);
    });
    expect(onMediaLoad).toHaveBeenCalledTimes(1);
  });
});

describe('GifBox', () => {
  it('is busy, saying nothing, while the GIF is on its way', () => {
    render(<GifBox size={{ width: 480, height: 320 }} width={420} unavailable={false} />);
    const box = screen.getByTestId('gif-embed-box');
    expect(box).toHaveAttribute('aria-busy', 'true');
    expect(box).toHaveStyle({ width: '420px', aspectRatio: '480 / 320' });
    expect(box).toBeEmptyDOMElement();
  });
});
