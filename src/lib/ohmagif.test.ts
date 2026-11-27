import { afterEach, describe, expect, it } from 'vitest';
import { fileURL, gifURL, isApiKey, isGifId } from '@ohmagif/js';
import { fitSize, storedSize } from '@/lib/gif-size';
import { isOhmagifId, ohmagifKey } from '@/lib/ohmagif';
import { OHMAGIF_MEDIA_URL, ohmagifClient } from '@/lib/ohmagif-client';
import { apiGif, json, ohmagifRequests, stubOhmagif, TEST_OHMAGIF_KEY } from '@/test/ohmagif';

// lib/ohmagif decides what it can without loading @ohmagif/js; each of its
// answers must be the library's own.
describe('ohmagif without the library', () => {
  it.each([
    TEST_OHMAGIF_KEY,
    'omg_ZYXWVUTSRQPONMLKJIHGFEDCBA987654',
    'dc6zaTOxFJmzC', // a GIPHY key, from before ohmagif replaced GIPHY
    'omg_0123456789abcdefABCDEF012345678',
    'omg_0123456789abcdefABCDEF01234567890',
    'omg_0123456789abcdefABCDEF012345678-',
    'OMG_0123456789abcdefABCDEF0123456789',
    '',
  ])('takes %j as a key exactly when the library does', (key) => {
    expect(ohmagifKey(key) !== null).toBe(isApiKey(key));
  });

  it('trims the key, and has none without one', () => {
    expect(ohmagifKey(`  ${TEST_OHMAGIF_KEY}\n`)).toBe(TEST_OHMAGIF_KEY);
    expect(ohmagifKey(undefined)).toBeNull();
    expect(ohmagifKey('   ')).toBeNull();
  });

  it.each(['eTxuLnWv7C', 'EDapunaJjI', 'short', 'eTxuLnWv7C1', 'eTxuLnWv7%', '../../xyz1', ''])(
    'takes %j as a GIF id exactly when the library does',
    (id) => {
      expect(isOhmagifId(id)).toBe(isGifId(id));
    },
  );

});

// A message keeps only the id: every address comes from it.
describe("a GIF's addresses", () => {
  it("are ohmagif's own, the same for as long as the GIF is up", () => {
    expect(fileURL('eTxuLnWv7C', 'full', OHMAGIF_MEDIA_URL)).toBe('https://i.ohmagif.com/g/eTxuLnWv7C/full.avif');
    expect(gifURL('eTxuLnWv7C')).toBe('https://ohmagif.com/g/eTxuLnWv7C');
  });
});

describe('ohmagifClient', () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  it('asks ohmagif with the key, through the fetch of the moment it asks', async () => {
    // Made before the stub: the request still goes through it.
    const client = ohmagifClient(TEST_OHMAGIF_KEY);
    const spy = stubOhmagif(() => json(apiGif('eTxuLnWv7C')));
    restore = () => spy.mockRestore();

    const { data } = await client.gif('eTxuLnWv7C');
    expect(data.id).toBe('eTxuLnWv7C');
    expect(ohmagifRequests(spy)).toEqual(['/api/v1/gifs/eTxuLnWv7C']);
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${TEST_OHMAGIF_KEY}`);
  });
});

describe('GIF sizes in messages', () => {
  it('keeps the size a message kept, or falls back to 4:3 without one', () => {
    expect(storedSize(480, 294)).toEqual({ width: 480, height: 294 });
    expect(storedSize()).toEqual({ width: 320, height: 240 });
    expect(storedSize(480)).toEqual({ width: 320, height: 240 });
    expect(storedSize(0, 270)).toEqual({ width: 320, height: 240 });
    // No file is a fraction of a pixel (GifFromId draws nothing for one).
    expect(storedSize(480.5, 270)).toEqual({ width: 320, height: 240 });
  });

  it('fits the size into 420 by 320, never enlarged', () => {
    expect(fitSize({ width: 200, height: 150 })).toEqual({ width: 200, height: 150 });
    expect(fitSize({ width: 1000, height: 500 })).toEqual({ width: 420, height: 210 });
    expect(fitSize({ width: 300, height: 600 })).toEqual({ width: 160, height: 320 });
  });
});
