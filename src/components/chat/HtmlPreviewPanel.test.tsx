import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import HtmlPreviewPanel from './HtmlPreviewPanel';
import { HTML_PREVIEW_PING, MAX_MISSED_PINGS, PING_INTERVAL_MS, READY_GRACE_MS } from '@/lib/html-preview';

// jsdom loads no frame documents, so these tests play the served document's
// beacon by hand (window messages from the frame's contentWindow) and fire
// the frame's load events directly. The real thing — the server's document
// and policy, scripts, actual navigation — is covered in
// HtmlPreviewPanel.browser.test.tsx.

const ATT = {
  url: '/api/v1/media/tok/mockup.html?g=grant',
  downloadURL: '/api/v1/media/tok/mockup.html?download=1',
  filename: 'mockup.html',
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function frame() {
  return screen.getByTestId('html-preview-frame') as HTMLIFrameElement;
}

// The nonce rides in the frame's name; the beacon reads it from window.name.
function nonceOf(el: HTMLIFrameElement): string {
  return el.getAttribute('name')!;
}

// What the beacon inside the served document posts to the parent.
function beacon(el: HTMLIFrameElement, kind: string, data = `${nonceOf(el)}:${kind}`) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source: el.contentWindow }));
  });
}

async function renderLive(onClose = vi.fn()) {
  const view = render(<HtmlPreviewPanel attachment={ATT} onClose={onClose} />);
  const el = await screen.findByTestId('html-preview-frame');
  beacon(el as HTMLIFrameElement, 'ready');
  // jsdom loads no frame src, so the element's first load is fired here;
  // ready + that load → live.
  fireEvent.load(el);
  await waitFor(() => expect(frame()).toHaveAttribute('data-guard', 'live'));
  return view;
}

describe('HtmlPreviewPanel', () => {
  it('frames the preview route in a scripts-only sandbox, named with its nonce', async () => {
    render(<HtmlPreviewPanel attachment={ATT} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog')).toHaveTextContent('mockup.html');
    expect(screen.getByText('Preview — content runs in an isolated frame')).toBeInTheDocument();
    const el = frame();
    // The server's own document for the same media token and grant — never
    // the file's bytes fetched into a srcdoc.
    expect(el).toHaveAttribute('src', '/api/v1/html-preview/tok/mockup.html?g=grant');
    expect(el.hasAttribute('srcdoc')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(el.getAttribute('sandbox')).toBe('allow-scripts');
    expect(nonceOf(el)).toMatch(/^[0-9a-f]{32}$/);
    expect(el).toHaveAttribute('title', 'Preview of mockup.html');
    expect(el).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(screen.getByTestId('html-preview-reload')).toBeEnabled();
  });

  it('keeps the frame hidden until its own document reports ready', async () => {
    render(<HtmlPreviewPanel attachment={ATT} onClose={vi.fn()} />);
    const el = (await screen.findByTestId('html-preview-frame')) as HTMLIFrameElement;
    expect(el).toHaveAttribute('data-guard', 'pending');
    expect(el).toHaveClass('invisible');
    expect(screen.getByTestId('html-preview-verifying')).toHaveTextContent('Loading…');
    fireEvent.load(el);
    expect(el).toHaveAttribute('data-guard', 'pending');
    beacon(el, 'ready');
    await waitFor(() => expect(el).toHaveAttribute('data-guard', 'live'));
    expect(el).not.toHaveClass('invisible');
    expect(screen.queryByTestId('html-preview-verifying')).toBeNull();
  });

  it('ignores messages without the nonce or from anywhere but the frame', async () => {
    render(<HtmlPreviewPanel attachment={ATT} onClose={vi.fn()} />);
    const el = (await screen.findByTestId('html-preview-frame')) as HTMLIFrameElement;
    // Right nonce, wrong sender (e.g. another frame or the page itself).
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: `${nonceOf(el)}:ready`, source: window }));
    });
    // Right sender, but whatever the file's own scripts might post — or a
    // document the file navigated to, whose frame name was already wiped.
    beacon(el, 'ready', 'ready');
    beacon(el, 'ready', 'deadbeef:ready');
    beacon(el, 'failed', ':failed');
    fireEvent.load(el);
    expect(el).toHaveAttribute('data-guard', 'pending');
  });

  it('closes the frame when it loads a second time (navigated away) and reloads on request', async () => {
    await renderLive();
    const first = frame();
    fireEvent.load(first);
    expect(screen.queryByTestId('html-preview-frame')).toBeNull();
    expect(screen.getByTestId('html-preview-navigated')).toHaveTextContent(
      'This preview tried to open another page, so it was closed.',
    );

    fireEvent.click(screen.getByTestId('html-preview-reload-notice'));
    const again = await screen.findByTestId('html-preview-frame');
    expect(again).not.toBe(first);
    // A fresh frame must prove itself again.
    expect(again).toHaveAttribute('data-guard', 'pending');
    fireEvent.load(again);
    beacon(again as HTMLIFrameElement, 'ready');
    await waitFor(() => expect(again).toHaveAttribute('data-guard', 'live'));
  });

  it('closes the frame when its document reports it is going away', async () => {
    await renderLive();
    beacon(frame(), 'gone');
    expect(screen.queryByTestId('html-preview-frame')).toBeNull();
    expect(screen.getByTestId('html-preview-navigated')).toBeInTheDocument();
  });

  it('closes a frame that loaded but never reported ready (navigated before its own load)', async () => {
    await renderLive();
    // From here only setTimeout is faked (the dialog has settled; RTL and the
    // liveness interval stay on real time). Reload: a fresh frame that loads
    // but whose document never says ready.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.click(screen.getByTestId('html-preview-reload'));
    fireEvent.load(frame());
    act(() => {
      vi.advanceTimersByTime(READY_GRACE_MS - 1);
    });
    expect(frame()).toHaveAttribute('data-guard', 'pending');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByTestId('html-preview-frame')).toBeNull();
    expect(screen.getByTestId('html-preview-navigated')).toBeInTheDocument();
  });

  it('pings the shown frame and keeps it while it answers, closing it once it falls silent', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderLive();
    const el = frame();
    let answering = true;
    const pings: unknown[] = [];
    el.contentWindow!.addEventListener('message', (e) => {
      pings.push(e.data);
      if (answering) beacon(el, 'alive');
    });

    for (let i = 0; i < MAX_MISSED_PINGS + 2; i++) {
      act(() => {
        vi.advanceTimersByTime(PING_INTERVAL_MS);
      });
      // jsdom delivers postMessage on a task.
      await waitFor(() => expect(pings).toHaveLength(i + 1));
    }
    expect(pings[0]).toBe(HTML_PREVIEW_PING);
    expect(frame()).toHaveAttribute('data-guard', 'live');

    answering = false;
    for (let i = 0; i <= MAX_MISSED_PINGS; i++) {
      act(() => {
        vi.advanceTimersByTime(PING_INTERVAL_MS);
      });
    }
    expect(screen.queryByTestId('html-preview-frame')).toBeNull();
    expect(screen.getByTestId('html-preview-navigated')).toBeInTheDocument();
  });

  it('Reload in the toolbar remounts the frame on the same document and nonce', async () => {
    await renderLive();
    const first = frame();
    fireEvent.click(screen.getByTestId('html-preview-reload'));
    const again = frame();
    expect(again).not.toBe(first);
    expect(again.getAttribute('src')).toBe(first.getAttribute('src'));
    expect(nonceOf(again)).toBe(nonceOf(first));
    expect(again).toHaveAttribute('data-guard', 'pending');
  });

  it('shows an error with a retry when the server has no file to show', async () => {
    render(<HtmlPreviewPanel attachment={ATT} onClose={vi.fn()} />);
    const first = (await screen.findByTestId('html-preview-frame')) as HTMLIFrameElement;
    fireEvent.load(first);
    beacon(first, 'failed');
    const error = screen.getByTestId('html-preview-error');
    expect(error).toHaveTextContent("Couldn't load this file");
    expect(screen.queryByTestId('html-preview-frame')).toBeNull();
    expect(screen.queryByTestId('html-preview-navigated')).toBeNull();

    fireEvent.click(screen.getByTestId('html-preview-retry'));
    const again = await screen.findByTestId('html-preview-frame');
    expect(again).not.toBe(first);
    expect(again).toHaveAttribute('data-guard', 'pending');
    fireEvent.load(again);
    beacon(again as HTMLIFrameElement, 'ready');
    await waitFor(() => expect(again).toHaveAttribute('data-guard', 'live'));
  });

  it('has nothing to frame for a URL that is not one of our media URLs', () => {
    render(
      <HtmlPreviewPanel attachment={{ url: 'https://bucket.s3.example.com/attachments/a', filename: 'mockup.html' }} onClose={vi.fn()} />,
    );
    expect(screen.getByTestId('html-preview-error')).toHaveTextContent("Couldn't load this file");
    expect(screen.queryByTestId('html-preview-retry')).toBeNull();
    expect(screen.queryByTestId('html-preview-frame')).toBeNull();
    expect(screen.getByTestId('html-preview-reload')).toBeDisabled();
    // The download still works.
    expect(screen.getByRole('link', { name: 'Download mockup.html' })).toHaveAttribute(
      'href',
      'https://bucket.s3.example.com/attachments/a',
    );
  });

  it('switches the frame between desktop, tablet and phone widths', async () => {
    await renderLive();
    const stage = screen.getByTestId('html-preview-stage');
    expect(frame().style.width).toBe('100%');
    expect(screen.getByTestId('html-preview-width-desktop')).toHaveAttribute('aria-pressed', 'true');
    expect(stage).not.toHaveClass('p-4');

    fireEvent.click(screen.getByRole('button', { name: 'Tablet width (768px)' }));
    expect(frame().style.width).toBe('768px');
    expect(screen.getByTestId('html-preview-width-tablet')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('html-preview-width-desktop')).toHaveAttribute('aria-pressed', 'false');
    expect(stage).toHaveClass('p-4');

    fireEvent.click(screen.getByRole('button', { name: 'Phone width (390px)' }));
    expect(frame().style.width).toBe('390px');

    fireEvent.click(screen.getByRole('button', { name: 'Desktop width' }));
    expect(frame().style.width).toBe('100%');
    // Changing width never reloads the document.
    expect(frame()).toHaveAttribute('data-guard', 'live');
  });

  it('downloads through the forced-download URL, falling back to the plain one', () => {
    // The download link works without the preview ever loading.
    const { unmount } = render(<HtmlPreviewPanel attachment={ATT} onClose={vi.fn()} />);
    const link = screen.getByRole('link', { name: 'Download mockup.html' });
    expect(link).toHaveAttribute('href', ATT.downloadURL);
    expect(link).toHaveAttribute('download', 'mockup.html');
    unmount();
    render(<HtmlPreviewPanel attachment={{ url: ATT.url, filename: 'mockup.html' }} onClose={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Download mockup.html' })).toHaveAttribute('href', ATT.url);
  });

  it('closes from the toolbar and on Escape', async () => {
    const onClose = vi.fn();
    render(<HtmlPreviewPanel attachment={ATT} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  });

  it('keeps presses inside the panel from reaching the message row behind it', () => {
    const onPointerDown = vi.fn();
    const onContextMenu = vi.fn();
    render(
      <div onPointerDown={onPointerDown} onContextMenu={onContextMenu}>
        <HtmlPreviewPanel attachment={ATT} onClose={vi.fn()} />
      </div>,
    );
    const close = screen.getByRole('button', { name: 'Close preview' });
    fireEvent.pointerDown(close);
    fireEvent.contextMenu(close);
    expect(onPointerDown).not.toHaveBeenCalled();
    expect(onContextMenu).not.toHaveBeenCalled();
  });
});
