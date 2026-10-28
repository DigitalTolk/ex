import { describe, expect, it } from 'vitest';

// WebKit applies none of a stylesheet while an @import in it is still
// loading. The app sheet once imported its font from Google, so on an iPhone
// every rule in it waited for that site to answer (a slow answer left a whole
// browser test file unstyled). Whatever the sheet needs is bundled into it.
describe('the app stylesheet', () => {
  it('imports nothing it has to wait for', () => {
    const imports = [...document.styleSheets].flatMap((sheet) =>
      [...sheet.cssRules].filter((rule) => rule instanceof CSSImportRule).map((rule) => rule.href),
    );
    expect(imports).toEqual([]);
  });

  // load() rejects when a matching face's file fails to load.
  it('still loads Figtree, from the app itself', async () => {
    const faces = await document.fonts.load('600 16px Figtree');
    expect(faces.length).toBeGreaterThan(0);
    expect(faces.every((face) => face.status === 'loaded')).toBe(true);
  });
});
