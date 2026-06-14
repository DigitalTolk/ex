import { describe, it, expect, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { startCompletion, currentCompletions } from '@codemirror/autocomplete';
import { composerAutocomplete, type CompletionProviders } from './completions';

const providers: CompletionProviders = {
  users: () => [{ id: 'u1', displayName: 'Alice' }],
  online: () => new Set(),
  memberIds: () => null,
  channels: () => [{ channelID: 'c1', channelName: 'general', channelType: 'public' }],
  customEmojis: () => [],
  skinTone: () => '',
};

function mount(doc: string): EditorView {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return new EditorView({
    parent: host,
    state: EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [composerAutocomplete(providers)] }),
  });
}

describe('composerAutocomplete', () => {
  it('offers @-mention completions in a live editor', async () => {
    const view = mount('@Al');
    startCompletion(view);
    await vi.waitFor(() => {
      expect(currentCompletions(view.state).some((c) => c.label === 'Alice')).toBe(true);
    });
    view.destroy();
  });

  it('offers ~-channel completions in a live editor', async () => {
    const view = mount('~gen');
    startCompletion(view);
    await vi.waitFor(() => {
      expect(currentCompletions(view.state).some((c) => c.label === '~general')).toBe(true);
    });
    view.destroy();
  });

  it('offers :emoji: completions in a live editor', async () => {
    const view = mount(':smile');
    startCompletion(view);
    await vi.waitFor(() => {
      expect(currentCompletions(view.state).some((c) => c.label === ':smile:')).toBe(true);
    });
    view.destroy();
  });
});
