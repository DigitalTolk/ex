import { describe, expect, it } from 'vitest';
import type { AppView, InputBlock, InputElement, ViewBlock } from '@/types';
import {
  carryValues,
  dayKey,
  firstProblem,
  formatDay,
  inputs,
  isInput,
  maxLengthOf,
  parseDay,
  seedValues,
  toWire,
  validateValues,
} from './app-view-form';

const text = (t: string) => ({ type: 'plain_text' as const, text: t });
const field = (block_id: string, element: InputElement, over: Partial<InputBlock> = {}): InputBlock => ({
  type: 'input',
  block_id,
  label: text(block_id),
  element,
  ...over,
});
const plain = (over: Partial<Extract<InputElement, { type: 'plain_text_input' }>> = {}): InputElement => ({
  type: 'plain_text_input',
  action_id: 'value',
  ...over,
});
const date = (initial_date?: string): InputElement => ({ type: 'datepicker', action_id: 'day', initial_date });
const rooms = [
  { text: text('Room A'), value: 'a' },
  { text: text('Room B'), value: 'b' },
];
const select = (initial?: string): InputElement => ({
  type: 'static_select',
  action_id: 'room',
  options: rooms,
  initial_option: rooms.find((o) => o.value === initial),
});
const form = (blocks: ViewBlock[]): AppView => ({ id: 'V1', type: 'modal', title: text('Form'), blocks, hash: 'h' });

describe('fields of a form', () => {
  it('picks the input blocks out of the layout, in order', () => {
    const header: ViewBlock = { type: 'header', block_id: 'h', text: text('Hi') };
    const reason = field('reason', plain());
    expect(isInput(header)).toBe(false);
    expect(isInput(reason)).toBe(true);
    expect(inputs(form([header, reason, { type: 'divider', block_id: 'd' }]))).toEqual([reason]);
  });
});

describe('seedValues', () => {
  it("starts each field at its own initial value, or empty", () => {
    const view = form([
      field('t1', plain({ initial_value: 'hello' })),
      field('t2', plain()),
      field('d1', date('2026-11-02')),
      field('d2', date()),
      field('s1', select('b')),
      field('s2', select()),
    ]);
    expect(seedValues(view)).toEqual({ t1: 'hello', t2: '', d1: '2026-11-02', d2: '', s1: 'b', s2: '' });
  });
});

describe('carryValues', () => {
  it('keeps what the person entered only in the fields the app kept as they were', () => {
    const prev = form([
      field('kept', plain()),
      field('kept-empty', plain()),
      field('kind', plain()),
      field('action', plain()),
      field('initial', select('a')),
      field('gone', plain()),
    ]);
    const next = form([
      field('kept', plain()),
      field('kept-empty', plain()),
      field('kind', date('2026-11-02')),
      field('action', plain({ action_id: 'other' })),
      field('initial', select('b')),
      field('new', plain({ initial_value: 'fresh' })),
    ]);
    const entered = { kept: 'typed', kind: 'typed', action: 'typed', initial: 'a', gone: 'typed' };
    expect(carryValues(prev, next, entered)).toEqual({
      kept: 'typed',
      'kept-empty': '',
      kind: '2026-11-02',
      action: '',
      initial: 'b',
      new: 'fresh',
    });
  });
});

describe('maxLengthOf', () => {
  it("is a text field's limit, when it has one", () => {
    expect(maxLengthOf(field('a', plain({ max_length: 50 })))).toBe(50);
    expect(maxLengthOf(field('a', plain({ max_length: 0 })))).toBeUndefined();
    expect(maxLengthOf(field('a', plain()))).toBeUndefined();
    expect(maxLengthOf(field('a', date()))).toBeUndefined();
  });
});

describe('validateValues', () => {
  it('asks for every required field in words that fit its kind', () => {
    const view = form([field('t', plain()), field('d', date()), field('s', select())]);
    expect(validateValues(view, { t: '   ', d: '' })).toEqual({
      t: 'Please fill this in.',
      d: 'Please pick a date.',
      s: 'Please choose one.',
    });
  });

  it('lets optional fields stay empty, and skips their length checks', () => {
    const view = form([
      field('t', plain({ min_length: 5 }), { optional: true }),
      field('d', date(), { optional: true }),
      field('s', select(), { optional: true }),
    ]);
    expect(validateValues(view, {})).toBeNull();
  });

  it('holds text to its maximum length, counted in characters people see', () => {
    const view = form([field('t', plain({ max_length: 3 }))]);
    // Three emoji are six UTF-16 units but three characters.
    expect(validateValues(view, { t: '🙂🙂🙂' })).toBeNull();
    expect(validateValues(view, { t: 'four' })).toEqual({ t: 'Keep it to 3 characters.' });
  });

  it('holds text without a stated maximum to the server cap', () => {
    const view = form([field('t', plain())]);
    expect(validateValues(view, { t: 'x'.repeat(3000) })).toBeNull();
    expect(validateValues(view, { t: 'x'.repeat(3001) })).toEqual({ t: 'Keep it to 3000 characters.' });
  });

  it('asks for at least the minimum length', () => {
    const view = form([field('t', plain({ min_length: 3 })), field('d', date()), field('s', select())]);
    expect(validateValues(view, { t: 'ab', d: '2026-11-02', s: 'a' })).toEqual({ t: 'Use at least 3 characters.' });
    expect(validateValues(view, { t: 'abc', d: '2026-11-02', s: 'a' })).toBeNull();
  });
});

describe('toWire', () => {
  it("sends each field's value under its block and action IDs", () => {
    const view = form([field('reason', plain()), field('when', date()), { type: 'divider', block_id: 'd' }]);
    expect(toWire(view, { reason: 'sick' })).toEqual({ reason: { value: 'sick' }, when: { day: '' } });
  });
});

describe('firstProblem', () => {
  it('is the earliest field in the form that needs fixing', () => {
    const view = form([field('a', plain()), field('b', plain()), field('c', plain())]);
    expect(firstProblem(view, { c: 'x', b: 'y' })).toBe('b');
    expect(firstProblem(view, {})).toBeUndefined();
  });
});

describe('days', () => {
  it('writes a local calendar day as YYYY-MM-DD and reads it back', () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(dayKey(new Date(2026, 10, 23))).toBe('2026-11-23');
    const day = parseDay('2026-11-02')!;
    expect([day.getFullYear(), day.getMonth(), day.getDate()]).toEqual([2026, 10, 2]);
    expect(parseDay('')).toBeUndefined();
    expect(parseDay('2026-11-2')).toBeUndefined();
    expect(parseDay('next week')).toBeUndefined();
  });

  it('formats a day for reading, and leaves anything else as it is', () => {
    const expected = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(
      new Date(2026, 10, 2),
    );
    expect(formatDay('2026-11-02')).toBe(expected);
    expect(formatDay('soon')).toBe('soon');
  });
});
