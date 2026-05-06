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
  it('does not add a second safe-area top inset above the authenticated shell', () => {
    const app = readProjectFile('src/App.tsx');

    expect(app).toContain('className="shrink-0 bg-[#1a1d21]"');
    expect(app).not.toContain('className="shrink-0 bg-[#1a1d21] pt-[env(safe-area-inset-top)]"');
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
