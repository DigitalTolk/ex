import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readProjectFile(path: string) {
  const frontendRoot = process.cwd().endsWith('/frontend')
    ? process.cwd()
    : resolve(process.cwd(), 'frontend');
  return readFileSync(resolve(frontendRoot, path), 'utf8');
}

describe('mobile shell invariants', () => {
  it('reserves top safe-area once at the viewport shell so banners are not clipped', () => {
    const app = readProjectFile('src/App.tsx');
    const layout = readProjectFile('src/components/layout/AppLayout.tsx');

    // Either the bare arbitrary value or the named utility is fine —
    // they resolve to the same env(safe-area-inset-top) underneath.
    expect(app).toMatch(/pt-(safe-top|\[env\(safe-area-inset-top\)\])/);
    expect(app).toContain('bg-sidebar');
    expect(app).toContain('dark:bg-[#1a1d21]');
    expect(app).not.toContain('<UpdateBanner />');
    expect(app).not.toContain('<NotificationPermissionBanner />');
    expect(layout).toContain('data-testid="app-layout-banners"');
    expect(layout).toContain('<UpdateBanner />');
    expect(layout).toContain('<NotificationPermissionBanner />');
    expect(layout).not.toContain('pt-[env(safe-area-inset-top)]');
  });

  it('keeps mobile text inputs at 16px to avoid iOS focus zoom', () => {
    const css = readProjectFile('src/index.css');

    expect(css).toContain('@media (max-width: 767px)');
    expect(css).toContain('[contenteditable="true"]');
    expect(css).toContain('[role="textbox"]');
    expect(css).toContain('font-size: 16px;');
  });

  it('uses a non-zooming viewport with safe-area support', () => {
    const html = readProjectFile('index.html');

    expect(html).toContain('width=device-width, initial-scale=1.0, maximum-scale=1, viewport-fit=cover');
  });
});
