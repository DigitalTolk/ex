import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
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
});
