import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { dayKey, formatDay } from '@/lib/app-view-form';
import { ViewDateField } from './ViewDateField';

// Field holds the value the way the form does, and reports each change.
function Field({ initial, clearable = false, onChange }: { initial: string; clearable?: boolean; onChange: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <ViewDateField
      id="when"
      value={value}
      onChange={(v) => {
        onChange(v);
        setValue(v);
      }}
      placeholder="When?"
      clearable={clearable}
      invalid={false}
    />
  );
}

const dayButton = (date: Date) => document.querySelector<HTMLButtonElement>(`button[data-day="${date.toLocaleDateString()}"]`);

describe('ViewDateField', () => {
  it('opens the calendar on the chosen day, and picking a day sets it and closes', async () => {
    const onChange = vi.fn();
    render(<Field initial="2026-11-02" onChange={onChange} />);
    const trigger = screen.getByTestId('when-trigger');
    expect(trigger).toHaveTextContent(formatDay('2026-11-02'));
    expect(trigger).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByTestId('when-clear')).toBeNull();

    fireEvent.click(trigger);
    await screen.findByTestId('when-calendar');
    expect(dayButton(new Date(2026, 10, 2))).toHaveAttribute('data-selected-single', 'true');
    fireEvent.click(dayButton(new Date(2026, 10, 18))!);
    expect(onChange).toHaveBeenLastCalledWith('2026-11-18');
    await waitFor(() => expect(screen.queryByTestId('when-calendar')).toBeNull());
    expect(trigger).toHaveTextContent(formatDay('2026-11-18'));
  });

  it('keeps the day when the person picks the chosen day again, and closes', async () => {
    const onChange = vi.fn();
    render(<Field initial="2026-11-02" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('when-trigger'));
    await screen.findByTestId('when-calendar');
    fireEvent.click(dayButton(new Date(2026, 10, 2))!);
    await waitFor(() => expect(screen.queryByTestId('when-calendar')).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('when-trigger')).toHaveTextContent(formatDay('2026-11-02'));
  });

  it('starts empty on this month, and an optional field can be cleared', async () => {
    const onChange = vi.fn();
    render(<Field initial="" clearable onChange={onChange} />);
    const trigger = screen.getByTestId('when-trigger');
    expect(trigger).toHaveTextContent('When?');
    expect(trigger.className).toContain('text-muted-foreground');
    expect(screen.queryByTestId('when-clear')).toBeNull();

    fireEvent.click(trigger);
    await screen.findByTestId('when-calendar');
    const today = new Date();
    fireEvent.click(dayButton(today)!);
    expect(onChange).toHaveBeenLastCalledWith(dayKey(today));
    await waitFor(() => expect(screen.queryByTestId('when-calendar')).toBeNull());

    fireEvent.click(screen.getByLabelText('Clear date'));
    expect(onChange).toHaveBeenLastCalledWith('');
    expect(trigger).toHaveTextContent('When?');
    expect(screen.queryByTestId('when-clear')).toBeNull();
  });

  it('shows the placeholder default and marks the field when it has an error', () => {
    render(<ViewDateField id="when" value="" onChange={() => {}} clearable={false} invalid describedBy="when-note" />);
    const trigger = screen.getByTestId('when-trigger');
    expect(trigger).toHaveTextContent('Pick a date');
    expect(trigger).toHaveAttribute('aria-invalid', 'true');
    expect(trigger).toHaveAttribute('aria-describedby', 'when-note');
  });
});
