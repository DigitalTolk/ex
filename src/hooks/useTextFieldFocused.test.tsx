import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useTextFieldFocused } from './useTextFieldFocused';

function Probe({ enabled }: { enabled?: boolean }) {
  const focused = useTextFieldFocused(enabled);
  return (
    <div>
      <span data-testid="state">{focused ? 'typing' : 'idle'}</span>
      <input aria-label="field" />
      <button type="button">button</button>
    </div>
  );
}

describe('useTextFieldFocused', () => {
  it('is true only while a text field has focus', () => {
    render(<Probe />);
    expect(screen.getByTestId('state')).toHaveTextContent('idle');
    act(() => screen.getByLabelText('field').focus());
    expect(screen.getByTestId('state')).toHaveTextContent('typing');
    act(() => screen.getByRole('button').focus());
    expect(screen.getByTestId('state')).toHaveTextContent('idle');
  });

  // Only the phone needs it; elsewhere focus moves don't re-render the layout.
  it('stays false and ignores focus while disabled', () => {
    render(<Probe enabled={false} />);
    act(() => screen.getByLabelText('field').focus());
    expect(screen.getByTestId('state')).toHaveTextContent('idle');
  });

  // Regression: focus that moved while disabled (a tier flip away from the
  // phone and back) left the old value, keeping the tab bar hidden until the
  // next focus event.
  it('re-reads focus when enabled again', () => {
    const { rerender } = render(<Probe enabled />);
    act(() => screen.getByLabelText('field').focus());
    expect(screen.getByTestId('state')).toHaveTextContent('typing');
    rerender(<Probe enabled={false} />);
    act(() => screen.getByRole('button').focus());
    rerender(<Probe enabled />);
    expect(screen.getByTestId('state')).toHaveTextContent('idle');
  });
});
