import { describe, it, expect } from 'vitest';
import { inAppRouteTarget } from './in-app-link';

const ORIGIN = 'https://ex.digitaltolk.net';

describe('inAppRouteTarget', () => {
  it('routes a same-origin permalink, preserving path + query + hash', () => {
    expect(
      inAppRouteTarget(`${ORIGIN}/channel/service-status#msg-01KV8DRDNYPP`, ORIGIN),
    ).toBe('/channel/service-status#msg-01KV8DRDNYPP');
    expect(
      inAppRouteTarget(`${ORIGIN}/channel/eng?thread=root#msg-reply`, ORIGIN),
    ).toBe('/channel/eng?thread=root#msg-reply');
    expect(inAppRouteTarget(`${ORIGIN}/conversation/conv-1#msg-9`, ORIGIN)).toBe(
      '/conversation/conv-1#msg-9',
    );
  });

  it('treats an absolute same-origin path as in-app', () => {
    // The handler always passes the anchor's resolved absolute .href, so a
    // hash-only link arrives here already merged onto its page path.
    expect(inAppRouteTarget('/channel/general', ORIGIN)).toBe('/channel/general');
    expect(inAppRouteTarget(`${ORIGIN}/channel/general#msg-5`, ORIGIN)).toBe('/channel/general#msg-5');
  });

  it('returns null for external origins (kept as new-tab links)', () => {
    expect(inAppRouteTarget('https://example.com/x', ORIGIN)).toBeNull();
    expect(inAppRouteTarget('http://ex.digitaltolk.net/channel/x', ORIGIN)).toBeNull(); // scheme differs
    expect(inAppRouteTarget('https://other.digitaltolk.net/channel/x', ORIGIN)).toBeNull();
  });

  it('returns null for backend routes the server serves, not the SPA router', () => {
    expect(inAppRouteTarget(`${ORIGIN}/api/v1/attachments/abc`, ORIGIN)).toBeNull();
    expect(inAppRouteTarget(`${ORIGIN}/auth/oidc/callback`, ORIGIN)).toBeNull();
  });

  it('returns null for unparseable hrefs', () => {
    expect(inAppRouteTarget('http://[bad', ORIGIN)).toBeNull();
  });
});
