import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import HtmlPreviewPanel from './HtmlPreviewPanel';
import { MAX_MISSED_PINGS, PING_INTERVAL_MS, READY_GRACE_MS } from '@/lib/html-preview';

// The preview's security claims, checked in real engines (Chromium + WebKit)
// against what the Go server serves (src/test/html-preview-server.ts plays
// its preview route from the server's golden): the file's scripts run, but
// in an opaque origin with no network, and a frame that navigates anywhere
// is taken down — including the navigation that happens before the
// document's own load, which a plain load counter cannot see.

const mounted: Array<{ unmount: () => Promise<void> }> = [];
const listeners: Array<(e: MessageEvent) => void> = [];

afterEach(async () => {
  for (const m of mounted.splice(0)) await m.unmount();
  for (const l of listeners.splice(0)) window.removeEventListener('message', l);
  vi.restoreAllMocks();
});

// The test server serves a token of `f.<base64url file>` as that file.
function fileToken(html: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(html)) bin += String.fromCharCode(b);
  return `f.${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

async function mountURL(url: string) {
  const screen = await render(<HtmlPreviewPanel attachment={{ url, filename: 'mockup.html' }} onClose={() => {}} />);
  mounted.push(screen);
  return screen;
}

const mount = (html: string) => mountURL(`/api/v1/media/${fileToken(html)}/mockup.html`);

// What the mockup's own scripts post to the page (the panel ignores these).
function mockupMessages() {
  const got: unknown[] = [];
  const listener = (e: MessageEvent) => got.push(e.data);
  window.addEventListener('message', listener);
  listeners.push(listener);
  return got;
}

const frame = () => document.querySelector<HTMLIFrameElement>('[data-testid="html-preview-frame"]');
const notice = () => document.querySelector('[data-testid="html-preview-navigated"]');
// A same-server URL the frame can actually navigate to: this test page has
// no CSP, so the guard alone must catch it (in the app, frame-src refuses it
// first — see src/test/page-csp.browser.test.ts).
const outside = (tag: string) => `${window.location.origin}/favicon.ico?${tag}`;
const SETTLE = { timeout: 5000 };
const CLOSE = { timeout: READY_GRACE_MS + PING_INTERVAL_MS * (MAX_MISSED_PINGS + 4) };

describe('HtmlPreviewPanel in a real browser', () => {
  it('shows the mockup and runs its scripts, isolated from the chat origin', async () => {
    // A cookie on the page the mockup must not see.
    document.cookie = 'ex_preview_probe=1; path=/';
    const messages = mockupMessages();
    await mount(`<h1>Mockup</h1><script>
      var r = {};
      try { r.parentDocument = String(!!parent.document); } catch (e) { r.parentDocument = e.name; }
      try { r.cookie = String(document.cookie); } catch (e) { r.cookie = e.name; }
      try { r.storage = String(!!localStorage); } catch (e) { r.storage = e.name; }
      r.origin = origin;
      parent.postMessage({ mockup: r }, '*');
    </script>`);
    await expect.poll(() => frame()?.dataset.guard, SETTLE).toBe('live');
    const el = frame()!;
    expect(el.getAttribute('sandbox')).toBe('allow-scripts');
    expect(getComputedStyle(el).visibility).toBe('visible');
    expect(el.getBoundingClientRect().height).toBeGreaterThan(100);
    await expect.poll(() => messages.find((m) => (m as { mockup?: unknown }).mockup)).toBeTruthy();
    const { mockup } = messages.find((m) => (m as { mockup?: unknown }).mockup) as { mockup: Record<string, string> };
    expect(mockup).toMatchObject({ parentDocument: 'SecurityError', storage: 'SecurityError', origin: 'null' });
    // Chromium throws on an opaque origin's cookie jar; WebKit hands back an
    // empty one. Either way the page's cookie is out of reach.
    expect(['SecurityError', '']).toContain(mockup.cookie);
    document.cookie = 'ex_preview_probe=; path=/; max-age=0';
  });

  it('keeps the guard nonce out of reach of the mockup', async () => {
    const messages = mockupMessages();
    await mount(`<p>Mockup</p><script>
      parent.postMessage({ probe: { name: window.name, scripts: document.scripts.length } }, '*');
    </script>`);
    await expect.poll(() => frame()?.dataset.guard, SETTLE).toBe('live');
    await expect.poll(() => messages.find((m) => (m as { probe?: unknown }).probe)).toBeTruthy();
    const { probe } = messages.find((m) => (m as { probe?: unknown }).probe) as { probe: { name: string; scripts: number } };
    // The frame was named with the nonce; the beacon took it and wiped the
    // name, then removed itself, before the file's first script ran.
    expect(frame()!.name).toMatch(/^[0-9a-f]{32}$/);
    expect(probe).toEqual({ name: '', scripts: 1 });
  });

  it('shows the error state when the server has no file to show, and retries', async () => {
    // Every frame the panel inserts, so the retry's own frame is seen even
    // if it fails before a poll would catch it.
    const frames = new Set<HTMLIFrameElement>();
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (!(n instanceof Element)) continue;
          // The first frame arrives inside the dialog's whole subtree.
          if (n instanceof HTMLIFrameElement) frames.add(n);
          n.querySelectorAll('iframe').forEach((f) => frames.add(f));
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const error = () => document.querySelector('[data-testid="html-preview-error"]');
    try {
      const screen = await mountURL('/api/v1/media/expired/mockup.html');
      await expect.poll(error, SETTLE).not.toBeNull();
      expect(frame()).toBeNull();
      expect(notice()).toBeNull();
      const before = frames.size;
      await screen.getByTestId('html-preview-retry').click();
      await expect.poll(() => frames.size, SETTLE).toBe(before + 1);
      await expect.poll(error, SETTLE).not.toBeNull();
      expect(notice()).toBeNull();
    } finally {
      observer.disconnect();
    }
  });

  it('blocks network requests and outside images from the mockup', async () => {
    const messages = mockupMessages();
    await mount(`<script>
      document.addEventListener('securitypolicyviolation', function (e) {
        parent.postMessage({ blocked: e.effectiveDirective }, '*');
      });
      fetch('https://example.invalid/beacon').catch(function () {});
      new Image().src = 'https://example.invalid/pixel.png';
    </script>`);
    const blocked = () => messages.map((m) => (m as { blocked?: string }).blocked).filter(Boolean).sort();
    await expect.poll(blocked, SETTLE).toEqual(['connect-src', 'img-src']);
  });

  it('never shows a page the file navigated to before its own load', async () => {
    await mount(`<script>location.href = ${JSON.stringify(outside('early'))};</script><p>x</p>`);
    const seen = new Set<string>();
    const watch = setInterval(() => {
      const g = frame()?.dataset.guard;
      if (g) seen.add(g);
    }, 10);
    try {
      await expect.poll(notice, CLOSE).not.toBeNull();
    } finally {
      clearInterval(watch);
    }
    expect(frame()).toBeNull();
    expect(seen.has('live')).toBe(false);
  });

  it('closes the frame when a link in it is followed, and Reload brings the mockup back', async () => {
    const screen = await mount(`<a id="next" href="${outside('link')}">Next screen</a><script>
      addEventListener('message', function (e) { if (e.data === 'follow') document.getElementById('next').click(); });
    </script>`);
    await expect.poll(() => frame()?.dataset.guard, SETTLE).toBe('live');
    frame()!.contentWindow!.postMessage('follow', '*');
    await expect.poll(notice, CLOSE).not.toBeNull();
    expect(notice()!.textContent).toContain('This preview tried to open another page, so it was closed.');
    expect(frame()).toBeNull();

    await screen.getByTestId('html-preview-reload-notice').click();
    await expect.poll(() => frame()?.dataset.guard, SETTLE).toBe('live');
  });

  it('keeps a well-behaved mockup on screen across liveness pings', async () => {
    await mount('<p>Still here</p>');
    await expect.poll(() => frame()?.dataset.guard, SETTLE).toBe('live');
    await new Promise((r) => setTimeout(r, PING_INTERVAL_MS * (MAX_MISSED_PINGS + 1.5)));
    expect(frame()?.dataset.guard).toBe('live');
  });

  it('closes a frame whose document stops answering (its listeners were wiped)', async () => {
    await mount(`<p>Mockup</p><script>
      addEventListener('message', function (e) {
        if (e.data === 'wipe') { document.open(); document.write('<p>replaced</p>'); }
      });
    </script>`);
    await expect.poll(() => frame()?.dataset.guard, SETTLE).toBe('live');
    frame()!.contentWindow!.postMessage('wipe', '*');
    await expect.poll(notice, CLOSE).not.toBeNull();
  });

  it('is a full-screen sheet on phones and a large dialog with width presets elsewhere', async () => {
    const screen = await mount('<p>Layout</p>');
    await expect.poll(() => frame()?.dataset.guard, SETTLE).toBe('live');
    const panel = document.querySelector<HTMLElement>('[data-testid="html-preview-panel"]')!;
    // Measured once the dialog's zoom-in has finished.
    const size = () => {
      const rect = panel.getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const widths = document.querySelector<HTMLElement>('[role="group"][aria-label="Preview width"]')!;
    if (document.documentElement.classList.contains('tier-mobile')) {
      await expect.poll(size, SETTLE).toEqual({ width: window.innerWidth, height: window.innerHeight });
      expect(getComputedStyle(widths).display).toBe('none');
      return;
    }
    await expect.poll(() => size().width / window.innerWidth, SETTLE).toBeGreaterThan(0.8);
    expect(size().height).toBeGreaterThan(window.innerHeight * 0.8);
    await screen.getByRole('button', { name: 'Phone width (390px)' }).click();
    expect(Math.round(frame()!.getBoundingClientRect().width)).toBe(390);
    expect(frame()?.dataset.guard).toBe('live');
  });
});
