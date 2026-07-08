import { describe, it, expect, vi, afterEach } from 'vitest';
import { render as browserRender } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { UserPickerRow } from './UserPickerRow';

// UserStatusIndicator resolves custom emoji through react-query.
function render(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return browserRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

// Browser-gate coverage for the shared people-row's variant arms (the
// added/you/mousedown branches the SearchBar browser tests never reach) plus
// a geometry check that the Added badge never wraps the row.

let active: { unmount: () => Promise<void> } | null = null;
afterEach(async () => {
  if (active) await active.unmount();
  active = null;
});

describe('UserPickerRow (browser)', () => {
  it('added rows render the indicator inline, stay one line, and are inert', async () => {
    const onSelect = vi.fn();
    const result = await render(
      <div style={{ width: 320 }}>
        <UserPickerRow
          testID="row"
          displayName="Already In The Channel With A Long Name"
          email="member@x.io"
          online
          userStatus={{ emoji: ':zzz:', text: 'away' }}
          added
          onSelect={onSelect}
        />
      </div>,
    );
    active = result;
    const row = document.querySelector('[data-testid="row"]') as HTMLButtonElement;
    const badge = document.querySelector('[data-testid="row-added"]') as HTMLElement;
    expect(badge.textContent).toContain('Added');
    expect(row.disabled).toBe(true);
    // Geometry: badge inline with the name (single row), no overflow.
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
    expect(badge.getClientRects().length).toBe(1);
    row.click();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('mousedown-pick fires for selectable rows and (you) renders', async () => {
    const onSelect = vi.fn();
    const result = await render(
      <UserPickerRow testID="row" displayName="Me" you pickOnMouseDown onSelect={onSelect} />,
    );
    active = result;
    const row = document.querySelector('[data-testid="row"]') as HTMLElement;
    expect(row.textContent).toContain('(you)');
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
