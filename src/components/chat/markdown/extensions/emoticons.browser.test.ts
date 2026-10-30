import { describe, it, expect, afterEach } from 'vitest';
import { userEvent } from 'vitest/browser';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { history, historyKeymap } from '@codemirror/commands';
import { composerMarkdown } from '../language';
import { emoticonsToEmoji } from './emoticons';

// Typing a space after an emoticon turns it into its standard emoji.

let view: EditorView | undefined;
afterEach(() => {
  view?.destroy();
  view?.dom.parentElement?.remove();
  view = undefined;
});

async function typeInto(doc: string, keys: string, at = doc.length) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      selection: { anchor: at },
      extensions: [history(), keymap.of(historyKeymap), composerMarkdown, emoticonsToEmoji],
    }),
  });
  await userEvent.click(view.contentDOM);
  view.dispatch({ selection: { anchor: at } });
  await userEvent.keyboard(keys);
  return view;
}

describe('emoticons to emoji', () => {
  it('turns :P into 😛 on the space after it', async () => {
    const v = await typeInto('', 'hi :P ');
    await expect.poll(() => v.state.doc.toString()).toBe('hi 😛 ');
    expect(v.state.selection.main.head).toBe(v.state.doc.length);
  });

  it.each([
    [':)', '🙂'],
    [':p', '😛'],
    [':-D', '😄'],
    [';)', '😉'],
    ['<3', '❤️'],
  ])('turns %s into %s', async (emoticon, emoji) => {
    const v = await typeInto('ok ', `${emoticon} `);
    await expect.poll(() => v.state.doc.toString()).toBe(`ok ${emoji} `);
  });

  it.each(['note:P', ':Po', 'x:)'])('leaves %s alone: not an emoticon on its own', async (word) => {
    const v = await typeInto('', `${word} `);
    await expect.poll(() => v.state.doc.toString()).toBe(`${word} `);
  });

  it('leaves an emoticon inside code alone', async () => {
    const v = await typeInto('see `a :P` and', ' ', 'see `a :P'.length);
    await expect.poll(() => v.state.doc.toString()).toBe('see `a :P ` and');
  });

  it('puts the emoticon back on undo, and keeps what came after it', async () => {
    const v = await typeInto('', 'hi :P there');
    await expect.poll(() => v.state.doc.toString()).toBe('hi 😛 there');
    await userEvent.keyboard('{ControlOrMeta>}z{/ControlOrMeta}');
    await expect.poll(() => v.state.doc.toString()).toBe('hi 😛 ');
    await userEvent.keyboard('{ControlOrMeta>}z{/ControlOrMeta}');
    await expect.poll(() => v.state.doc.toString()).toBe('hi :P');
  });
});
