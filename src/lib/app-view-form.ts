import type { AppView, InputBlock, ViewBlock } from '@/types';

// A form's values: what each field holds, by block ID — text as typed, a
// date as YYYY-MM-DD, a select's option value; "" is empty.
export type FormValues = Record<string, string>;

const MAX_INPUT_CHARS = 3000;

export const isInput = (block: ViewBlock): block is InputBlock => block.type === 'input';

export const inputs = (view: AppView): InputBlock[] => view.blocks.filter(isInput);

function initialOf(block: InputBlock): string {
  const el = block.element;
  switch (el.type) {
    case 'plain_text_input':
      return el.initial_value ?? '';
    case 'datepicker':
      return el.initial_date ?? '';
    case 'static_select':
      return el.initial_option?.value ?? '';
  }
}

// seedValues is a newly opened form's values: each field's initial one.
export function seedValues(view: AppView): FormValues {
  return Object.fromEntries(inputs(view).map((b) => [b.block_id, initialOf(b)]));
}

// carryValues fills an updated form: a field the app kept as it was (same
// block, element and starting value) keeps what the person entered; any
// other starts from its own initial value.
export function carryValues(prev: AppView, next: AppView, values: FormValues): FormValues {
  const before = new Map(inputs(prev).map((b) => [b.block_id, b]));
  return Object.fromEntries(
    inputs(next).map((b) => {
      const old = before.get(b.block_id);
      const same =
        old && old.element.type === b.element.type && old.element.action_id === b.element.action_id && initialOf(old) === initialOf(b);
      return [b.block_id, same ? (values[b.block_id] ?? '') : initialOf(b)];
    }),
  );
}

export const maxLengthOf = (block: InputBlock): number | undefined =>
  block.element.type === 'plain_text_input' ? block.element.max_length || undefined : undefined;

// validateValues checks the form as the server will (required fields and
// text lengths), so the person sees what to fix without a round trip. The
// server checks again against the form it stored.
export function validateValues(view: AppView, values: FormValues): Record<string, string> | null {
  const problems: Record<string, string> = {};
  for (const b of inputs(view)) {
    const v = values[b.block_id] ?? '';
    if (!v.trim()) {
      if (!b.optional) {
        problems[b.block_id] =
          b.element.type === 'datepicker' ? 'Please pick a date.' : b.element.type === 'static_select' ? 'Please choose one.' : 'Please fill this in.';
      }
      continue;
    }
    if (b.element.type === 'plain_text_input') {
      const max = b.element.max_length || MAX_INPUT_CHARS;
      const length = [...v].length;
      if (length > max) problems[b.block_id] = `Keep it to ${max} characters.`;
      else if (b.element.min_length && length < b.element.min_length) problems[b.block_id] = `Use at least ${b.element.min_length} characters.`;
    }
  }
  return Object.keys(problems).length ? problems : null;
}

// toWire is the submission's body: {block_id: {action_id: value}}.
export function toWire(view: AppView, values: FormValues): Record<string, Record<string, string>> {
  return Object.fromEntries(inputs(view).map((b) => [b.block_id, { [b.element.action_id]: values[b.block_id] ?? '' }]));
}

// firstProblem is the earliest field, in form order, that needs fixing.
export function firstProblem(view: AppView, problems: Record<string, string>): string | undefined {
  return inputs(view).find((b) => problems[b.block_id])?.block_id;
}

// ---- dates: a field's YYYY-MM-DD is a calendar day, read in local time

export function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseDay(value: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : undefined;
}

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

export function formatDay(value: string): string {
  const day = parseDay(value);
  return day ? DAY_FORMAT.format(day) : value;
}
