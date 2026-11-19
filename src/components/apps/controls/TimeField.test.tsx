import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimeField } from './TimeField';

function Field({ initial, commitOnBlur, onChange }: { initial: string; commitOnBlur?: boolean; onChange: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <TimeField
        id="at"
        value={value}
        onChange={(v) => {
          onChange(v);
          setValue(v);
        }}
        commitOnBlur={commitOnBlur}
        label="Start"
        describedBy="at-note"
      />
      <button type="button" onClick={() => setValue('07:45')}>
        Reset
      </button>
    </>
  );
}

const proto = HTMLInputElement.prototype as { showPicker?: () => void };
const original = proto.showPicker;
afterEach(() => {
  if (original) proto.showPicker = original;
  else delete proto.showPicker;
});

describe('TimeField', () => {
  it('reports each change in a form', () => {
    const onChange = vi.fn();
    render(<Field initial="09:00" onChange={onChange} />);
    const field = screen.getByLabelText('Start');
    expect(field).toHaveAttribute('type', 'time');
    expect(field).toHaveAttribute('aria-describedby', 'at-note');
    expect(field).not.toHaveAttribute('aria-invalid');
    fireEvent.change(field, { target: { value: '10:15' } });
    expect(onChange).toHaveBeenLastCalledWith('10:15');
    // Leaving or Enter changes nothing more.
    fireEvent.blur(field);
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('commits once complete when asked, and follows a value set from outside', () => {
    const onChange = vi.fn();
    render(<Field initial="09:00" commitOnBlur onChange={onChange} />);
    const field = screen.getByLabelText('Start');
    fireEvent.change(field, { target: { value: '10:15' } });
    expect(field).toHaveValue('10:15');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(field);
    expect(onChange).toHaveBeenCalledWith('10:15');
    // Unchanged: nothing to commit.
    fireEvent.blur(field);
    expect(onChange).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('Reset'));
    expect(field).toHaveValue('07:45');
  });

  it("opens the platform's picker from the whole field, and still types where it can't", () => {
    const shown = vi.fn();
    proto.showPicker = shown;
    const { unmount } = render(<TimeField id="at" value="" onChange={() => {}} label="Start" invalid size="sm" disabled={false} />);
    const field = screen.getByLabelText('Start');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveClass('w-36');
    // Its own small picker icon is hidden: ex's clock sits on the left.
    expect(field).toHaveClass('[&::-webkit-calendar-picker-indicator]:hidden');
    fireEvent.click(field);
    expect(shown).toHaveBeenCalledTimes(1);
    unmount();

    proto.showPicker = () => {
      throw new DOMException('not allowed', 'NotAllowedError');
    };
    render(<TimeField id="at" value="" onChange={() => {}} label="Start" />);
    expect(() => fireEvent.click(screen.getByLabelText('Start'))).not.toThrow();

    delete proto.showPicker;
    fireEvent.click(screen.getByLabelText('Start'));
  });
});
