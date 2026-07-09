import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from './dropdown-menu';

// Browser coverage for the dropdown-menu wrapper's default props (Content
// align, SubContent align/alignOffset/side/sideOffset) — only exercised when
// a consumer omits them, which the app's call sites don't.

describe('dropdown-menu defaults (browser)', () => {
  it('renders Content and a SubContent with their default placement props', async () => {
    const screen = await render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>First item</DropdownMenuItem>
          {/* defaultOpen on the submenu renders SubContent declaratively, so
              the test doesn't depend on a hover/click-to-open that gets slow
              under full-suite load. */}
          <DropdownMenuSub defaultOpen>
            <DropdownMenuSubTrigger data-testid="sub-trigger">More</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Nested item</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    // defaultOpen renders the Content (default align='start').
    await expect.element(screen.getByText('First item')).toBeVisible();
    // The submenu's SubContent renders with all its default placement props.
    await expect.element(screen.getByText('Nested item')).toBeVisible();
  });
});
