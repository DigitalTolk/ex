import { beforeEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { Pencil } from 'lucide-react';
import { TooltipIconButton } from './tooltip-icon-button';
import { TooltipProvider } from './tooltip';
import { parkMouse } from '@/test/hover';

// An icon-only button says what it does on hover. In a list of rows the
// tooltip's word ("Edit") is the same on every row, so the accessible name
// can carry which row it acts on.
describe('TooltipIconButton', () => {
  beforeEach(async () => {
    await parkMouse();
  });

  it('shows its label on hover while naming its row for assistive tech', async () => {
    const screen = await render(
      <TooltipProvider delay={0}>
        <TooltipIconButton label="Edit" ariaLabel="Edit Alerts" expanded={false} size="icon-sm">
          <Pencil className="h-4 w-4" />
        </TooltipIconButton>
      </TooltipProvider>,
    );
    const button = screen.getByRole('button', { name: 'Edit Alerts' });
    await expect.element(button).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();

    await userEvent.hover(button);
    await expect.element(screen.getByText('Edit', { exact: true }).first()).toBeVisible();
  });

  it('is named by its label when it has no other name', async () => {
    const screen = await render(
      <TooltipProvider delay={0}>
        <TooltipIconButton label="Back">
          <Pencil className="h-4 w-4" />
        </TooltipIconButton>
      </TooltipProvider>,
    );
    const button = screen.getByRole('button', { name: 'Back' });
    await expect.element(button).toBeVisible();
    expect(button.element().hasAttribute('aria-expanded')).toBe(false);
  });
});
