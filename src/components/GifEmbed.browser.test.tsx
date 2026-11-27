import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { GifBox } from '@/components/GifBox';
import { GifEmbed } from '@/components/GifEmbed';

// A GIF's files come from src/test/fixtures/ohmagif, under the paths
// ohmagif's own use (/g/<id>/full.avif): a test that reached ohmagif would
// hang on the network. Only eTxuLnWv7C has files there.
vi.mock('@/lib/ohmagif-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ohmagif-client')>()),
  OHMAGIF_MEDIA_URL: `${window.location.origin}/src/test/fixtures/ohmagif`,
}));

function rect(el: Element) {
  const r = el.getBoundingClientRect();
  return { width: Math.round(r.width * 100) / 100, height: Math.round(r.height * 100) / 100 };
}

// Whatever the page fetched from ohmagif's own sites.
function ohmagifFetches() {
  return performance
    .getEntriesByType('resource')
    .map((e) => e.name)
    .filter((url) => /ohmagif\.com/.test(new URL(url).hostname));
}

describe('GifEmbed browser layout', () => {
  // The message list measures a row once: the GIF must land in exactly
  // the room its row already has.
  it('shows the file in exactly the room it held, and tells the list once loaded', async () => {
    const onMediaLoad = vi.fn();
    const screen = await render(
      <div style={{ width: 600 }}>
        <GifBox size={{ width: 480, height: 320 }} width={420} unavailable={false} />
        <GifEmbed id="eTxuLnWv7C" width={480} height={320} onMediaLoad={onMediaLoad} />
      </div>,
    );
    const embed = screen.getByTestId('gif-embed');
    const row = rect(embed.element()).height;
    // 480x320 fits 420 wide: 420x280, the credit strip included.
    expect(row).toBe(280);
    // The room the GIF holds while its code loads (the box beside it) is
    // the file's own.
    expect(rect(screen.getByTestId('gif-embed-box').first().element())).toEqual({ width: 420, height: 280 });

    await vi.waitFor(() => expect(onMediaLoad).toHaveBeenCalled());
    const gif = screen.getByRole('link', { name: 'GIF' });
    const img = gif.element().querySelector('img')!;
    expect(img.complete && img.naturalWidth).toBe(24);
    expect(new URL(img.currentSrc).pathname).toBe('/src/test/fixtures/ohmagif/g/eTxuLnWv7C/full.avif');
    expect(rect(gif.element())).toEqual({ width: 420, height: 280 });
    expect(rect(img)).toEqual({ width: 420, height: 280 });
    expect(rect(embed.element()).height).toBe(row);
    // From the id alone: nothing went to ohmagif, not even for a key.
    expect(ohmagifFetches()).toEqual([]);
  });

  it('keeps its room, unavailable, when the GIF was taken down', async () => {
    const screen = await render(
      <div style={{ width: 600 }}>
        <GifEmbed id="GoneGone01" width={480} height={320} />
      </div>,
    );
    const embed = screen.getByTestId('gif-embed');
    const row = rect(embed.element()).height;
    await expect.element(screen.getByText('GIF unavailable')).toBeVisible();
    expect(rect(screen.getByTestId('gif-embed-box').element())).toEqual({ width: 420, height: 280 });
    expect(rect(embed.element()).height).toBe(row);
  });

  it('keeps its shape in a column narrower than the GIF', async () => {
    const screen = await render(
      <div style={{ width: 210 }}>
        <GifEmbed id="eTxuLnWv7C" width={480} height={320} />
      </div>,
    );
    const gif = screen.getByRole('link', { name: 'GIF' });
    await expect.element(gif).toBeVisible();
    expect(rect(gif.element())).toEqual({ width: 210, height: 140 });
  });
});
