import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { GiphyGif } from '@/components/GiphyGif';
import { giphyFileURL, giphyPageURL, isGiphyId } from '@/lib/giphy';

// A GIF picked from GIPHY before ohmagif replaced it shows from GIPHY's own
// files: no SDK, no key, no API call (jsdom loads no images, so nothing here
// reaches GIPHY).
describe('GiphyGif', () => {
  it("shows the GIF file from GIPHY in the room the message kept, with GIPHY's attribution", () => {
    render(<GiphyGif id="3o6fJgjGjsfdVsVtcc" width={480} height={270} />);

    const img = screen.getByRole('img', { name: 'GIF' });
    expect(img).toHaveAttribute('src', 'https://i.giphy.com/3o6fJgjGjsfdVsVtcc.gif');
    expect(img).toHaveAttribute('width', '420');
    expect(img).toHaveAttribute('height', '236');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
    // 480x270 fits 420 wide.
    expect(img.parentElement).toHaveStyle({ width: '420px', aspectRatio: '420 / 236' });
    expect(screen.getByRole('link', { name: 'Powered by GIPHY' })).toHaveAttribute(
      'href',
      'https://giphy.com/gifs/3o6fJgjGjsfdVsVtcc',
    );
  });

  it('holds a 4:3 room for a GIF the message kept no size for', () => {
    render(<GiphyGif id="3o6fJgjGjsfdVsVtcc" />);
    expect(screen.getByRole('img', { name: 'GIF' }).parentElement).toHaveStyle({ width: '320px', aspectRatio: '320 / 240' });
  });

  it('tells the message list once the GIF has loaded', () => {
    const onMediaLoad = vi.fn();
    render(<GiphyGif id="3o6fJgjGjsfdVsVtcc" width={480} height={270} onMediaLoad={onMediaLoad} />);
    act(() => {
      fireEvent.load(screen.getByRole('img', { name: 'GIF' }));
    });
    expect(onMediaLoad).toHaveBeenCalledTimes(1);
  });

  it('says the GIF is unavailable when GIPHY no longer has it, in the same room', () => {
    render(<GiphyGif id="gone" width={480} height={270} />);
    const box = screen.getByRole('img', { name: 'GIF' }).parentElement!;
    act(() => {
      fireEvent.error(screen.getByRole('img', { name: 'GIF' }));
    });
    expect(screen.queryByRole('img', { name: 'GIF' })).toBeNull();
    expect(box).toHaveTextContent('GIF unavailable');
    expect(box).toHaveStyle({ width: '420px', aspectRatio: '420 / 236' });
    expect(screen.getByRole('link', { name: 'Powered by GIPHY' })).toBeInTheDocument();
  });
});

describe('GIPHY addresses', () => {
  it('builds them from an id that can only be an id', () => {
    expect(isGiphyId('3o6fJgjGjsfdVsVtcc')).toBe(true);
    expect(isGiphyId('a_b-c')).toBe(true);
    expect(isGiphyId('../x')).toBe(false);
    expect(isGiphyId('a?b')).toBe(false);
    expect(isGiphyId('')).toBe(false);
    expect(giphyFileURL('abc')).toBe('https://i.giphy.com/abc.gif');
    expect(giphyPageURL('abc')).toBe('https://giphy.com/gifs/abc');
  });
});
