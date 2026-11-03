import { describe, expect, it } from 'vitest';
import type { AppView, InputBlock, InputElement, ViewBlock } from '@/types';
import {
  carryValues,
  dayKey,
  firstProblem,
  formatDay,
  initialOf,
  inputs,
  isInput,
  isMulti,
  maxLengthOf,
  parseDay,
  seedValues,
  segments,
  sentAnswers,
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

describe('segments', () => {
  it('keeps each field on its own and runs of other blocks together', () => {
    const header: ViewBlock = { type: 'header', block_id: 'h', text: text('Hi') };
    const divider: ViewBlock = { type: 'divider', block_id: 'd' };
    const context: ViewBlock = { type: 'context', block_id: 'c', elements: [text('note')] };
    const a = field('a', plain());
    const b = field('b', plain());
    expect(segments([header, divider, a, b, context])).toEqual([[header, divider], a, b, [context]]);
    expect(segments([])).toEqual([]);
  });
});

const opts = (...values: string[]) => values.map((v) => ({ text: text(v.toUpperCase()), value: v }));

describe('initialOf', () => {
  it("is each kind's starting value: text, a day, a time, an option, a person, or a list", () => {
    const cases: Array<[InputElement, unknown, unknown]> = [
      [plain({ initial_value: 'hi' }), 'hi', ''],
      [{ type: 'number_input', action_id: 'n', initial_value: '4' }, '4', ''],
      [{ type: 'email_text_input', action_id: 'e', initial_value: 'a@b.co' }, 'a@b.co', ''],
      [{ type: 'url_text_input', action_id: 'u', initial_value: 'https://x.test' }, 'https://x.test', ''],
      [date('2026-11-02'), '2026-11-02', ''],
      [{ type: 'timepicker', action_id: 't', initial_time: '09:30' }, '09:30', ''],
      [select('a'), 'a', ''],
      [{ type: 'radio_buttons', action_id: 'r', options: opts('x', 'y'), initial_option: opts('y')[0] }, 'y', ''],
      [{ type: 'users_select', action_id: 'p', initial_user: 'u-1' }, 'u-1', ''],
      [{ type: 'multi_static_select', action_id: 'm', options: opts('x', 'y'), initial_options: opts('x', 'y') }, ['x', 'y'], []],
      [{ type: 'checkboxes', action_id: 'c', options: opts('x', 'y'), initial_options: opts('y') }, ['y'], []],
      [{ type: 'multi_users_select', action_id: 'mu', initial_users: ['u-1', 'u-2'] }, ['u-1', 'u-2'], []],
    ];
    for (const [el, seeded, empty] of cases) {
      expect(initialOf(el)).toEqual(seeded);
      // The same element without its initial value starts empty.
      const bare = Object.fromEntries(Object.entries(el).filter(([k]) => !k.startsWith('initial_'))) as InputElement;
      expect(initialOf(bare)).toEqual(empty);
    }
  });

  it('tells the kinds that hold a list', () => {
    expect(isMulti({ type: 'multi_static_select', action_id: 'm', options: [] })).toBe(true);
    expect(isMulti({ type: 'checkboxes', action_id: 'c', options: [] })).toBe(true);
    expect(isMulti({ type: 'multi_users_select', action_id: 'mu' })).toBe(true);
    expect(isMulti({ type: 'static_select', action_id: 's', options: [] })).toBe(false);
    expect(isMulti(plain())).toBe(false);
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

describe('carryValues with lists', () => {
  it('keeps a picked list while the app keeps the field, and resets it when the starting list changes', () => {
    const boxes = (...initial: string[]): InputElement => ({ type: 'checkboxes', action_id: 'c', options: opts('x', 'y', 'z'), initial_options: opts(...initial) });
    const prev = form([field('kept', boxes('x')), field('changed', boxes('x'))]);
    const next = form([field('kept', boxes('x')), field('changed', boxes('x', 'y'))]);
    expect(carryValues(prev, next, { kept: ['y', 'z'], changed: ['z'] })).toEqual({ kept: ['y', 'z'], changed: ['x', 'y'] });
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

describe('validateValues for every kind', () => {
  it('asks for each empty required field in words that fit its kind', () => {
    const view = form([
      field('time', { type: 'timepicker', action_id: 't' }),
      field('radio', { type: 'radio_buttons', action_id: 'r', options: opts('x') }),
      field('who', { type: 'users_select', action_id: 'p' }),
      field('multi', { type: 'multi_static_select', action_id: 'm', options: opts('x') }),
      field('boxes', { type: 'checkboxes', action_id: 'c', options: opts('x') }),
      field('people', { type: 'multi_users_select', action_id: 'mu' }),
      field('num', { type: 'number_input', action_id: 'n' }),
      field('mail', { type: 'email_text_input', action_id: 'e' }),
      field('link', { type: 'url_text_input', action_id: 'u' }),
    ]);
    expect(validateValues(view, { boxes: [] })).toEqual({
      time: 'Please pick a time.',
      radio: 'Please choose one.',
      who: 'Please choose one.',
      multi: 'Please choose at least one.',
      boxes: 'Please choose at least one.',
      people: 'Please choose at least one.',
      num: 'Please fill this in.',
      mail: 'Please fill this in.',
      link: 'Please fill this in.',
    });
  });

  it('reads a whole number, or a decimal where allowed, within its bounds', () => {
    const whole = form([field('n', { type: 'number_input', action_id: 'n', min_value: '1', max_value: '10' })]);
    expect(validateValues(whole, { n: ' 5 ' })).toBeNull();
    expect(validateValues(whole, { n: '-0' })).toEqual({ n: 'Use at least 1.' });
    expect(validateValues(whole, { n: '11' })).toEqual({ n: 'Use at most 10.' });
    expect(validateValues(whole, { n: '1.5' })).toEqual({ n: 'Enter a whole number.' });
    expect(validateValues(whole, { n: 'five' })).toEqual({ n: 'Enter a whole number.' });

    const decimal = form([field('n', { type: 'number_input', action_id: 'n', is_decimal_allowed: true })]);
    for (const ok of ['1.5', '-2.', '.25', '-7', '3']) expect(validateValues(decimal, { n: ok })).toBeNull();
    for (const bad of ['1.2.3', '.', '1e5', '--1']) expect(validateValues(decimal, { n: bad })).toEqual({ n: 'Enter a number.' });
  });

  it('wants an email address and a web link in their usual shapes', () => {
    const view = form([field('mail', { type: 'email_text_input', action_id: 'e' }), field('link', { type: 'url_text_input', action_id: 'u' })]);
    expect(validateValues(view, { mail: ' name@example.com ', link: 'HTTPS://example.com/a?b=1' })).toBeNull();
    expect(validateValues(view, { mail: 'name@example', link: 'ftp://example.com' })).toEqual({
      mail: 'Enter an email address like name@example.com.',
      link: 'Enter a link that starts with https://',
    });
    expect(validateValues(view, { mail: 'a b@c.d', link: 'http://' })).toEqual({
      mail: 'Enter an email address like name@example.com.',
      link: 'Enter a link that starts with https://',
    });
  });

  it('holds a multi-select and a list of people to their caps', () => {
    const view = form([
      field('m', { type: 'multi_static_select', action_id: 'm', options: opts('x', 'y', 'z'), max_selected_items: 2 }),
      field('p', { type: 'multi_users_select', action_id: 'p', max_selected_items: 1 }),
      field('free', { type: 'multi_static_select', action_id: 'f', options: opts('x', 'y', 'z') }),
      field('c', { type: 'checkboxes', action_id: 'c', options: opts('x', 'y', 'z') }),
    ]);
    expect(validateValues(view, { m: ['x', 'y'], p: ['u-1'], free: ['x', 'y', 'z'], c: ['x', 'y', 'z'] })).toBeNull();
    expect(validateValues(view, { m: ['x', 'y', 'z'], p: ['u-1', 'u-2'], free: ['x'], c: ['x'] })).toEqual({
      m: 'Choose at most 2.',
      p: 'Choose at most 1.',
    });
  });

  it('takes any filled day, time, choice or person as it is', () => {
    const view = form([
      field('d', date()),
      field('t', { type: 'timepicker', action_id: 't' }),
      field('s', select()),
      field('who', { type: 'users_select', action_id: 'p' }),
    ]);
    expect(validateValues(view, { d: '2026-11-02', t: '09:30', s: 'a', who: 'u-1' })).toBeNull();
  });
});

describe('toWire', () => {
  it("sends each field's value under its block and action IDs", () => {
    const view = form([field('reason', plain()), field('when', date()), { type: 'divider', block_id: 'd' }]);
    expect(toWire(view, { reason: 'sick' })).toEqual({ reason: { value: 'sick' }, when: { day: '' } });
  });

  it('sends a list as a list', () => {
    const view = form([
      field('tags', { type: 'checkboxes', action_id: 'tags', options: opts('x', 'y') }),
      field('who', { type: 'multi_users_select', action_id: 'who', initial_users: ['u-1'] }),
    ]);
    expect(toWire(view, { tags: ['x', 'y'] })).toEqual({ tags: { tags: ['x', 'y'] }, who: { who: ['u-1'] } });
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

describe('sentAnswers', () => {
  it('says each answer in words: option texts, the day written out, people by ID, text as typed', () => {
    const view = form([
      { type: 'header', block_id: 'h', text: text('Hi') },
      field('reason', plain(), { label: text('Reason') }),
      field('when', date(), { label: text('Day') }),
      field('room', select(), { label: text('Room') }),
      field('size', { type: 'radio_buttons', action_id: 'r', options: rooms }, { label: text('Size') }),
      field('tags', { type: 'multi_static_select', action_id: 'm', options: rooms }, { label: text('Tags') }),
      field('boxes', { type: 'checkboxes', action_id: 'c', options: rooms }, { label: text('Boxes') }),
      field('host', { type: 'users_select', action_id: 'u' }, { label: text('Host') }),
      field('guests', { type: 'multi_users_select', action_id: 'g' }, { label: text('Guests') }),
      field('at', { type: 'timepicker', action_id: 't' }, { label: text('At') }),
    ]);
    expect(
      sentAnswers(view, {
        reason: 'Out sick',
        when: '2026-11-18',
        room: 'b',
        size: 'a',
        tags: ['a', 'b'],
        boxes: ['b'],
        host: 'u-bob',
        guests: ['u-bob', 'u-carol'],
        at: '10:30',
      }),
    ).toEqual([
      { label: 'Reason', text: 'Out sick' },
      { label: 'Day', text: 'Wed, Nov 18, 2026' },
      { label: 'Room', text: 'Room B' },
      { label: 'Size', text: 'Room A' },
      { label: 'Tags', text: 'Room A, Room B' },
      { label: 'Boxes', text: 'Room B' },
      { label: 'Host', userIDs: ['u-bob'] },
      { label: 'Guests', userIDs: ['u-bob', 'u-carol'] },
      { label: 'At', text: '10:30' },
    ]);
  });

  it('leaves out what was left empty, reads a field with no value as its starting one, and shows an unlisted option as is', () => {
    const view = form([
      field('note', plain(), { label: text('Note'), optional: true }),
      field('none', { type: 'checkboxes', action_id: 'c', options: rooms }, { label: text('None'), optional: true }),
      field('room', select('a'), { label: text('Room') }),
      field('gone', select(), { label: text('Gone') }),
    ]);
    expect(sentAnswers(view, { note: '   ', none: [], gone: 'zz' })).toEqual([
      { label: 'Room', text: 'Room A' },
      { label: 'Gone', text: 'zz' },
    ]);
  });
});

