import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';

// Browser coverage for the Tooltip primitive's default parameters —
// TooltipProvider's `delay = 0` and TooltipContent's `side`/`align`/
// offset defaults are otherwise never exercised because every in-app
// caller passes explicit values.

describe('Tooltip primitive defaults', () => {
  it('renders a tooltip using the provider/content default parameters', async () => {
    const screen = await render(
      // No `delay` on the provider (→ delay=0 default) and no side/align/
      // offset props on the content (→ side="top", align="center",
      // sideOffset=4, alignOffset=0 defaults).
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger data-testid="tt-trigger">hover me</TooltipTrigger>
          <TooltipContent>Tooltip body</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    await expect.element(screen.getByTestId('tt-trigger')).toBeVisible();
    // The popup content is portalled to the body when open.
    await expect.element(screen.getByText('Tooltip body').first()).toBeVisible();
  });
});
