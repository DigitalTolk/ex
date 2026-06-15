import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { Badge } from './badge';

// Browser coverage for the Badge primitive's default-variant branch —
// every caller in the app passes an explicit `variant`, so the
// `variant = "default"` parameter default is otherwise never taken.

describe('Badge primitive', () => {
  it('renders with the default variant when none is provided', async () => {
    const screen = await render(<Badge>Default</Badge>);
    const el = screen.getByText('Default').element() as HTMLElement;
    // The default variant maps to the primary surface utilities.
    expect(el.className).toContain('bg-primary');
    expect(el.getAttribute('data-variant')).toBe('default');
  });

  it('renders an explicit variant when supplied', async () => {
    const screen = await render(<Badge variant="brand">7</Badge>);
    const el = screen.getByText('7').element() as HTMLElement;
    expect(el.className).toContain('bg-brand');
  });
});
