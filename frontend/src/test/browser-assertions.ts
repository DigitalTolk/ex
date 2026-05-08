import { expect } from 'vitest';

export function expectNonZeroBox(element: Element) {
  const rect = element.getBoundingClientRect();
  expect(rect.width).toBeGreaterThan(0);
  expect(rect.height).toBeGreaterThan(0);
  return rect;
}

export function expectPaintedAtCenter(element: Element, closestSelector?: string) {
  const rect = expectNonZeroBox(element);
  const visibleLeft = Math.max(rect.left, 0);
  const visibleRight = Math.min(rect.right, window.innerWidth);
  const visibleTop = Math.max(rect.top, 0);
  const visibleBottom = Math.min(rect.bottom, window.innerHeight);
  expect(visibleRight).toBeGreaterThan(visibleLeft);
  expect(visibleBottom).toBeGreaterThan(visibleTop);

  const painted = document.elementFromPoint(
    visibleLeft + (visibleRight - visibleLeft) / 2,
    visibleTop + (visibleBottom - visibleTop) / 2,
  );
  expect(painted).not.toBeNull();
  if (closestSelector) {
    expect(painted!.closest(closestSelector)).toBe(element);
  } else {
    expect(element.contains(painted)).toBe(true);
  }
  return painted;
}
