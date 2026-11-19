import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { SelectOption } from '@/types';
import { MultiSelect } from './MultiSelect';

const opt = (value: string, label: string): SelectOption => ({ text: { type: 'plain_text', text: label }, value });
const few = [opt('x', 'Urgent'), opt('y', 'Later'), opt('z', 'Maybe')];
const many = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India'].map((n) => opt(n.toLowerCase(), n));

function Select(props: { options?: SelectOption[]; initial?: string[]; max?: number; applyLabel?: string; onChange: (v: string[]) => void }) {
  const [value, setValue] = useState(props.initial ?? []);
  return (
    <MultiSelect
      id="tags"
      label="Tags"
      options={props.options ?? few}
      value={value}
      onChange={(v) => {
        props.onChange(v);
        setValue(v);
      }}
      max={props.max}
      applyLabel={props.applyLabel}
    />
  );
}

describe('MultiSelect', () => {
  it('toggles options in a form, each toggle a change, and clears them', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Select onChange={onChange} />);
    const trigger = screen.getByTestId('tags');
    expect(trigger).toHaveTextContent('Choose…');
    await user.click(trigger);
    // A short list has no search, and no footer until something is chosen.
    expect(await screen.findByRole('listbox', { name: 'Tags' })).toBeInTheDocument();
    expect(screen.queryByTestId('tags-search')).toBeNull();
    expect(screen.queryByText(/chosen/)).toBeNull();

    await user.click(screen.getByRole('option', { name: 'Urgent' }));
    expect(onChange).toHaveBeenLastCalledWith(['x']);
    await user.click(screen.getByRole('option', { name: 'Maybe' }));
    expect(onChange).toHaveBeenLastCalledWith(['x', 'z']);
    expect(screen.getByRole('option', { name: 'Urgent' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('2 chosen')).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Urgent' }));
    expect(onChange).toHaveBeenLastCalledWith(['z']);

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('stops at its cap and says so', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Select max={2} initial={['x', 'y']} onChange={onChange} />);
    await user.click(screen.getByTestId('tags'));
    expect(await screen.findByText('Up to 2')).toBeInTheDocument();
    const maybe = screen.getByRole('option', { name: 'Maybe' });
    expect(maybe).toBeDisabled();
    // A chosen option can still be dropped.
    await user.click(screen.getByRole('option', { name: 'Later' }));
    expect(onChange).toHaveBeenLastCalledWith(['x']);
    expect(maybe).not.toBeDisabled();
  });

  it('searches a long list', async () => {
    const user = userEvent.setup();
    render(<Select options={many} onChange={() => {}} />);
    await user.click(screen.getByTestId('tags'));
    const search = await screen.findByRole('textbox', { name: 'Search Tags' });
    await user.type(search, 'ec');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Echo']);
    await user.clear(search);
    await user.type(search, 'zzz');
    expect(screen.getByText('No matches')).toBeInTheDocument();
    // Closing forgets the search.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    await user.click(screen.getByTestId('tags'));
    expect(await screen.findByRole('textbox', { name: 'Search Tags' })).toHaveValue('');
  });

  it('in a message, applies the choice once, and starts again from it when reopened', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Select applyLabel="Apply" initial={['x']} onChange={onChange} />);
    await user.click(screen.getByTestId('tags'));
    expect(await screen.findByText('1 chosen')).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Later' }));
    await user.click(screen.getByRole('option', { name: 'Urgent' }));
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('tags-apply'));
    expect(onChange).toHaveBeenCalledWith(['y']);
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(screen.getByTestId('tags')).toHaveTextContent('Later');

    // Toggles that were never applied are dropped.
    await user.click(screen.getByTestId('tags'));
    await user.click(await screen.findByRole('option', { name: 'Maybe' }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    await user.click(screen.getByTestId('tags'));
    expect(await screen.findByRole('option', { name: 'Maybe' })).toHaveAttribute('aria-selected', 'false');
    // With nothing chosen the footer still offers Apply.
    await user.click(screen.getByRole('option', { name: 'Later' }));
    expect(screen.getByText('0 chosen')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    await user.click(screen.getByTestId('tags-apply'));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('shows a value it has no option for as it is, and a problem', () => {
    render(<MultiSelect id="tags" label="Tags" options={few} value={['gone']} onChange={() => {}} placeholder="Pick" size="sm" invalid describedBy="tags-note" disabled />);
    const trigger = screen.getByTestId('tags');
    expect(trigger).toHaveTextContent('gone');
    expect(trigger).toHaveAttribute('aria-invalid', 'true');
    expect(trigger).toHaveAttribute('aria-describedby', 'tags-note');
    expect(trigger).toHaveClass('w-auto');
    expect(trigger).toBeDisabled();
  });
});
