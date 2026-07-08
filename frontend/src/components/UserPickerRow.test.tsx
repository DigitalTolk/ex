import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { UserPickerRow } from './UserPickerRow';

// UserStatusIndicator resolves custom emoji through react-query.
function render(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('UserPickerRow', () => {
  it('renders the canonical people-row: avatar, name, status emoji, email', () => {
    render(
      <UserPickerRow
        testID="row"
        displayName="Alice Wonder"
        email="alice@x.io"
        online
        userStatus={{ emoji: ':zzz:', text: 'away' }}
        onSelect={() => undefined}
      />,
    );
    const row = screen.getByTestId('row');
    expect(row).toHaveTextContent('Alice Wonder');
    expect(row).toHaveTextContent('alice@x.io');
    // Presence dot renders because online is defined.
    expect(row.querySelector('[data-slot="avatar"]')).not.toBeNull();
  });

  it('fires onSelect on click and marks the highlighted row', () => {
    const onSelect = vi.fn();
    render(<UserPickerRow testID="row" displayName="Bob" highlighted onSelect={onSelect} />);
    const row = screen.getByTestId('row');
    expect(row).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('added rows show the checkmark and are inert (the channel add-member exception)', () => {
    const onSelect = vi.fn();
    render(<UserPickerRow testID="row" displayName="Carol" added onSelect={onSelect} />);
    const row = screen.getByTestId('row');
    // A simple checkmark, not a text badge.
    expect(screen.getByTestId('row-added')).toHaveAccessibleName('Already added');
    expect(screen.getByTestId('row-added')).not.toHaveTextContent('Added');
    expect(row).toBeDisabled();
    fireEvent.click(row);
    fireEvent.mouseDown(row);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('pickOnMouseDown selects before the input blur (and not again for added rows)', () => {
    const onSelect = vi.fn();
    render(<UserPickerRow testID="row" displayName="Dana" pickOnMouseDown onSelect={onSelect} />);
    fireEvent.mouseDown(screen.getByTestId('row'));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('appends the (you) label for the current user', () => {
    render(<UserPickerRow testID="row" displayName="Me" you onSelect={() => undefined} />);
    expect(screen.getByTestId('row')).toHaveTextContent('(you)');
  });
});

describe('UserPickerRow without a testID', () => {
  it('renders the added checkmark without a derived testid', () => {
    render(<UserPickerRow displayName="Eve" added onSelect={() => undefined} />);
    expect(screen.getByLabelText('Already added')).toBeInTheDocument();
    expect(screen.queryByTestId('row-added')).toBeNull();
  });
});
