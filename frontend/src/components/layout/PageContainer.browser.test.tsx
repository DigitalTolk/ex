import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { PageContainer } from './PageContainer';

// Browser coverage for PageContainer — the description and actions slots
// are each rendered conditionally, so both the present and absent arms
// need a scenario.

describe('PageContainer browser behaviour', () => {
  it('renders the title, description, and actions when all are provided', async () => {
    const screen = await render(
      <PageContainer
        title="Directory"
        description="Browse everyone on the server"
        actions={<button data-testid="page-action">New</button>}
      >
        <div data-testid="page-body">body</div>
      </PageContainer>,
    );
    await expect.element(screen.getByRole('heading', { name: 'Directory' })).toBeVisible();
    await expect.element(screen.getByText('Browse everyone on the server')).toBeVisible();
    await expect.element(screen.getByTestId('page-action')).toBeVisible();
    await expect.element(screen.getByTestId('page-body')).toBeVisible();
  });

  it('omits the description paragraph and actions slot when neither is provided', async () => {
    const screen = await render(
      <PageContainer title="Threads">
        <div data-testid="page-body">body</div>
      </PageContainer>,
    );
    await expect.element(screen.getByRole('heading', { name: 'Threads' })).toBeVisible();
    // No description <p> and no actions wrapper are rendered.
    expect(document.querySelector('p.text-muted-foreground')).toBeNull();
    expect(document.querySelector('.shrink-0.flex-wrap')).toBeNull();
  });
});
