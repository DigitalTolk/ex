import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { Header } from './Header';
import { expectPaintedAtCenter } from '@/test/browser-assertions';

const channel = {
  id: 'ch-1',
  name: 'general',
  slug: 'general',
  type: 'public' as const,
  createdBy: 'u-1',
  archived: false,
  createdAt: '2026-05-08T10:00:00.000Z',
  description: 'General discussion for the whole team',
};

describe('Header browser behavior', () => {
  it('hides channel descriptions on mobile and leaves a short channel name untruncated', async () => {
    if (window.innerWidth > 767) return;

    const screen = await render(
      <div style={{ width: 390 }}>
        <Header
          channel={channel}
          memberCount={8}
          onFilesClick={vi.fn()}
        />
      </div>,
    );

    const title = screen.getByRole('heading', { name: 'general' });
    await expect.element(title).toBeVisible();
    expect(document.body.textContent).not.toContain(channel.description);
    expect(title.element().scrollWidth).toBeLessThanOrEqual(title.element().clientWidth + 1);
    expectPaintedAtCenter(title.element());
    expectPaintedAtCenter(screen.getByLabelText('View shared files').element());
  });

  it('keeps the desktop channel description on the same row as the channel name', async () => {
    if (window.innerWidth <= 767) return;

    const screen = await render(
      <div style={{ width: 960 }}>
        <Header
          channel={channel}
          memberCount={8}
          onFilesClick={vi.fn()}
          onPinnedClick={vi.fn()}
        />
      </div>,
    );

    const title = screen.getByRole('heading', { name: 'general' });
    const description = screen.getByText(channel.description);
    const files = screen.getByLabelText('View shared files');

    await expect.element(description).toBeVisible();

    const titleRect = title.element().getBoundingClientRect();
    const descriptionRect = description.element().getBoundingClientRect();
    const filesRect = files.element().getBoundingClientRect();
    const titleMidY = titleRect.top + titleRect.height / 2;
    const descriptionMidY = descriptionRect.top + descriptionRect.height / 2;

    expect(descriptionRect.left).toBeGreaterThan(titleRect.right - 1);
    expect(descriptionRect.right).toBeLessThan(filesRect.left - 8);
    expect(Math.abs(descriptionMidY - titleMidY)).toBeLessThanOrEqual(4);
    expectPaintedAtCenter(description.element());
    expectPaintedAtCenter(files.element());
  });
});
