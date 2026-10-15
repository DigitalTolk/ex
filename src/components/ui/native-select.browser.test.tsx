import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { useState } from 'react';
import { Input } from './input';
import { NativeSelect } from './native-select';

// A select next to a text field used to be taller, with its own border,
// radius and fill (every form styled its own <select>). NativeSelect is built
// on the same field classes as Input, so the two line up.

function Form({ onPick }: { onPick?: (value: string) => void }) {
  const [value, setValue] = useState('b');
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', width: 600 }}>
      <Input aria-label="Title" />
      <NativeSelect
        aria-label="Channel"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          onPick?.(e.target.value);
        }}
      >
        <option value="a">general</option>
        <option value="b">random</option>
      </NativeSelect>
      <NativeSelect aria-label="Small" size="sm">
        <option>x</option>
      </NativeSelect>
      <NativeSelect aria-label="Ghost" size="sm" variant="ghost" disabled>
        <option>y</option>
      </NativeSelect>
    </div>
  );
}

const field = (label: string) => document.querySelector(`[aria-label="${label}"]`) as HTMLElement;

describe('NativeSelect', () => {
  it('matches Input: height, border, radius, fill and type size', async () => {
    await render(<Form />);
    const input = getComputedStyle(field('Title'));
    const select = getComputedStyle(field('Channel'));
    // WebKit can apply the app's stylesheet a moment after the first render.
    await vi.waitFor(() => {
      expect(field('Channel').getBoundingClientRect().height).toBe(field('Title').getBoundingClientRect().height);
      for (const prop of [
        'borderTopWidth',
        'borderTopColor',
        'borderTopLeftRadius',
        'backgroundColor',
        'fontSize',
        'paddingLeft',
      ] as const) {
        expect(select[prop], prop).toBe(input[prop]);
      }
    }, { timeout: 5000 });
    // The chevron is its own, so it is the same in every engine.
    expect(select.appearance).toBe('none');
    expect(document.querySelector('[data-slot="native-select-wrapper"] svg')).not.toBeNull();
  });

  it('is a working native select', async () => {
    const onPick = vi.fn();
    const screen = await render(<Form onPick={onPick} />);
    await userEvent.selectOptions(screen.getByLabelText('Channel'), 'a');
    expect(onPick).toHaveBeenCalledWith('a');
    expect((field('Channel') as HTMLSelectElement).value).toBe('a');
  });

  it('comes smaller for a line of text, and boxless as a ghost', async () => {
    await render(<Form />);
    await vi.waitFor(() => {
      expect(field('Small').getBoundingClientRect().height).toBeLessThan(field('Channel').getBoundingClientRect().height);
      expect(getComputedStyle(field('Ghost')).borderTopColor).toBe('rgba(0, 0, 0, 0)');
    }, { timeout: 5000 });
    expect((field('Ghost') as HTMLSelectElement).disabled).toBe(true);
  });
});
