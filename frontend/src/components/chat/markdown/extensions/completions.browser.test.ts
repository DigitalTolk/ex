import { describe, it, expect, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { startCompletion, currentCompletions, selectedCompletionIndex } from '@codemirror/autocomplete';
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

  it('hovering an option selects it so mouse + keyboard share one highlight', async () => {
    const view = mount(':smi');
    startCompletion(view);

    let items: HTMLLIElement[] = [];
    await vi.waitFor(() => {
      items = Array.from(view.dom.querySelectorAll('.cm-tooltip-autocomplete li[id]')) as HTMLLIElement[];
      expect(items.length).toBeGreaterThan(1);
    });

    // Hovering the second row makes it the selected option…
    items[1].dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
    await vi.waitFor(() => expect(selectedCompletionIndex(view.state)).toBe(1));

    // …and it carries the visible aria-selected highlight (only one row does).
    await vi.waitFor(() => {
      const selected = view.dom.querySelectorAll('.cm-tooltip-autocomplete li[aria-selected]');
      expect(selected.length).toBe(1);
      expect((selected[0] as HTMLElement).id.endsWith('-1')).toBe(true);
    });

    // Re-hovering the same row is a no-op (no redundant dispatch), and a move
    // that isn't over an option row is ignored.
    items[1].dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
    view.dom.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
    expect(selectedCompletionIndex(view.state)).toBe(1);

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

  it('renders section headers in the popup when there is a channel context', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const partitioned: CompletionProviders = {
      ...providers,
      users: () => [
        { id: 'u1', displayName: 'Alice' },
        { id: 'u2', displayName: 'Alan' },
      ],
      memberIds: () => new Set(['u1']),
    };
    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: '@', selection: { anchor: 1 }, extensions: [composerAutocomplete(partitioned)] }),
    });
    startCompletion(view);
    await vi.waitFor(() => {
      const headers = Array.from(document.querySelectorAll('.cm-mention-section')).map((e) => e.textContent);
      expect(headers).toContain('Channel members');
      expect(headers).toContain('Not in channel');
    });
    view.destroy();
    host.remove();
  });

  it('keeps natural placement: opens below the caret when there is visible room below', async () => {
    // Placement must stay space-driven on every viewport — an inline edit of
    // a scrolled-up message (caret high on screen) opens DOWNWARD into the
    // visible area. The iOS-keyboard problem is solved by bounding and
    // reactively re-measuring the available space (tooltipSpace.ts), never by
    // forcing a direction.
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:50%;left:0;right:0;';
    document.body.appendChild(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: '@Al', selection: { anchor: 3 }, extensions: [composerAutocomplete(providers)] }),
    });
    startCompletion(view);
    await vi.waitFor(() => {
      const tip = view.dom.querySelector('.cm-tooltip-autocomplete');
      expect(tip).not.toBeNull();
      expect(tip!.classList.contains('cm-tooltip-below')).toBe(true);
    });
    view.destroy();
    host.remove();
  });
});
