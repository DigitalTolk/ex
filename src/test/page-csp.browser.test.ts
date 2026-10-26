import { afterEach, describe, expect, it } from 'vitest';

// The app page's Content-Security-Policy exactly as the Go server builds it
// — from its golden, served at /__csp-probe by src/test/html-preview-server.ts
// — checked in real engines: the page's own inline script runs by hash and
// no other inline script runs at all, and the page may frame the
// HTML-preview route and no other path of its own origin.

type ProbeMessage =
  | { csp: 'hashed' | 'unhashed' }
  | { csp: 'violation'; directive: string; blocked: string }
  | { csp: 'child'; data: unknown };

let probe: HTMLIFrameElement | null = null;
let listener: ((e: MessageEvent) => void) | null = null;

afterEach(() => {
  if (listener) window.removeEventListener('message', listener);
  probe?.remove();
  probe = null;
  listener = null;
});

describe('app page CSP', () => {
  it('runs only hashed inline scripts and frames only the preview route', async () => {
    const messages: ProbeMessage[] = [];
    listener = (e: MessageEvent) => {
      if (e.source === probe?.contentWindow && (e.data as { csp?: unknown })?.csp) messages.push(e.data as ProbeMessage);
    };
    window.addEventListener('message', listener);
    probe = document.createElement('iframe');
    probe.src = '/__csp-probe';
    document.body.append(probe);

    const summary = () => ({
      hashedRan: messages.some((m) => m.csp === 'hashed'),
      unhashedRan: messages.some((m) => m.csp === 'unhashed'),
      inlineBlocked: messages.some((m) => m.csp === 'violation' && m.directive.startsWith('script-src') && m.blocked === 'inline'),
      framesBlocked: messages.flatMap((m) =>
        m.csp === 'violation' && m.directive === 'frame-src' ? [new URL(m.blocked, location.href).pathname] : [],
      ),
      // The preview frame's beacon, relayed by the page: it loaded and ran.
      previewLoaded: messages.some((m) => m.csp === 'child' && m.data === 'probe:ready'),
    });
    await expect.poll(summary, { timeout: 5000 }).toEqual({
      hashedRan: true,
      unhashedRan: false,
      inlineBlocked: true,
      framesBlocked: ['/favicon.svg'],
      previewLoaded: true,
    });
  });
});
