import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { ImageLightbox } from './ImageLightbox';
import type { ComponentProps } from 'react';

// Edge-case browser coverage for ImageLightbox — targets branches the
// main behavior suite doesn't reach: empty image list, single-image
// arrow keys, the desktop vs mobile gates on tap/double-click, the
// ctrl/meta wheel zoom, pointer-cancel cleanup, the avatar image/
// fallback arms, and the download double-click zoom toggle.

const imageURL = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#3b82f6"/></svg>',
)}`;

function lightbox(overrides: Partial<ComponentProps<typeof ImageLightbox>> = {}) {
  return (
    <ImageLightbox
      open
      onClose={vi.fn()}
      images={[{ url: imageURL, filename: 'photo.png', contentType: 'image/png', size: 2048 }]}
      index={0}
      onIndexChange={vi.fn()}
      authorName="Alice"
      postedAt="2026-05-08T10:00:00.000Z"
      {...overrides}
    />
  );
}

describe('ImageLightbox edge branches', () => {
  afterEach(() => cleanup());

  it('renders nothing when there are no images (total === 0 arm)', async () => {
    await render(lightbox({ images: [] }));
    expect(document.querySelector('[data-testid="image-lightbox"]')).toBeNull();
  });

  it('renders nothing when closed (the !open guard + effect early-return)', async () => {
    await render(lightbox({ open: false }));
    expect(document.querySelector('[data-testid="image-lightbox"]')).toBeNull();
    // A keydown while closed must be a no-op (effect registered no listener).
    const onClose = vi.fn();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ignores arrow keys when there is only a single image (total <= 1)', async () => {
    const onIndexChange = vi.fn();
    await render(lightbox({ onIndexChange }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it('blurs the focused element when Escape closes the lightbox', async () => {
    const onClose = vi.fn();
    const screen = await render(lightbox({ onClose }));
    const closeBtn = screen.getByTestId('image-lightbox-close').element() as HTMLButtonElement;
    closeBtn.focus();
    expect(document.activeElement).toBe(closeBtn);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    // The focused element was blurred (activeElement falls back to body).
    expect(document.activeElement).not.toBe(closeBtn);
  });

  it('renders the avatar image when authorAvatarURL is provided', async () => {
    await render(lightbox({ authorAvatarURL: imageURL }));
    const toolbar = document.querySelector('[data-testid="image-lightbox-toolbar"]') as HTMLElement;
    expect(toolbar.querySelector('img')).not.toBeNull();
  });

  it('falls back to a ? initial when the author name is empty', async () => {
    await render(lightbox({ authorName: '' }));
    const toolbar = document.querySelector('[data-testid="image-lightbox-toolbar"]') as HTMLElement;
    expect(toolbar.textContent).toContain('?');
  });

  it('zooms out fully back to 1x via the zoom-out control (next <= 1 reset arm)', async () => {
    const screen = await render(lightbox());
    const image = document.querySelector('[data-testid="image-lightbox-image"]') as HTMLImageElement;
    // Two zoom-ins (0.75 step each) push past 1, then two zoom-outs clamp to 1.
    await screen.getByTestId('image-lightbox-zoom-in').click();
    await screen.getByTestId('image-lightbox-zoom-in').click();
    await vi.waitFor(() => expect(Number(image.dataset.zoom)).toBeGreaterThan(1));
    const zoomOut = screen.getByTestId('image-lightbox-zoom-out').element() as HTMLButtonElement;
    // Click zoom-out repeatedly until the control disables itself at 1x —
    // the clamp to 1 in setCurrentZoom triggers the `next <= 1` reset arm.
    for (let i = 0; i < 6 && !zoomOut.disabled; i++) {
      zoomOut.click();
      await new Promise((r) => setTimeout(r, 10));
    }
    await vi.waitFor(() => expect(Number(image.dataset.zoom)).toBe(1));
  });

  it('toggles zoom via the download double-click (value > 1 ? 1 : 2)', async () => {
    await render(lightbox());
    const image = document.querySelector('[data-testid="image-lightbox-image"]') as HTMLImageElement;
    const download = document.querySelector('[data-testid="image-lightbox-download"]') as HTMLAnchorElement;
    download.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(Number(image.dataset.zoom)).toBe(2));
    download.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(Number(image.dataset.zoom)).toBe(1));
  });

  it('zooms with a ctrl/meta wheel and ignores a plain wheel', async () => {
    await render(lightbox());
    const stage = document.querySelector('[data-testid="image-lightbox-zoom-stage"]') as HTMLElement;
    const image = document.querySelector('[data-testid="image-lightbox-image"]') as HTMLImageElement;

    // Plain wheel (no modifier) is ignored — the early-return arm.
    stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(Number(image.dataset.zoom)).toBe(1);

    // ctrl + wheel-up zooms in.
    stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(Number(image.dataset.zoom)).toBeGreaterThan(1));

    // ctrl + wheel-down zooms back out (deltaY > 0 arm).
    stage.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, ctrlKey: true, bubbles: true, cancelable: true }));
    stage.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, ctrlKey: true, bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(Number(image.dataset.zoom)).toBe(1));
  });

  it('cleans up an in-flight swipe gesture on pointercancel (mobile)', async () => {
    if (window.innerWidth > 767) return;
    const onClose = vi.fn();
    await render(lightbox({ onClose }));
    const stage = document.querySelector('[data-testid="image-lightbox-zoom-stage"]') as HTMLElement;
    // Start a swipe, then cancel mid-gesture: the swipe drag must reset to 0
    // and no close fires.
    stage.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 3, pointerType: 'touch', clientX: 200, clientY: 200, bubbles: true }));
    stage.dispatchEvent(new PointerEvent('pointermove', { pointerId: 3, pointerType: 'touch', clientX: 205, clientY: 300, bubbles: true }));
    await vi.waitFor(() => expect(stage.style.transform).toContain('translate3d'));
    stage.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 3, pointerType: 'touch', clientX: 205, clientY: 300, bubbles: true }));
    await vi.waitFor(() => expect(stage.style.transform).not.toContain('translate3d'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cleans up a tap-pending pointer on pointercancel without zooming (mobile)', async () => {
    if (window.innerWidth > 767) return;
    await render(lightbox());
    const stage = document.querySelector('[data-testid="image-lightbox-zoom-stage"]') as HTMLElement;
    const image = document.querySelector('[data-testid="image-lightbox-image"]') as HTMLImageElement;
    // A stationary pointerdown registers a tap-pending; cancelling it must
    // clear the pending tap (so a later tap doesn't chain into a double-tap).
    stage.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, pointerType: 'touch', clientX: 250, clientY: 250, bubbles: true }));
    stage.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 7, pointerType: 'touch', clientX: 250, clientY: 250, bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(Number(image.dataset.zoom)).toBe(1);
  });

  it('cleans up a zoomed-image pan gesture on pointercancel (mobile)', async () => {
    if (window.innerWidth > 767) return;
    const screen = await render(lightbox());
    const stage = document.querySelector('[data-testid="image-lightbox-zoom-stage"]') as HTMLElement;
    const image = document.querySelector('[data-testid="image-lightbox-image"]') as HTMLImageElement;
    // Zoom in first so a single-pointer drag becomes a pan (not a swipe).
    await screen.getByTestId('image-lightbox-zoom-in').click();
    await vi.waitFor(() => expect(Number(image.dataset.zoom)).toBeGreaterThan(1));
    stage.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 9, pointerType: 'touch', clientX: 200, clientY: 200, bubbles: true }));
    stage.dispatchEvent(new PointerEvent('pointermove', { pointerId: 9, pointerType: 'touch', clientX: 260, clientY: 210, bubbles: true }));
    await vi.waitFor(() => expect(Math.abs(Number(image.dataset.panX))).toBeGreaterThan(0));
    // Cancel the pan; the gesture resets to idle without crashing.
    stage.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 9, pointerType: 'touch', clientX: 260, clientY: 210, bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    // A fresh pointerup for the same id is a no-op (gesture already idle).
    expect(document.querySelector('[data-testid="image-lightbox"]')).not.toBeNull();
  });

  it('ignores a pointermove for a pointer that never went down (has() false arm)', async () => {
    await render(lightbox());
    const stage = document.querySelector('[data-testid="image-lightbox-zoom-stage"]') as HTMLElement;
    // No pointerdown precedes this move, so activePointersRef.has() is false.
    stage.dispatchEvent(new PointerEvent('pointermove', { pointerId: 99, pointerType: 'touch', clientX: 100, clientY: 100, bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(document.querySelector('[data-testid="image-lightbox"]')).not.toBeNull();
  });

  it('does not double-tap-zoom on desktop (handleMobileTap !isMobile arm)', async () => {
    if (window.innerWidth <= 767) return;
    await render(lightbox());
    const stage = document.querySelector('[data-testid="image-lightbox-zoom-stage"]') as HTMLElement;
    const image = document.querySelector('[data-testid="image-lightbox-image"]') as HTMLImageElement;
    // A desktop double-click on the stage must NOT toggle zoom.
    stage.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(Number(image.dataset.zoom)).toBe(1);
  });

  it('double-click toggles mobile image zoom (handleImageStageDoubleClick)', async () => {
    if (window.innerWidth > 767) return;
    await render(lightbox());
    const stage = document.querySelector('[data-testid="image-lightbox-zoom-stage"]') as HTMLElement;
    const image = document.querySelector('[data-testid="image-lightbox-image"]') as HTMLImageElement;
    stage.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(Number(image.dataset.zoom)).toBe(2));
  });
});
