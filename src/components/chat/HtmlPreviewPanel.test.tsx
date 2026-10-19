import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import HtmlPreviewPanel from './HtmlPreviewPanel';
import {
  HTML_PREVIEW_CSP,
  HTML_PREVIEW_PING,
  MAX_MISSED_PINGS,
  PING_INTERVAL_MS,
  READY_GRACE_MS,
} from '@/lib/html-preview';

// jsdom does not run srcdoc documents, so these tests play the srcdoc's
// beacon by hand (window messages from the frame's contentWindow) and fire
// the frame's load events directly. The real thing — scripts, CSP, actual
// navigation — is covered in HtmlPreviewPanel.browser.test.tsx.

const ATT = {
  url: '/api/v1/media/tok/mockup.html',
  downloadURL: '/api/v1/media/tok/mockup.html?download=1',
  filename: 'mockup.html',
};

type FetchReply = { ok: boolean; status: number; text: () => Promise<string> };
function reply(html: string, status = 200): FetchReply {
  return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(html) };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(reply('<h1>Mockup</h1>'));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function frame() {
  return screen.getByTestId('html-preview-frame') as HTMLIFrameElement;
}

function nonceOf(el: HTMLIFrameElement): string {
  return /n="([0-9a-f]{32})"/.exec(el.getAttribute('srcdoc') ?? '')![1];
}

// What the beacon inside the srcdoc posts to the parent.
function beacon(el: HTMLIFrameElement, kind: string, data = `${nonceOf(el)}:${kind}`) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source: el.contentWindow }));
  });
}

async function renderLive(onClose = vi.fn()) {
  const view = render(<HtmlPreviewPanel attachment={ATT} onClose={onClose} />);
  const el = await screen.findByTestId('html-preview-frame');
  beacon(el as HTMLIFrameElement, 'ready');
  // jsdom fires the frame's first load itself; ready + that load → live.
  await waitFor(() => expect(frame()).toHaveAttribute('data-guard', 'live'));
  return view;
}

describe('HtmlPreviewPanel', () => {
  it('fetches the file and renders it in a scripts-only sandbox behind the strict CSP', async () => {
    render(<HtmlPreviewPanel attachment={ATT} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog')).toHaveTextContent('mockup.html');
    expect(screen.getByText('Preview — content runs in an isolated frame')).toBeInTheDocument();
    expect(screen.getByTestId('html-preview-loading')).toHaveTextContent('Loading…');
    expect(screen.getByTestId('html-preview-reload')).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledWith(ATT.url, expect.objectContaining({ credentials: 'same-origin' }));

    const el = (await screen.findByTestId('html-preview-frame')) as HTMLIFrameElement;
    expect(el.getAttribute('sandbox')).toBe('allow-scripts');
    const doc = el.getAttribute('srcdoc')!;
    expect(doc.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`)).toBe(true);
    expect(doc.endsWith('<h1>Mockup</h1>')).toBe(true);
    expect(el).toHaveAttribute('title', 'Preview of mockup.html');
    expect(el).toHaveAttribute('referrerpolicy', 'no-referrer');
  });

  it('keeps the frame hidden until its own document reports ready', async () => {
    render(<HtmlPreviewPanel attachment={ATT} onClose={vi.fn()} />);
    const el = (await screen.findByTestId('html-preview-frame')) as HTMLIFrameElement;
    expect(el).toHaveAttribute('data-guard', 'pending');
    expect(el).toHaveClass('invisible');
    expect(screen.getByTestId('html-preview-verifying')).toHaveTextContent('Loading…');
    beacon(el, 'ready');
    await waitFor(() => expect(el).toHaveAttribute('data-guard', 'live'));
    expect(el).not.toHaveClass('invisible');
    expect(screen.queryByTestId('html-preview-verifying')).toBeNull();
  });

  it('ignores messages without the nonce or from anywhere but the frame', async () => {
    render(<HtmlPreviewPanel attachment={ATT} onClose={vi.fn()} />);
    // Before the frame exists at all.
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: 'x:ready', source: window }));
    });
    const el = (await screen.findByTestId('html-preview-frame')) as HTMLIFrameElement;
    // Right nonce, wrong sender (e.g. another frame or the page itself).
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: `${nonceOf(el)}:ready`, source: window }));
    });
    // Right sender, but whatever the file's own scripts might post.
    beacon(el, 'ready', 'ready');
    beacon(el, 'ready', 'deadbeef:ready');
    await act(async () => {});
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
    // jsdom fires the new frame's load a few microtasks after insertion.
    await act(async () => {});
    await act(async () => {});
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

  it('Reload in the toolbar remounts the frame from the same document', async () => {
    await renderLive();
    const first = frame();
    fireEvent.click(screen.getByTestId('html-preview-reload'));
    const again = frame();
    expect(again).not.toBe(first);
    expect(again.getAttribute('srcdoc')).toBe(first.getAttribute('srcdoc'));
    expect(again).toHaveAttribute('data-guard', 'pending');
    // Same file: no second download.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Settle the new frame's first load.
    await act(async () => {});
  });

  it('shows an error with a retry when the file cannot be fetched', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    render(<HtmlPreviewPanel attachment={ATT} onClose={vi.fn()} />);
    const error = await screen.findByTestId('html-preview-error');
    expect(error).toHaveTextContent("Couldn't load this file");
    expect(screen.queryByTestId('html-preview-frame')).toBeNull();

    fireEvent.click(screen.getByTestId('html-preview-retry'));
    expect(screen.getByTestId('html-preview-loading')).toBeInTheDocument();
    expect(await screen.findByTestId('html-preview-frame')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats an error response as a failed load', async () => {
    fetchMock.mockResolvedValueOnce(reply('expired', 404));
    render(<HtmlPreviewPanel attachment={ATT} onClose={vi.fn()} />);
    expect(await screen.findByTestId('html-preview-error')).toBeInTheDocument();
  });

  it('drops a fetch that settles after the panel closed', async () => {
    let resolveOk!: (r: FetchReply) => void;
    let rejectLate!: (e: Error) => void;
    fetchMock
      .mockReturnValueOnce(new Promise<FetchReply>((r) => { resolveOk = r; }))
      .mockReturnValueOnce(new Promise<FetchReply>((_, j) => { rejectLate = j; }));
    const first = render(<HtmlPreviewPanel attachment={ATT} onClose={vi.fn()} />);
    const second = render(<HtmlPreviewPanel attachment={ATT} onClose={vi.fn()} />);
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    first.unmount();
    second.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      resolveOk(reply('<p>late</p>'));
      rejectLate(new Error('late'));
    });
    expect(screen.queryByTestId('html-preview-frame')).toBeNull();
    expect(screen.queryByTestId('html-preview-error')).toBeNull();
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

  it('downloads through the forced-download URL, falling back to the plain one', async () => {
    // The download link works without the preview ever loading.
    fetchMock.mockReturnValue(new Promise(() => {}));
    const { unmount } = render(<HtmlPreviewPanel attachment={ATT} onClose={vi.fn()} />);
    const link = screen.getByRole('link', { name: 'Download mockup.html' });
    expect(link).toHaveAttribute('href', ATT.downloadURL);
    expect(link).toHaveAttribute('download', 'mockup.html');
    unmount();
    render(<HtmlPreviewPanel attachment={{ url: ATT.url, filename: 'mockup.html' }} onClose={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Download mockup.html' })).toHaveAttribute('href', ATT.url);
  });

  it('closes from the toolbar and on Escape', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const onClose = vi.fn();
    render(<HtmlPreviewPanel attachment={ATT} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  });

  it('keeps presses inside the panel from reaching the message row behind it', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
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
