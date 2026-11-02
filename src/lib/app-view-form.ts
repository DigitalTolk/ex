import type { AppView, Block, InputBlock, InputElement, ViewBlock } from '@/types';

// A form's values by block ID: text as typed, a date as YYYY-MM-DD, a time
// as HH:MM, an option's value or a user ID — or, for the elements that hold
// several (multi-selects, checkboxes, people), a list. "" or [] is empty.
export type FormValue = string | string[];
export type FormValues = Record<string, FormValue>;

const MAX_INPUT_CHARS = 3000;

export const isInput = (block: ViewBlock): block is InputBlock => block.type === 'input';

export const inputs = (view: AppView): InputBlock[] => view.blocks.filter(isInput);

// segments groups a form's blocks: each field on its own, and runs of other
// blocks together, drawn by the message block renderer.
export function segments(blocks: ViewBlock[]): Array<InputBlock | Block[]> {
  const out: Array<InputBlock | Block[]> = [];
  for (const block of blocks) {
    if (isInput(block)) out.push(block);
    else {
      const last = out[out.length - 1];
      if (Array.isArray(last)) last.push(block);
      else out.push([block]);
    }
  }
  return out;
}

// isMulti reports whether an element holds a list.
export const isMulti = (el: InputElement) => el.type === 'multi_static_select' || el.type === 'checkboxes' || el.type === 'multi_users_select';

export function initialOf(el: InputElement): FormValue {
  switch (el.type) {
    case 'plain_text_input':
    case 'number_input':
    case 'email_text_input':
    case 'url_text_input':
      return el.initial_value ?? '';
    case 'datepicker':
      return el.initial_date ?? '';
    case 'timepicker':
      return el.initial_time ?? '';
    case 'static_select':
    case 'radio_buttons':
      return el.initial_option?.value ?? '';
    case 'users_select':
      return el.initial_user ?? '';
    case 'multi_static_select':
    case 'checkboxes':
      return el.initial_options?.map((o) => o.value) ?? [];
    case 'multi_users_select':
      return el.initial_users ?? [];
  }
}

// seedValues is a newly opened form's values: each field's initial one.
export function seedValues(view: AppView): FormValues {
  return Object.fromEntries(inputs(view).map((b) => [b.block_id, initialOf(b.element)]));
}

const sameValue = (a: FormValue, b: FormValue) => JSON.stringify(a) === JSON.stringify(b);

// carryValues fills an updated form: a field the app kept as it was (same
// block, element and starting value) keeps what the person entered; any
// other starts from its own initial value.
export function carryValues(prev: AppView, next: AppView, values: FormValues): FormValues {
  const before = new Map(inputs(prev).map((b) => [b.block_id, b]));
  return Object.fromEntries(
    inputs(next).map((b) => {
      const old = before.get(b.block_id);
      const same =
        old && old.element.type === b.element.type && old.element.action_id === b.element.action_id && sameValue(initialOf(old.element), initialOf(b.element));
      return [b.block_id, same ? (values[b.block_id] ?? initialOf(b.element)) : initialOf(b.element)];
    }),
  );
}

export const maxLengthOf = (block: InputBlock): number | undefined =>
  block.element.type === 'plain_text_input' ? block.element.max_length || undefined : undefined;

const isEmpty = (v: FormValue | undefined) => (Array.isArray(v) ? v.length === 0 : !v?.trim());

const emptyMessage = (el: InputElement) => {
  switch (el.type) {
    case 'datepicker':
      return 'Please pick a date.';
    case 'timepicker':
      return 'Please pick a time.';
    case 'static_select':
    case 'radio_buttons':
    case 'users_select':
      return 'Please choose one.';
    case 'multi_static_select':
    case 'checkboxes':
    case 'multi_users_select':
      return 'Please choose at least one.';
    default:
      return 'Please fill this in.';
  }
};

// A plain decimal number, as the server reads one: digits, an optional
// leading minus, and (when decimals are allowed) one point.
const NUMBER = { whole: /^-?\d+$/, decimal: /^-?(\d+\.?\d*|\.\d+)$/ };
const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

function valueProblem(el: InputElement, v: FormValue): string | undefined {
  switch (el.type) {
    case 'plain_text_input': {
      const s = v as string;
      const max = el.max_length || MAX_INPUT_CHARS;
      const length = [...s].length;
      if (length > max) return `Keep it to ${max} characters.`;
      if (el.min_length && length < el.min_length) return `Use at least ${el.min_length} characters.`;
      return undefined;
    }
    case 'number_input': {
      const s = (v as string).trim();
      if (!(el.is_decimal_allowed ? NUMBER.decimal : NUMBER.whole).test(s)) return el.is_decimal_allowed ? 'Enter a number.' : 'Enter a whole number.';
      const n = Number(s);
      if (el.min_value !== undefined && n < Number(el.min_value)) return `Use at least ${el.min_value}.`;
      if (el.max_value !== undefined && n > Number(el.max_value)) return `Use at most ${el.max_value}.`;
      return undefined;
    }
    case 'email_text_input':
      return EMAIL.test((v as string).trim()) ? undefined : 'Enter an email address like name@example.com.';
    case 'url_text_input':
      return /^https?:\/\/\S+$/i.test((v as string).trim()) ? undefined : 'Enter a link that starts with https://';
    case 'multi_static_select':
    case 'multi_users_select': {
      const max = el.max_selected_items;
      return max && (v as string[]).length > max ? `Choose at most ${max}.` : undefined;
    }
    default:
      return undefined;
  }
}

// validateValues checks the form as the server will — required fields,
// lengths, number bounds, email and link shapes, selection caps — so the
// person sees what to fix without a round trip. The server checks again
// against the form it stored.
export function validateValues(view: AppView, values: FormValues): Record<string, string> | null {
  const problems: Record<string, string> = {};
  for (const b of inputs(view)) {
    const v = values[b.block_id] ?? initialOf(b.element);
    if (isEmpty(v)) {
      if (!b.optional) problems[b.block_id] = emptyMessage(b.element);
      continue;
    }
    const problem = valueProblem(b.element, v);
    if (problem) problems[b.block_id] = problem;
  }
  return Object.keys(problems).length ? problems : null;
}

// toWire is the submission's body: {block_id: {action_id: value}}.
export function toWire(view: AppView, values: FormValues): Record<string, Record<string, FormValue>> {
  return Object.fromEntries(inputs(view).map((b) => [b.block_id, { [b.element.action_id]: values[b.block_id] ?? initialOf(b.element) }]));
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

// ---- what was sent, for the form's confirmation

// An answer as the person gave it: the field's label and, in words, what they
// entered — option texts rather than values, dates written out. People are
// named by the caller (their names aren't in the form).
export interface SentAnswer {
  label: string;
  text?: string;
  userIDs?: string[];
}

export function sentAnswers(view: AppView, values: FormValues): SentAnswer[] {
  const out: SentAnswer[] = [];
  for (const b of inputs(view)) {
    const el = b.element;
    const v = values[b.block_id] ?? initialOf(el);
    if (isEmpty(v)) continue;
    const label = b.label.text;
    const list = Array.isArray(v) ? v : [v];
    switch (el.type) {
      case 'users_select':
      case 'multi_users_select':
        out.push({ label, userIDs: list });
        break;
      case 'static_select':
      case 'radio_buttons':
      case 'multi_static_select':
      case 'checkboxes':
        out.push({ label, text: list.map((x) => el.options.find((o) => o.value === x)?.text.text ?? x).join(', ') });
        break;
      case 'datepicker':
        out.push({ label, text: formatDay(list[0]) });
        break;
      default:
        out.push({ label, text: list[0] });
    }
  }
  return out;
}
