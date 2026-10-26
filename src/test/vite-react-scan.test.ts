import { describe, it, expect, afterEach } from 'vitest';
import { reactScanDev } from '../../vite.config';

type HtmlHook = (html: string) => string;

function transform(html: string): string {
  return (reactScanDev().transformIndexHtml as HtmlHook)(html);
}

describe('react-scan dev script', () => {
  const saved = process.env.REACT_SCAN;
  afterEach(() => {
    if (saved === undefined) delete process.env.REACT_SCAN;
    else process.env.REACT_SCAN = saved;
  });

  it('is pinned to one version and locked with Subresource Integrity', () => {
    delete process.env.REACT_SCAN;
    const out = transform('<html><head></head></html>');
    const script = new DOMParser().parseFromString(out, 'text/html').querySelector('script');
    expect(script).not.toBeNull();
    expect(script!.getAttribute('src')).toMatch(/^https:\/\/unpkg\.com\/react-scan@\d+\.\d+\.\d+\/dist\/auto\.global\.js$/);
    expect(script!.getAttribute('integrity')).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
    // SRI on a cross-origin script only applies to a CORS fetch.
    expect(script!.getAttribute('crossorigin')).toBe('anonymous');
  });

  it('stays out of the page with REACT_SCAN=0', () => {
    process.env.REACT_SCAN = '0';
    expect(transform('<head></head>')).toBe('<head></head>');
  });

  it('only ever applies to the dev server', () => {
    expect(reactScanDev().apply).toBe('serve');
  });
});
