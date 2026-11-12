import { describe, it, expect, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { startCompletion, currentCompletions, selectedCompletionIndex } from '@codemirror/autocomplete';
import { composerAutocomplete, renderOption, type CompletionProviders } from './completions';
import { isApplePlatform } from '@/lib/platform';

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

    // An option row whose id doesn't end in `-<index>` (CM's shape) is
    // ignored rather than parsed into NaN.
    const rogue = document.createElement('li');
    rogue.id = 'no-trailing-index';
    items[1].parentElement!.appendChild(rogue);
    rogue.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
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

  // Custom emoji that merely resemble the query don't push the standard one
  // out: 👀 comes first, and the rest scroll below it.
  it('lists the standard emoji first for :eyes, with more matches than fit scrolling', async () => {
    const lookalikes = [
      ...['keys', 'yes', 'dyes', 'byes', 'eye'],
      ...Array.from({ length: 20 }, (_, i) => `eyes_${i}`),
    ].map((name) => ({ name, imageURL: `https://x.test/${name}.png` }));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: ':eyes',
        selection: { anchor: 5 },
        extensions: [composerAutocomplete({ ...providers, customEmojis: () => lookalikes })],
      }),
    });
    startCompletion(view);
    await vi.waitFor(() => {
      expect(currentCompletions(view.state)[0]?.label).toBe(':eyes:');
    });
    expect(currentCompletions(view.state).length).toBeGreaterThan(20);
    const list = view.dom.querySelector('.cm-tooltip-autocomplete > ul') as HTMLElement;
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
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

  it('Tab accepts the highlighted option; without an open typeahead Tab falls through', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: '@Al', selection: { anchor: 3 }, extensions: [composerAutocomplete(providers)] }),
    });
    startCompletion(view);
    await vi.waitFor(() => {
      expect(currentCompletions(view.state).some((c) => c.label === 'Alice')).toBe(true);
    });
    // acceptCompletion deliberately ignores accepts within interactionDelay
    // (75ms) of the popup opening — outwait it like a human would.
    await new Promise((r) => setTimeout(r, 120));

    const tab = () => {
      const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      view.contentDOM.dispatchEvent(ev);
      return ev;
    };
    // Accepts the selected option: the mention lands in the doc and the
    // typeahead closes.
    expect(tab().defaultPrevented).toBe(true);
    await vi.waitFor(() => {
      expect(view.state.doc.toString()).toBe('@[u1|Alice] ');
      expect(currentCompletions(view.state).length).toBe(0);
    });

    // No open typeahead → Tab is NOT consumed (focus navigation keeps
    // working); the doc stays put.
    expect(tab().defaultPrevented).toBe(false);
    expect(view.state.doc.toString()).toBe('@[u1|Alice] ');

    view.destroy();
    host.remove();
  });

  describe('numbered shortcuts', () => {
    const apple = isApplePlatform(navigator.userAgent);
    const mod = apple ? '⌘' : 'Ctrl ';
    const twoUsers: CompletionProviders = {
      ...providers,
      users: () => [
        { id: 'u1', displayName: 'Alice' },
        { id: 'u2', displayName: 'Alan' },
      ],
    };
    function chord(view: EditorView, key: string, extra: KeyboardEventInit = {}) {
      const ev = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        ...(apple ? { metaKey: true } : { ctrlKey: true }),
        ...extra,
      });
      view.contentDOM.dispatchEvent(ev);
      return ev;
    }
    async function openOn(doc: string, p: CompletionProviders = twoUsers) {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const view = new EditorView({
        parent: host,
        state: EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [composerAutocomplete(p)] }),
      });
      startCompletion(view);
      await vi.waitFor(() => expect(currentCompletions(view.state).length).toBeGreaterThan(0));
      // Outwait acceptCompletion's interactionDelay, like a person would.
      await new Promise((r) => setTimeout(r, 120));
      return { view, host };
    }

    it('the chord plus 2 picks the second option', async () => {
      const { view, host } = await openOn('@Al');
      const second = currentCompletions(view.state)[1];
      expect(chord(view, '2').defaultPrevented).toBe(true);
      await vi.waitFor(() => expect(currentCompletions(view.state).length).toBe(0));
      expect(view.state.doc.toString()).toBe(second.label === 'Alan' ? '@[u2|Alan] ' : '@[u1|Alice] ');
      // Nothing open: the chord passes through untouched.
      expect(chord(view, '1').defaultPrevented).toBe(false);
      view.destroy();
      host.remove();
    });

    it('past the end of the list the chord is swallowed and nothing is picked; other keys pass', async () => {
      const { view, host } = await openOn('@Al');
      expect(chord(view, '9').defaultPrevented).toBe(true);
      expect(view.state.doc.toString()).toBe('@Al');
      expect(currentCompletions(view.state).length).toBeGreaterThan(0);
      expect(chord(view, '1', { shiftKey: true }).defaultPrevented).toBe(false);
      expect(view.state.doc.toString()).toBe('@Al');
      view.destroy();
      host.remove();
    });

    it('labels the first nine rows with their shortcut where there is a keyboard', async () => {
      const prev = window.__EX_FORCE_DEVICE__;
      window.__EX_FORCE_DEVICE__ = 'desktop';
      try {
        const many = Array.from({ length: 12 }, (_, i) => ({ name: `eyes_${i}`, imageURL: `https://x.test/${i}.png` }));
        const { view, host } = await openOn(':eyes', { ...providers, customEmojis: () => many });
        await vi.waitFor(() => {
          const rows = Array.from(view.dom.querySelectorAll('.cm-tooltip-autocomplete li[id]'));
          expect(rows.length).toBeGreaterThan(9);
          expect(rows[0].querySelector('.cm-option-key')?.textContent).toBe(`${mod}1`);
          expect(rows[8].querySelector('.cm-option-key')?.textContent).toBe(`${mod}9`);
          expect(rows[9].querySelector('.cm-option-key')).toBeNull();
        });
        view.destroy();
        host.remove();
      } finally {
        window.__EX_FORCE_DEVICE__ = prev;
      }
    });

    it('draws no hint on a touch device', async () => {
      const prev = window.__EX_FORCE_DEVICE__;
      window.__EX_FORCE_DEVICE__ = 'touch';
      try {
        const { view, host } = await openOn('@Al');
        await vi.waitFor(() => expect(view.dom.querySelectorAll('.cm-tooltip-autocomplete li[id]').length).toBe(2));
        expect(view.dom.querySelector('.cm-option-key')).toBeNull();
        view.destroy();
        host.remove();
      } finally {
        window.__EX_FORCE_DEVICE__ = prev;
      }
    });

    it('draws no hint for an option outside the open list, and no row without meta', () => {
      const prev = window.__EX_FORCE_DEVICE__;
      window.__EX_FORCE_DEVICE__ = 'desktop';
      try {
        const state = EditorState.create({ doc: '' });
        const option = { label: 'Alice', meta: { kind: 'user', displayName: 'Alice', online: false } } as never;
        expect((renderOption(option, state) as HTMLElement).querySelector('.cm-option-key')).toBeNull();
        expect(renderOption({ label: 'plain' }, state)).toBeNull();
      } finally {
        window.__EX_FORCE_DEVICE__ = prev;
      }
    });
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
