import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { ResourceErrorPage } from './ResourceErrorPage';

function renderPage(props: Parameters<typeof ResourceErrorPage>[0]) {
  return render(
    <MemoryRouter><ResourceErrorPage {...props} /></MemoryRouter>,
  );
}

describe('ResourceErrorPage browser behaviour', () => {
  it('renders the 403 title and copy with the capitalised resource', async () => {
    const screen = await renderPage({ resource: 'channel', status: 403 });
    await expect.element(screen.getByRole('heading', { name: 'Channel access denied' })).toBeVisible();
    await expect.element(screen.getByText(/You do not have access to this channel/)).toBeVisible();
  });

  it('renders the 500 title and copy', async () => {
    const screen = await renderPage({ resource: 'page', status: 500 });
    await expect.element(screen.getByRole('heading', { name: 'Page unavailable' })).toBeVisible();
    await expect.element(screen.getByText(/We could not load this page/)).toBeVisible();
  });

  it('exposes a Go-home link to the supplied homeHref', async () => {
    await renderPage({ resource: 'page', status: 500, homeHref: '/dashboard' });
    const link = document.querySelector('a[href="/dashboard"]') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.textContent).toMatch(/Go home/);
  });

  it('exposes a data-testid for the status code', async () => {
    await renderPage({ resource: 'page', status: 500 });
    expect(document.querySelector('[data-testid="resource-error-500"]')).not.toBeNull();
  });
});
