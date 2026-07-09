import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import type { CustomEmoji } from '@/types';
import { rankEmoji, emojiSource, type EmojiProviders } from './emojiAutocomplete';
import { apiFetch } from '@/lib/api';

// Applying a completion records an emoji "use" (feeds the popular shelf) —
// mock the api layer so each apply's POST can be asserted.
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(async () => undefined),
}));

beforeEach(() => {
  vi.mocked(apiFetch).mockClear();
});

function lastRecordedEmoji(): string | undefined {
  const call = vi.mocked(apiFetch).mock.calls.find(([url]) => url === '/api/v1/emojis/frequent');
  if (!call) return undefined;
  return (JSON.parse((call[1] as { body: string }).body) as { emoji: string }).emoji;
}

const customEmojis: CustomEmoji[] = [
  { name: 'parrot', imageURL: 'https://x.test/parrot.gif' } as CustomEmoji,
];

const providers: EmojiProviders = {
  customEmojis: () => customEmojis,
  skinTone: () => '',
};

function ctxFor(doc: string): CompletionContext {
  return new CompletionContext(EditorState.create({ doc }), doc.length, false);
}

function makeView(doc: string): EditorView {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return new EditorView({ parent: host, state: EditorState.create({ doc }) });
}

describe('rankEmoji', () => {
  it('ranks an exact shortcode name first', () => {
    const out = rankEmoji('smile', []);
    expect(out[0]).toMatchObject({ kind: 'standard', name: 'smile' });
  });

  it('puts custom emoji ahead of standard ones', () => {
    const out = rankEmoji('parrot', customEmojis);
    expect(out[0]).toEqual({ kind: 'custom', name: 'parrot', imageURL: 'https://x.test/parrot.gif' });
  });

  it('falls back to fuzzy matching for near-miss queries', () => {
    // "smils" is a one-edit typo of "smile" → reached only via the fuzzy arm.
    const out = rankEmoji('smils', []);
    expect(out.some((h) => h.kind === 'standard' && h.name === 'smile')).toBe(true);
  });

  it('returns nothing for a query that matches no shortcode', () => {
    expect(rankEmoji('zzzznotanemoji', [])).toHaveLength(0);
  });

  it('caps the combined list and lets custom hits shrink the standard slots', () => {
    const many: CustomEmoji[] = Array.from({ length: 8 }, (_, i) => ({ name: `smile${i}`, imageURL: `u${i}` } as CustomEmoji));
    const out = rankEmoji('smile', many);
    expect(out).toHaveLength(8);
    expect(out.every((h) => h.kind === 'custom')).toBe(true);
  });
});

describe('emojiSource', () => {
  it('returns ranked completions for a :query', () => {
    const res = emojiSource(providers)(ctxFor('hi :smile')) as CompletionResult;
    expect(res).not.toBeNull();
    expect(res.from).toBe(3);
    expect(res.filter).toBe(false);
    expect(res.options[0].label).toBe(':smile:');
    expect(res.options[0].detail).toBeTruthy(); // the unicode glyph
  });

  it('groups emoji under an "Emoji" section header', () => {
    const res = emojiSource(providers)(ctxFor(':smile')) as CompletionResult;
    const section = res.options[0].section;
    const name = typeof section === 'string' ? section : section?.name;
    expect(name).toBe('Emoji');
    // The header renderer produces the shared section element.
    const header = (typeof section === 'object' && section?.header)?.(section);
    expect((header as HTMLElement | undefined)?.textContent).toBe('Emoji');
  });

  it('does not trigger on a bare colon (needs a query char)', () => {
    expect(emojiSource(providers)(ctxFor('a : '))).toBeNull();
  });

  it('returns null when there is no colon before the caret', () => {
    expect(emojiSource(providers)(ctxFor('plain'))).toBeNull();
  });

  it('inserts the :shortcode: text with a trailing space on apply', () => {
    const view = makeView('hi :smile');
    const res = emojiSource(providers)(new CompletionContext(view.state, 9, false)) as CompletionResult;
    const opt = res.options[0];
    (opt.apply as (v: EditorView, c: typeof opt, f: number, t: number) => void)(view, opt, res.from, res.to);
    expect(view.state.doc.toString()).toBe('hi :smile: ');
    // The pick was recorded as a use so the popular shelf keeps reordering.
    expect(lastRecordedEmoji()).toBe(':smile:');
    view.destroy();
  });

  it('applies the user skin tone suffix for supporting standard emoji', () => {
    const toned: EmojiProviders = { customEmojis: () => [], skinTone: () => 'dark' };
    const view = makeView(':wave');
    const res = emojiSource(toned)(new CompletionContext(view.state, 5, false)) as CompletionResult;
    const opt = res.options.find((o) => o.label === ':wave:')!;
    (opt.apply as (v: EditorView, c: typeof opt, f: number, t: number) => void)(view, opt, res.from, res.to);
    // wave supports skin tone → a `::skin-tone:` suffix is appended.
    expect(view.state.doc.toString()).toMatch(/^:wave::skin-tone-\d: $/);
    // The recorded use carries the SAME toned shortcode the picker records.
    expect(lastRecordedEmoji()).toMatch(/^:wave::skin-tone-\d:$/);
    view.destroy();
  });

  it('inserts a plain :name: for a custom emoji (no skin tone)', () => {
    const view = makeView(':parrot');
    const res = emojiSource(providers)(new CompletionContext(view.state, 7, false)) as CompletionResult;
    const opt = res.options.find((o) => o.label === ':parrot:')!;
    expect(opt.detail).toBe('custom');
    (opt.apply as (v: EditorView, c: typeof opt, f: number, t: number) => void)(view, opt, res.from, res.to);
    expect(view.state.doc.toString()).toBe(':parrot: ');
    expect(lastRecordedEmoji()).toBe(':parrot:');
    view.destroy();
  });
});
