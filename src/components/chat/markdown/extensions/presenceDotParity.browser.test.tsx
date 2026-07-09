import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { PresenceDot } from '@/components/PresenceDot';
import { presenceNotchStyle, PRESENCE_DOT_DEFAULT_SIZE } from '@/lib/presence';
import { composerTheme } from '../theme';
import { renderMentionOption, type MentionCompletion } from './optionRender';

// The typeahead popup is plain DOM rendered by CodeMirror, so it cannot host
// the React <PresenceDot>. These tests pin the hand-rendered dot's COMPUTED
// styles against the real PresenceDot in the same document — if either
// implementation drifts (color token, size, ring stroke, notch geometry),
// this fails instead of shipping a second visual language.

// Mount a real EditorView with the real composer theme and adopt a rendered
// option row into it, so `.cm-option-*` rules resolve exactly as they do in
// the live autocomplete tooltip (CodeMirror scopes theme CSS to the editor).
function mountOptionRow(meta: MentionCompletion['meta']): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const view = new EditorView({
    parent: host,
    state: EditorState.create({ doc: '', extensions: [composerTheme] }),
  });
  const row = renderMentionOption({ label: 'x', meta } as MentionCompletion) as HTMLElement;
  view.dom.appendChild(row);
  return row;
}

async function renderReferenceDot(online: boolean): Promise<HTMLElement> {
  const screen = await render(
    <span style={{ position: 'relative', display: 'inline-block', width: 28, height: 28 }}>
      <PresenceDot online={online} testId="reference-dot" />
    </span>,
  );
  return screen.container.querySelector('[data-testid="reference-dot"]') as HTMLElement;
}

describe('typeahead presence dot parity with PresenceDot', () => {
  it('online: same size, radius and presence-green fill', async () => {
    const reference = await renderReferenceDot(true);
    const row = mountOptionRow({ kind: 'user', displayName: 'Alice', online: true });
    const dot = row.querySelector('.cm-option-dot') as HTMLElement;

    const got = getComputedStyle(dot);
    const want = getComputedStyle(reference);
    expect(got.width).toBe(want.width);
    expect(got.height).toBe(want.height);
    // Tailwind's rounded-full computes to calc(infinity*1px), the theme to
    // 9999px — assert the property that matters: both are fully round
    // (radius >= half the dot) rather than string-equal.
    for (const radius of [got.borderRadius, want.borderRadius]) {
      expect(parseFloat(radius)).toBeGreaterThanOrEqual(parseFloat(got.width) / 2);
    }
    expect(got.backgroundColor).toBe(want.backgroundColor);
    // And it is the presence token, not any other accent (the old bug was
    // brand pink here).
    const online = getComputedStyle(document.documentElement).getPropertyValue('--color-online').trim();
    const probe = document.createElement('span');
    probe.style.backgroundColor = online;
    document.body.appendChild(probe);
    expect(got.backgroundColor).toBe(getComputedStyle(probe).backgroundColor);
  });

  it('offline: same hollow ring — transparent fill, muted stroke, same width', async () => {
    const reference = await renderReferenceDot(false);
    const row = mountOptionRow({ kind: 'user', displayName: 'Bob', online: false });
    const dot = row.querySelector('.cm-option-dot') as HTMLElement;

    const got = getComputedStyle(dot);
    const want = getComputedStyle(reference);
    expect(got.width).toBe(want.width);
    expect(got.height).toBe(want.height);
    expect(got.backgroundColor).toBe(want.backgroundColor); // transparent
    expect(got.borderStyle).toBe(want.borderStyle);
    expect(got.borderColor).toBe(want.borderColor);
    expect(got.borderWidth).toBe(want.borderWidth);
  });

  it('carves the same notch out of the avatar as every other avatar surface', () => {
    const row = mountOptionRow({ kind: 'user', displayName: 'Alice', online: true });
    const avatar = row.querySelector('.cm-option-avatar--notched') as HTMLElement;

    // Reference: an element carrying presenceNotchStyle inline, exactly how
    // UserAvatar applies it.
    const reference = document.createElement('span');
    Object.assign(reference.style, presenceNotchStyle(PRESENCE_DOT_DEFAULT_SIZE));
    document.body.appendChild(reference);

    const got = getComputedStyle(avatar);
    const want = getComputedStyle(reference);
    const mask = (s: CSSStyleDeclaration) =>
      s.maskImage && s.maskImage !== 'none' ? s.maskImage : s.webkitMaskImage;
    expect(mask(got)).toBe(mask(want));
    expect(mask(got)).toContain('radial-gradient');
  });
});
