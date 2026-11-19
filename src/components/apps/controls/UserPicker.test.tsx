import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserPicker } from './UserPicker';

const mockApiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));

const people = [
  { id: 'u-bob', displayName: 'Bob', email: 'bob@example.com' },
  { id: 'u-bonnie', displayName: 'Bonnie', email: 'bonnie@example.com', avatarURL: '/a/bonnie.png' },
  { id: 'u-boris', displayName: 'Boris', email: 'boris@example.com' },
];

beforeEach(() => {
  mockApiFetch.mockReset();
  mockApiFetch.mockImplementation((path: string, init?: { body?: string }) => {
    if (path.startsWith('/api/v1/users?q=')) {
      const q = decodeURIComponent(path.split('q=')[1]).toLowerCase();
      return Promise.resolve(people.filter((p) => p.displayName.toLowerCase().startsWith(q)));
    }
    if (path === '/api/v1/users/batch') {
      const { ids } = JSON.parse(init!.body!) as { ids: string[] };
      return Promise.resolve(people.filter((p) => ids.includes(p.id)));
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });
});

function Picker({ initial = [], multiple, max, onChange }: { initial?: string[]; multiple?: boolean; max?: number; onChange: (v: string[], name?: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <UserPicker
      id="who"
      label="Who"
      value={value}
      multiple={multiple}
      max={max}
      onChange={(v, name) => {
        // The person just added comes with their name; a removal has none.
        if (name === undefined) onChange(v);
        else onChange(v, name);
        setValue(v);
      }}
    />
  );
}

function renderPicker(props: Parameters<typeof Picker>[0]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Picker {...props} />
    </QueryClientProvider>,
  );
}

const box = () => screen.getByRole('combobox', { name: 'Who' });

describe('UserPicker', () => {
  it('searches from two letters and picks with the arrow keys and Enter', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPicker({ onChange });
    expect(box()).toHaveAttribute('placeholder', 'Search people');
    await user.type(box(), 'b');
    expect(box()).toHaveAttribute('aria-expanded', 'false');
    expect(mockApiFetch).not.toHaveBeenCalled();

    await user.type(box(), 'o');
    expect(box()).toHaveAttribute('aria-expanded', 'true');
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('Bobbob@example.com'),
      expect.stringContaining('Bonniebonnie@example.com'),
      expect.stringContaining('Borisboris@example.com'),
    ]);
    expect(box()).toHaveAttribute('aria-activedescendant', 'who-list-u-bob');

    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    // The last stays active.
    expect(box()).toHaveAttribute('aria-activedescendant', 'who-list-u-boris');
    expect(screen.getByRole('option', { name: /Boris/ })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}');
    expect(box()).toHaveAttribute('aria-activedescendant', 'who-list-u-bob');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(['u-bonnie'], 'Bonnie');
    await waitFor(() => expect(screen.getByTestId('who-chip')).toHaveTextContent('Bonnie'));
    // One person: the search gives way to the chip.
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('picks several people up to a cap, and Backspace drops the last', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPicker({ multiple: true, max: 2, initial: ['u-bob'], onChange });
    await waitFor(() => expect(screen.getByTestId('who-chip')).toHaveTextContent('Bob'));
    // Someone is chosen: no placeholder, and the chosen aren't offered again.
    expect(box()).toHaveAttribute('placeholder', '');
    await user.type(box(), 'bo');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    expect(screen.queryByRole('option', { name: /^Bob/ })).toBeNull();
    await user.click(screen.getByRole('option', { name: /Boris/ }));
    expect(onChange).toHaveBeenLastCalledWith(['u-bob', 'u-boris'], 'Boris');
    // At the cap: no more searching.
    expect(screen.queryByRole('combobox')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Remove Boris' }));
    expect(onChange).toHaveBeenLastCalledWith(['u-bob']);
    await user.click(box());
    await user.keyboard('{Backspace}');
    expect(onChange).toHaveBeenLastCalledWith([]);
    // Backspace with nothing chosen, or while typing, drops nobody.
    await user.keyboard('{Backspace}');
    await user.type(box(), 'x{Backspace}');
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("says when no one matches, and Enter then picks nobody", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPicker({ onChange });
    await user.type(box(), 'zz');
    expect(await screen.findByText('No one matches')).toBeInTheDocument();
    expect(box()).not.toHaveAttribute('aria-activedescendant');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).not.toHaveBeenCalled();
    // Escape closes the list and forgets the search.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(box()).toHaveValue(''));
  });

  it('names someone it cannot look up "Someone", and focuses the search from the field', async () => {
    const user = userEvent.setup();
    renderPicker({ multiple: true, initial: ['u-gone'], onChange: () => {} });
    expect(await screen.findByTestId('who-chip')).toHaveTextContent('Someone');
    await user.click(screen.getByTestId('who-chip').parentElement!);
    expect(box()).toHaveFocus();
  });

  it('shows a problem, and a disabled field', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <UserPicker id="who" label="Who" value={[]} onChange={() => {}} placeholder="Find" size="sm" invalid disabled describedBy="who-note" />
      </QueryClientProvider>,
    );
    expect(box()).toHaveAttribute('placeholder', 'Find');
    expect(box()).toHaveAttribute('aria-invalid', 'true');
    expect(box()).toHaveAttribute('aria-describedby', 'who-note');
    expect(box()).toBeDisabled();
    const field = box().closest('.w-64')!;
    expect(field).toHaveClass('border-destructive');
    expect(within(field as HTMLElement).queryByTestId('who-chip')).toBeNull();
  });
});
