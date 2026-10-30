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

  it('lists the standard emoji first among equal matches', () => {
    const out = rankEmoji('parrot', customEmojis);
    expect(out[0]).toMatchObject({ kind: 'standard', name: 'parrot' });
    expect(out[1]).toEqual({ kind: 'custom', name: 'parrot', imageURL: 'https://x.test/parrot.gif' });
  });

  it('ranks custom emoji by how well they match, not ahead of everything', () => {
    const lookalikes = ['keys', 'yes', 'dyes', 'eyes_rolling', 'party_eyes'].map(
      (name) => ({ name, imageURL: `https://x.test/${name}.png` }) as CustomEmoji,
    );
    const out = rankEmoji('eyes', lookalikes);
    expect(out[0]).toMatchObject({ kind: 'standard', name: 'eyes' });
    const names = out.map((h) => h.name);
    // A prefix match beats a substring match, which beats a one-letter typo
    // (here pushed out of the list by the many emoji that contain "eyes").
    expect(names.indexOf('eyes_rolling')).toBeLessThan(names.indexOf('party_eyes'));
    expect(names.slice(0, names.indexOf('party_eyes'))).not.toContain('keys');
  });

  it('a custom emoji named exactly as typed comes before a standard prefix match', () => {
    const out = rankEmoji('party', [{ name: 'party', imageURL: 'u' } as CustomEmoji]);
    expect(out[0]).toEqual({ kind: 'custom', name: 'party', imageURL: 'u' });
  });

  it('falls back to fuzzy matching for near-miss queries', () => {
    // "smils" is a one-edit typo of "smile" → reached only via the fuzzy arm.
    const out = rankEmoji('smils', []);
    expect(out.some((h) => h.kind === 'standard' && h.name === 'smile')).toBe(true);
  });

  it('returns nothing for a query that matches no shortcode', () => {
    expect(rankEmoji('zzzznotanemoji', [])).toHaveLength(0);
  });

  it('keeps the standard matches when many custom emoji match too, up to 50 in all', () => {
    const many: CustomEmoji[] = Array.from({ length: 60 }, (_, i) => ({ name: `smile${i}`, imageURL: `u${i}` } as CustomEmoji));
    const out = rankEmoji('smile', many);
    expect(out).toHaveLength(50);
    expect(out[0]).toMatchObject({ kind: 'standard', name: 'smile' });
    expect(out.some((h) => h.kind === 'custom')).toBe(true);
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

  it.each(['ok :P', ':D', 'hi :p'])('leaves the emoticon %s as typed', (doc) => {
    expect(emojiSource(providers)(ctxFor(doc))).toBeNull();
  });

  it('opens once two characters follow the colon', () => {
    const res = emojiSource(providers)(ctxFor('ok :Pa')) as CompletionResult;
    expect(res.from).toBe(3);
    expect(res.options.length).toBeGreaterThan(0);
  });

  it('does not open on the colon of a time or inside a word', () => {
    expect(emojiSource(providers)(ctxFor('meet at 10:30'))).toBeNull();
    expect(emojiSource(providers)(ctxFor('note:smile'))).toBeNull();
  });

  it('opens on the second of two emoji typed back to back', () => {
    const res = emojiSource(providers)(ctxFor(':fire::smi')) as CompletionResult;
    expect(res.from).toBe(6);
    expect(res.options[0].label).toBe(':smile:');
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
    const opt = res.options.find((o) => o.label === ':parrot:' && o.detail === 'custom')!;
    (opt.apply as (v: EditorView, c: typeof opt, f: number, t: number) => void)(view, opt, res.from, res.to);
    expect(view.state.doc.toString()).toBe(':parrot: ');
    expect(lastRecordedEmoji()).toBe(':parrot:');
    view.destroy();
  });
});
