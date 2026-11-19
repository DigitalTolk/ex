import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { SelectOption } from '@/types';
import { ChoiceList } from './ChoiceList';

const options: SelectOption[] = [
  { text: { type: 'plain_text', text: 'Screen' }, value: 'tv', description: { type: 'markdown', text: 'In **every** room' } },
  { text: { type: 'markdown', text: '*Coffee*' }, value: 'cof' },
];

function List({ multiple, initial = [], onChange }: { multiple: boolean; initial?: string[]; onChange: (v: string[]) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <ChoiceList
      id="needs"
      label="Needs"
      options={options}
      multiple={multiple}
      value={value}
      onChange={(v) => {
        onChange(v);
        setValue(v);
      }}
      describedBy="needs-note"
    />
  );
}

describe('ChoiceList', () => {
  it('checks and unchecks boxes, reporting the whole list', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<List multiple onChange={onChange} />);
    const group = screen.getByRole('group', { name: 'Needs' });
    expect(group).toHaveAttribute('aria-describedby', 'needs-note');
    expect(group).not.toHaveAttribute('aria-invalid');
    // Option text and its second line may be markdown.
    expect(within(group).getByText('every').tagName).toBe('STRONG');
    expect(within(group).getByText('Coffee').tagName).toBe('EM');

    await user.click(screen.getByRole('checkbox', { name: /Screen/ }));
    await user.click(screen.getByRole('checkbox', { name: /Coffee/ }));
    expect(onChange).toHaveBeenLastCalledWith(['tv', 'cof']);
    await user.click(screen.getByRole('checkbox', { name: /Screen/ }));
    expect(onChange).toHaveBeenLastCalledWith(['cof']);
  });

  it('picks one radio button, moving with the arrow keys', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<List multiple={false} onChange={onChange} />);
    const group = screen.getByRole('radiogroup', { name: 'Needs' });
    await user.click(within(group).getByRole('radio', { name: /Screen/ }));
    expect(onChange).toHaveBeenLastCalledWith(['tv']);
    await user.keyboard('{ArrowDown}');
    expect(onChange).toHaveBeenLastCalledWith(['cof']);
    expect(within(group).getByRole('radio', { name: /Coffee/ })).toBeChecked();
  });

  it('shows a problem and a disabled list', () => {
    render(<ChoiceList id="needs" label="Needs" options={options} multiple value={['tv']} onChange={() => {}} invalid disabled />);
    expect(screen.getByRole('group')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('checkbox', { name: /Screen/ })).toBeChecked();
    expect(screen.getAllByRole('checkbox').every((c) => (c as HTMLInputElement).disabled)).toBe(true);
    expect(screen.getByRole('checkbox', { name: /Screen/ }).closest('label')).toHaveClass('pointer-events-none');
  });
});
