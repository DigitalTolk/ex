import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { GiphyGif } from '@/components/GiphyGif';

// The GIF comes from a local file, never from GIPHY: a test that reached
// out to it would hang on the network.
const file = vi.hoisted(() => ({ url: '' }));
vi.mock('@/lib/giphy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/giphy')>()),
  giphyFileURL: () => file.url,
}));

// A one-pixel GIF, so the browser decodes a real one.
function pixelGIF(): string {
  const bytes = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: 'image/gif' }));
}

afterEach(() => {
  if (file.url.startsWith('blob:')) URL.revokeObjectURL(file.url);
});

function rect(el: Element) {
  const r = el.getBoundingClientRect();
  return { width: Math.round(r.width), height: Math.round(r.height) };
}

describe('GiphyGif in the browser', () => {
  // The message list measures a row once: a GIF that arrives later, or
  // never, must keep exactly the room the row already has.
  it('shows in the room the message kept, and tells the list once loaded', async () => {
    file.url = pixelGIF();
    const onMediaLoad = vi.fn();
    const screen = await render(
      <div style={{ width: 600 }}>
        <GiphyGif id="3o6fJgjGjsfdVsVtcc" width={480} height={270} onMediaLoad={onMediaLoad} />
      </div>,
    );
    const gif = screen.getByTestId('giphy-gif');
    const before = rect(gif.element());
    await vi.waitFor(() => expect(onMediaLoad).toHaveBeenCalled());
    const el = screen.getByRole('img', { name: 'GIF' }).element() as HTMLImageElement;
    expect(el.complete && el.naturalWidth).toBe(1);
    expect(rect(el)).toEqual({ width: 420, height: 236 });
    expect(rect(gif.element())).toEqual(before);
  });

  it('keeps its room, unavailable, when the GIF does not load', async () => {
    file.url = `${window.location.origin}/__giphy__/gone.gif`;
    const screen = await render(
      <div style={{ width: 600 }}>
        <GiphyGif id="gone" width={480} height={270} />
      </div>,
    );
    const gif = screen.getByTestId('giphy-gif');
    const before = rect(gif.element());
    await expect.element(screen.getByText('GIF unavailable')).toBeVisible();
    expect(rect(gif.element())).toEqual(before);
    await expect.element(screen.getByRole('link', { name: 'Powered by GIPHY' })).toBeVisible();
  });

  it('keeps its shape in a column narrower than the GIF', async () => {
    file.url = pixelGIF();
    const screen = await render(
      <div style={{ width: 210 }}>
        <GiphyGif id="3o6fJgjGjsfdVsVtcc" width={480} height={270} />
      </div>,
    );
    expect(rect(screen.getByRole('img', { name: 'GIF' }).element())).toEqual({ width: 210, height: 118 });
  });
});
