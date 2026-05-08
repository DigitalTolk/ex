import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { ImageLightbox } from './ImageLightbox';
import { expectPaintedAtCenter } from '@/test/browser-assertions';

const imageURL = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#3b82f6"/><circle cx="600" cy="400" r="180" fill="#f8fafc"/></svg>',
)}`;

function lightbox() {
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
    />
  );
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
});
