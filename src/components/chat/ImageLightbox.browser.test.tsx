import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { ImageLightbox } from './ImageLightbox';
import { expectPaintedAtCenter } from '@/test/browser-assertions';
import type { ComponentProps } from 'react';

const imageURL = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#3b82f6"/><circle cx="600" cy="400" r="180" fill="#f8fafc"/></svg>',
)}`;

const nextImageURL = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#16a34a"/><circle cx="600" cy="400" r="180" fill="#f8fafc"/></svg>',
)}`;

function lightbox(overrides: Partial<ComponentProps<typeof ImageLightbox>> = {}) {
  return (
    <ImageLightbox
      open
      onClose={vi.fn()}
      images={[{
        url: imageURL,
        filename: 'photo.png',
        contentType: 'image/png',
        size: 2048,
      }]}
      index={0}
      onIndexChange={vi.fn()}
      authorName="Alice"
      postedAt="2026-05-08T10:00:00.000Z"
      {...overrides}
    />
  );
}

function dispatchSwipe(element: Element, from: { x: number; y: number }, to: { x: number; y: number }) {
  element.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: from.x, clientY: from.y, bubbles: true }));
  element.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'touch', clientX: to.x, clientY: to.y, bubbles: true }));
  element.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, pointerType: 'touch', clientX: to.x, clientY: to.y, bubbles: true }));
}

function dispatchSwipeStartAndMove(element: Element, from: { x: number; y: number }, to: { x: number; y: number }) {
  element.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: from.x, clientY: from.y, bubbles: true }));
  element.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'touch', clientX: to.x, clientY: to.y, bubbles: true }));
}

function dispatchPointerTap(element: Element, point: { x: number; y: number }, pointerId = 11) {
  element.dispatchEvent(new PointerEvent('pointerdown', {
    pointerId,
    pointerType: 'touch',
    clientX: point.x,
    clientY: point.y,
    bubbles: true,
    cancelable: true,
  }));
  element.dispatchEvent(new PointerEvent('pointerup', {
    pointerId,
    pointerType: 'touch',
    clientX: point.x,
    clientY: point.y,
    bubbles: true,
    cancelable: true,
  }));
}

describe('ImageLightbox browser behavior', () => {
  afterEach(() => cleanup());

  it('zooms against the full overlay stage instead of a small scroll box', async () => {
    const screen = await render(lightbox());
    const stage = document.querySelector('[data-testid="image-lightbox-zoom-stage"]') as HTMLElement | null;
    const image = document.querySelector('[data-testid="image-lightbox-image"]') as HTMLImageElement | null;
    expect(stage).not.toBeNull();
    expect(image).not.toBeNull();

    await vi.waitFor(() => {
      expect(image!.getBoundingClientRect().width).toBeGreaterThan(0);
    });

    const stageRect = stage!.getBoundingClientRect();
    const lightboxRect = document.querySelector('[data-testid="image-lightbox"]')!.getBoundingClientRect();
    expect(stageRect.width).toBeGreaterThan(window.innerWidth * 0.9);
    expect(stageRect.height).toBeGreaterThan(lightboxRect.height * 0.55);
    expectPaintedAtCenter(stage!, '[data-testid="image-lightbox-zoom-stage"]');

    const before = image!.getBoundingClientRect();
    await screen.getByTestId('image-lightbox-zoom-in').click();

    await vi.waitFor(() => {
      expect(Number(image!.dataset.zoom)).toBeGreaterThan(1.5);
      expect(image!.getBoundingClientRect().width).toBeGreaterThan(before.width * 1.4);
    });
  });

  it('supports real two-pointer pinch expansion', async () => {
    await render(lightbox());
    const stage = document.querySelector('[data-testid="image-lightbox-zoom-stage"]') as HTMLElement | null;
    const image = document.querySelector('[data-testid="image-lightbox-image"]') as HTMLImageElement | null;
    expect(stage).not.toBeNull();
    expect(image).not.toBeNull();

    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;
    stage!.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: centerX - 35, clientY: centerY, bubbles: true }));
    stage!.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: centerX + 35, clientY: centerY, bubbles: true }));
    stage!.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'touch', clientX: centerX - 130, clientY: centerY, bubbles: true }));
    stage!.dispatchEvent(new PointerEvent('pointermove', { pointerId: 2, pointerType: 'touch', clientX: centerX + 130, clientY: centerY, bubbles: true }));
    stage!.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, pointerType: 'touch', clientX: centerX - 130, clientY: centerY, bubbles: true }));
    stage!.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2, pointerType: 'touch', clientX: centerX + 130, clientY: centerY, bubbles: true }));

    await vi.waitFor(() => {
      expect(Number(image!.dataset.zoom)).toBeGreaterThan(2);
    });
  });

  it('closes on a mobile downward swipe', async () => {
    if (window.innerWidth > 767) return;
    const onClose = vi.fn();
    await render(lightbox({ onClose }));
    const stage = document.querySelector('[data-testid="image-lightbox-zoom-stage"]') as HTMLElement | null;
    expect(stage).not.toBeNull();

    dispatchSwipe(stage!, { x: window.innerWidth / 2, y: 220 }, { x: window.innerWidth / 2 + 8, y: 360 });

    await vi.waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce();
    });
  });

  it('does not activate swipe close or navigation on desktop', async () => {
    if (window.innerWidth <= 767) return;
    const onClose = vi.fn();
    const onIndexChange = vi.fn();
    await render(lightbox({
      onClose,
      images: [
        { url: imageURL, filename: 'one.png', contentType: 'image/png', size: 2048 },
        { url: nextImageURL, filename: 'two.png', contentType: 'image/png', size: 2048 },
      ],
      onIndexChange,
    }));
    const stage = document.querySelector('[data-testid="image-lightbox-zoom-stage"]') as HTMLElement | null;
    expect(stage).not.toBeNull();

    dispatchSwipeStartAndMove(stage!, { x: 500, y: 260 }, { x: 500, y: 420 });
    expect(stage!.style.transform).not.toContain('translate3d');
    stage!.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, pointerType: 'touch', clientX: 500, clientY: 420, bubbles: true }));

    dispatchSwipe(stage!, { x: 520, y: 360 }, { x: 260, y: 350 });
    expect(onClose).not.toHaveBeenCalled();
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it('shows drag feedback before closing on a mobile downward swipe', async () => {
    if (window.innerWidth > 767) return;
    const onClose = vi.fn();
    await render(lightbox({ onClose }));
    const stage = document.querySelector('[data-testid="image-lightbox-zoom-stage"]') as HTMLElement | null;
    expect(stage).not.toBeNull();

    dispatchSwipeStartAndMove(stage!, { x: window.innerWidth / 2, y: 220 }, { x: window.innerWidth / 2 + 8, y: 330 });

    await vi.waitFor(() => {
      expect(stage!.style.transform).toContain('translate3d');
    });
    stage!.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, pointerType: 'touch', clientX: window.innerWidth / 2 + 8, clientY: 330, bubbles: true }));
    await vi.waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce();
    });
  });

  it('navigates between images on mobile horizontal swipes', async () => {
    if (window.innerWidth > 767) return;
    const onIndexChange = vi.fn();
    await render(lightbox({
      images: [
        { url: imageURL, filename: 'one.png', contentType: 'image/png', size: 2048 },
        { url: nextImageURL, filename: 'two.png', contentType: 'image/png', size: 2048 },
      ],
      onIndexChange,
    }));
    const stage = document.querySelector('[data-testid="image-lightbox-zoom-stage"]') as HTMLElement | null;
    expect(stage).not.toBeNull();

    dispatchSwipe(stage!, { x: 300, y: 360 }, { x: 120, y: 350 });
    await vi.waitFor(() => {
      expect(onIndexChange).toHaveBeenCalledWith(1);
    });

    onIndexChange.mockClear();
    dispatchSwipe(stage!, { x: 120, y: 360 }, { x: 300, y: 350 });
    await vi.waitFor(() => {
      expect(onIndexChange).toHaveBeenCalledWith(1);
    });
  });

  it('pans a zoomed image instead of treating horizontal movement as navigation', async () => {
    if (window.innerWidth > 767) return;
    const onIndexChange = vi.fn();
    const screen = await render(lightbox({
      images: [
        { url: imageURL, filename: 'one.png', contentType: 'image/png', size: 2048 },
        { url: nextImageURL, filename: 'two.png', contentType: 'image/png', size: 2048 },
      ],
      onIndexChange,
    }));
    const stage = document.querySelector('[data-testid="image-lightbox-zoom-stage"]') as HTMLElement | null;
    const image = document.querySelector('[data-testid="image-lightbox-image"]') as HTMLImageElement | null;
    expect(stage).not.toBeNull();
    expect(image).not.toBeNull();

    await screen.getByTestId('image-lightbox-zoom-in').click();
    await vi.waitFor(() => {
      expect(Number(image!.dataset.zoom)).toBeGreaterThan(1);
    });

    dispatchSwipe(stage!, { x: 120, y: 360 }, { x: 310, y: 350 });

    await vi.waitFor(() => {
      expect(Number(image!.dataset.panX)).toBeGreaterThan(100);
    });
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it('a double tap on a non-image attachment never triggers the zoom toggle (mobile)', async () => {
    if (window.innerWidth > 767) return;
    await render(lightbox({
      images: [{ url: imageURL, filename: 'archive.zip', contentType: 'application/zip', size: 4096 }],
    }));
    const stage = document.querySelector('[data-testid="image-lightbox-attachment-stage"]') as HTMLElement | null;
    expect(stage).not.toBeNull();

    // Two quick taps: handleMobileTap bails for non-images (nothing to zoom),
    // so the overlay stays put and no zoomed image ever appears.
    dispatchPointerTap(stage!, { x: window.innerWidth / 2, y: window.innerHeight / 2 }, 31);
    dispatchPointerTap(stage!, { x: window.innerWidth / 2 + 10, y: window.innerHeight / 2 + 4 }, 32);
    await new Promise((r) => setTimeout(r, 60));
    expect(document.querySelector('[data-testid="image-lightbox"]')).not.toBeNull();
    const img = document.querySelector('[data-testid="image-lightbox-image"]') as HTMLImageElement | null;
    expect(Number(img?.dataset.zoom ?? '1')).toBe(1);
  });

  it('toggles mobile image zoom and pan reset on double tap', async () => {
    if (window.innerWidth > 767) return;

    await render(lightbox());
    const stage = document.querySelector('[data-testid="image-lightbox-zoom-stage"]') as HTMLElement | null;
    const image = document.querySelector('[data-testid="image-lightbox-image"]') as HTMLImageElement | null;
    expect(stage).not.toBeNull();
    expect(image).not.toBeNull();

    // First two taps from idle: zoom should jump to 2x.
    dispatchPointerTap(stage!, { x: window.innerWidth / 2, y: window.innerHeight / 2 }, 21);
    dispatchPointerTap(stage!, { x: window.innerWidth / 2 + 42, y: window.innerHeight / 2 + 8 }, 22);
    await vi.waitFor(() => {
      expect(Number(image!.dataset.zoom)).toBeGreaterThan(1);
    });

    // Drag to introduce pan offset so the reset path actually has
    // something to clear on the next double-tap.
    dispatchSwipe(stage!, { x: 120, y: 360 }, { x: 250, y: 330 });
    await vi.waitFor(() => {
      expect(Math.abs(Number(image!.dataset.panX))).toBeGreaterThan(50);
    });

    // Second double-tap while zoomed/panned: must snap back to 1x and
    // zero out pan (no half-state).
    dispatchPointerTap(stage!, { x: window.innerWidth / 2, y: window.innerHeight / 2 }, 23);
    dispatchPointerTap(stage!, { x: window.innerWidth / 2 + 42, y: window.innerHeight / 2 + 8 }, 24);
    await vi.waitFor(() => {
      expect(Number(image!.dataset.zoom)).toBe(1);
      expect(Number(image!.dataset.panX)).toBe(0);
      expect(Number(image!.dataset.panY)).toBe(0);
    });
  });

  it('does not zoom when a single tap is followed by a long pause (>450ms)', async () => {
    if (window.innerWidth > 767) return;

    await render(lightbox());
    const stage = document.querySelector('[data-testid="image-lightbox-zoom-stage"]') as HTMLElement | null;
    const image = document.querySelector('[data-testid="image-lightbox-image"]') as HTMLImageElement | null;
    expect(stage).not.toBeNull();
    expect(image).not.toBeNull();

    dispatchPointerTap(stage!, { x: window.innerWidth / 2, y: window.innerHeight / 2 }, 31);
    await new Promise((resolve) => setTimeout(resolve, 500));
    dispatchPointerTap(stage!, { x: window.innerWidth / 2, y: window.innerHeight / 2 }, 32);

    // Give React a tick to flush any zoom state change.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(Number(image!.dataset.zoom)).toBe(1);
  });

  it('does not treat a finger-drag-then-release as a tap', async () => {
    if (window.innerWidth > 767) return;

    await render(lightbox());
    const stage = document.querySelector('[data-testid="image-lightbox-zoom-stage"]') as HTMLElement | null;
    const image = document.querySelector('[data-testid="image-lightbox-image"]') as HTMLImageElement | null;
    expect(stage).not.toBeNull();
    expect(image).not.toBeNull();

    // First tap is a clean tap. Second "tap" actually drags >12px,
    // so the snapshot is invalidated and double-tap zoom must NOT fire.
    dispatchPointerTap(stage!, { x: window.innerWidth / 2, y: window.innerHeight / 2 }, 41);
    stage!.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 42, pointerType: 'touch',
      clientX: window.innerWidth / 2, clientY: window.innerHeight / 2,
      bubbles: true,
    }));
    stage!.dispatchEvent(new PointerEvent('pointermove', {
      pointerId: 42, pointerType: 'touch',
      clientX: window.innerWidth / 2 + 30, clientY: window.innerHeight / 2 + 30,
      bubbles: true,
    }));
    stage!.dispatchEvent(new PointerEvent('pointerup', {
      pointerId: 42, pointerType: 'touch',
      clientX: window.innerWidth / 2 + 30, clientY: window.innerHeight / 2 + 30,
      bubbles: true,
    }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(Number(image!.dataset.zoom)).toBe(1);
  });

  it('supports swipe navigation and close gestures on non-image attachments', async () => {
    if (window.innerWidth > 767) return;
    const onClose = vi.fn();
    const onIndexChange = vi.fn();
    await render(lightbox({
      onClose,
      images: [
        { url: 'https://cdn.example.test/report.pdf', filename: 'report.pdf', contentType: 'application/pdf', size: 4096 },
        { url: imageURL, filename: 'one.png', contentType: 'image/png', size: 2048 },
      ],
      onIndexChange,
    }));
    const stage = document.querySelector('[data-testid="image-lightbox-attachment-stage"]') as HTMLElement | null;
    expect(stage).not.toBeNull();

    dispatchSwipeStartAndMove(stage!, { x: 300, y: 360 }, { x: 130, y: 350 });
    await vi.waitFor(() => {
      expect(stage!.style.transform).toContain('translate3d');
    });
    stage!.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, pointerType: 'touch', clientX: 130, clientY: 350, bubbles: true }));
    await vi.waitFor(() => {
      expect(onIndexChange).toHaveBeenCalledWith(1);
    });

    onIndexChange.mockClear();
    dispatchSwipe(stage!, { x: window.innerWidth / 2, y: 220 }, { x: window.innerWidth / 2, y: 360 });
    await vi.waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce();
    });
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it('keeps the centered file download link clickable without dismissing the lightbox', async () => {
    const onClose = vi.fn();
    await render(lightbox({
      onClose,
      images: [
        {
          url: 'https://cdn.example.test/report.pdf',
          downloadURL: 'https://download.example.test/report.pdf',
          filename: 'report.pdf',
          contentType: 'application/pdf',
          size: 4096,
        },
      ],
    }));

    const stage = document.querySelector('[data-testid="image-lightbox-attachment-stage"]') as HTMLElement | null;
    const download = document.querySelector('[data-testid="image-lightbox-file-download"]') as HTMLAnchorElement | null;
    expect(stage).not.toBeNull();
    expect(download).not.toBeNull();
    await expect.element(download!).toBeVisible();
    expect(download!.href).toBe('https://download.example.test/report.pdf');
    expect(download!.download).toBe('report.pdf');

    const rect = download!.getBoundingClientRect();
    download!.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 8,
      pointerType: 'touch',
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      bubbles: true,
    }));
    download!.dispatchEvent(new PointerEvent('pointerup', {
      pointerId: 8,
      pointerType: 'touch',
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      bubbles: true,
    }));
    let clickReachedDownload = false;
    download!.addEventListener('click', (event) => {
      clickReachedDownload = true;
      event.preventDefault();
    }, { once: true });
    download!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(clickReachedDownload).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="image-lightbox"]')).not.toBeNull();
    expect(stage!.style.transform).not.toContain('translate3d');
  });

  const twoImages = [
    { url: imageURL, filename: 'a.png', contentType: 'image/png', size: 2048 },
    { url: nextImageURL, filename: 'b.png', contentType: 'image/png', size: 2048 },
  ];

  it('closes on the Escape key', async () => {
    const onClose = vi.fn();
    await render(lightbox({ onClose }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('navigates with the ArrowRight and ArrowLeft keys', async () => {
    const onIndexChange = vi.fn();
    await render(lightbox({ images: twoImages, index: 0, onIndexChange }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(onIndexChange).toHaveBeenLastCalledWith(1);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    // From index 0, ArrowLeft wraps to the last image.
    expect(onIndexChange).toHaveBeenLastCalledWith(1);
  });

  it('navigates via the previous/next chevron buttons', async () => {
    const onIndexChange = vi.fn();
    const screen = await render(lightbox({ images: twoImages, index: 0, onIndexChange }));
    await screen.getByRole('button', { name: 'Next attachment' }).click();
    expect(onIndexChange).toHaveBeenLastCalledWith(1);
    await screen.getByRole('button', { name: 'Previous attachment' }).click();
    expect(onIndexChange).toHaveBeenLastCalledWith(1);
  });

  it('enables the zoom-out control after zooming in', async () => {
    const screen = await render(lightbox());
    const zoomOut = screen.getByRole('button', { name: 'Zoom out' }).element() as HTMLButtonElement;
    expect(zoomOut.disabled).toBe(true);
    await screen.getByRole('button', { name: 'Zoom in' }).click();
    await vi.waitFor(() => expect(zoomOut.disabled).toBe(false));
  });

  it('closes via the close button', async () => {
    const onClose = vi.fn();
    const screen = await render(lightbox({ onClose }));
    await screen.getByRole('button', { name: 'Close attachment preview' }).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the lightbox open when the download control or the zoom stage is clicked', async () => {
    const onClose = vi.fn();
    await render(lightbox({ onClose }));
    // The root backdrop closes on click; the download anchor and the zoom
    // stage each stop propagation so interacting with them must NOT close.
    // Block the anchor's default download navigation in the capture phase —
    // the React stopPropagation handler still runs on the bubble path.
    const prevent = (e: Event) => e.preventDefault();
    document.addEventListener('click', prevent, true);
    try {
      (document.querySelector('[data-testid="image-lightbox-download"]') as HTMLElement).click();
    } finally {
      document.removeEventListener('click', prevent, true);
    }
    expect(onClose).not.toHaveBeenCalled();
    (document.querySelector('[data-testid="image-lightbox-zoom-stage"]') as HTMLElement).click();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('contains clicks and pointer events inside the non-image file card', async () => {
    const onClose = vi.fn();
    await render(
      lightbox({
        onClose,
        images: [{ url: 'https://cdn.test/spec.pdf', filename: 'spec.pdf', contentType: 'application/pdf', size: 4096 }],
      }),
    );
    const stage = document.querySelector('[data-testid="image-lightbox-attachment-stage"]') as HTMLElement;
    const info = document.querySelector('[data-testid="image-lightbox-fileinfo"]') as HTMLElement;
    expect(stage).not.toBeNull();
    expect(info).not.toBeNull();
    // Clicking the attachment stage or the file-info card never bubbles to
    // the backdrop close.
    stage.click();
    info.click();
    expect(onClose).not.toHaveBeenCalled();
    // The card swallows pointer events so a drag that starts on it never
    // feeds the swipe-dismiss stage: nothing propagates past the React root,
    // so document-level listeners see none of them.
    const seen: string[] = [];
    const record = (e: Event) => seen.push(e.type);
    document.addEventListener('pointermove', record);
    document.addEventListener('pointercancel', record);
    try {
      info.dispatchEvent(new PointerEvent('pointermove', { pointerId: 21, pointerType: 'touch', clientX: 200, clientY: 300, bubbles: true, cancelable: true }));
      info.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 21, pointerType: 'touch', bubbles: true, cancelable: true }));
    } finally {
      document.removeEventListener('pointermove', record);
      document.removeEventListener('pointercancel', record);
    }
    expect(seen).toEqual([]);
  });
});
