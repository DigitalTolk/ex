import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { NotFoundPage } from './NotFoundPage';

describe('NotFoundPage browser behaviour', () => {
  it('uses the default heading and copy when no resource is supplied', async () => {
    const screen = await render(
      <MemoryRouter><NotFoundPage /></MemoryRouter>,
    );
    await expect.element(screen.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect.element(screen.getByText(/The page you're looking for/)).toBeVisible();
  });

  it('capitalises the resource name in the heading', async () => {
    const screen = await render(
      <MemoryRouter><NotFoundPage resource="channel" /></MemoryRouter>,
    );
    await expect.element(screen.getByRole('heading', { name: 'Channel not found' })).toBeVisible();
    await expect.element(screen.getByText(/The channel you're looking for/)).toBeVisible();
  });

  it('points "Go home" at the provided homeHref', async () => {
    await render(
      <MemoryRouter><NotFoundPage homeHref="/dashboard" /></MemoryRouter>,
    );
    const link = document.querySelector('a[href="/dashboard"]') as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.textContent).toMatch(/Go home/);
  });

  it('sets role="alert" so screen readers announce the page', async () => {
    await render(
      <MemoryRouter><NotFoundPage /></MemoryRouter>,
    );
    expect(document.querySelector('[role="alert"][data-testid="not-found-page"]')).not.toBeNull();
  });
});
