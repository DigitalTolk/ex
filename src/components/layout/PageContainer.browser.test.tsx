import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { PageContainer } from './PageContainer';

// Browser coverage for PageContainer — the description and actions slots
// are each rendered conditionally, so both the present and absent arms
// need a scenario.

const isPhone = window.__EX_FORCE_DEVICE__ !== 'desktop';

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
    // A phone shows the page's name in its top bar and drops the description.
    if (isPhone) {
      await expect.element(screen.getByText('Browse everyone on the server')).not.toBeVisible();
    } else {
      await expect.element(screen.getByText('Browse everyone on the server')).toBeVisible();
    }
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

  // On a phone the page's name is in the top bar, so a page with nothing
  // else in its header starts its content right under the top bar's edge:
  // after the page's own padding, or none for a flush page.
  it.runIf(isPhone).each([
    ['without a description', undefined, false, 16],
    ['with a description', 'Browse everyone on the server', false, 16],
    ['flush', undefined, true, 0],
  ] as const)('starts the content at the top on a phone, %s', async (_name, description, flush, inset) => {
    const screen = await render(
      <PageContainer title="Threads" description={description} flush={flush}>
        <div data-testid="page-body">body</div>
      </PageContainer>,
    );
    await expect.element(screen.getByTestId('page-body')).toBeVisible();
    const page = screen.getByTestId('page-container').element().getBoundingClientRect();
    const body = screen.getByTestId('page-body').element().getBoundingClientRect();
    expect(Math.round(body.top - page.top)).toBe(inset);
    await expect.element(screen.getByRole('heading', { name: 'Threads' })).toBeInTheDocument();
  });

  it.runIf(isPhone)('keeps a phone page header that has actions', async () => {
    const screen = await render(
      <PageContainer title="Workspace settings" description="Limits" actions={<button type="button">Save</button>}>
        <div data-testid="page-body">body</div>
      </PageContainer>,
    );
    await expect.element(screen.getByRole('button', { name: 'Save' })).toBeVisible();
    const action = screen.getByRole('button', { name: 'Save' }).element().getBoundingClientRect();
    const body = screen.getByTestId('page-body').element().getBoundingClientRect();
    expect(action.bottom).toBeLessThanOrEqual(body.top);
  });
});
