import { describe, expect, it, vi, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { MenuOption } from '@lexical/react/LexicalTypeaheadMenuPlugin';
import { TypeaheadMenu } from './TypeaheadMenu';

// Direct browser coverage for the shared typeahead popup chrome — the
// null-anchor / empty-state early returns and the composer-relative
// positioning that the plugin tests only reach on the happy path.

function opt(key: string) {
  return new MenuOption(key);
}

let composer: HTMLElement | null = null;
afterEach(() => {
  composer?.remove();
  composer = null;
});

// Build a composer with a role=textbox editor + an anchor span, append to the
// document, focus the editor, and return the anchor element.
function buildAnchor(): HTMLElement {
  composer = document.createElement('div');
  composer.setAttribute('data-message-composer', '');
  const editor = document.createElement('div');
  editor.setAttribute('role', 'textbox');
  editor.tabIndex = 0;
  const anchor = document.createElement('span');
  Object.assign(anchor.style, { position: 'fixed', top: '300px', left: '40px' });
  composer.append(editor, anchor);
  document.body.append(composer);
  editor.focus();
  return anchor;
}

const baseProps = {
  testId: 'tm',
  selectedIndex: 0,
  setHighlightedIndex: vi.fn(),
  selectOptionAndCleanUp: vi.fn(),
  renderRow: (o: MenuOption) => <span>{o.key}</span>,
};

describe('TypeaheadMenu (browser)', () => {
  it('renders nothing when the anchor element is not available', async () => {
    await render(<TypeaheadMenu {...baseProps} options={[opt('a')]} anchorElementRef={{ current: null }} />);
    expect(document.querySelector('[data-testid="tm"]')).toBeNull();
  });

  it('renders nothing when there are no options and no empty label', async () => {
    const anchor = buildAnchor();
    await render(<TypeaheadMenu {...baseProps} options={[]} anchorElementRef={{ current: anchor }} />);
    expect(document.querySelector('[data-testid="tm"]')).toBeNull();
  });

  it('renders the empty label when there are no options but a label is provided', async () => {
    const anchor = buildAnchor();
    const screen = await render(
      <TypeaheadMenu {...baseProps} options={[]} emptyLabel="No matches" anchorElementRef={{ current: anchor }} />,
    );
    await expect.element(screen.getByText('No matches')).toBeVisible();
  });

  it('renders option rows positioned relative to the composer and forwards row interactions', async () => {
    const anchor = buildAnchor();
    const onSelect = vi.fn();
    const onHighlight = vi.fn();
    await render(
      <TypeaheadMenu
        {...baseProps}
        options={[opt('one'), opt('two')]}
        selectedIndex={0}
        setHighlightedIndex={onHighlight}
        selectOptionAndCleanUp={onSelect}
        headerFor={(o) => (o.key === 'one' ? 'Group A' : 'Group B')}
        anchorElementRef={{ current: anchor }}
      />,
    );
    const list = document.querySelector('[data-testid="tm"]') as HTMLElement;
    expect(list).not.toBeNull();
    // The positioning effect set fixed coordinates (not the hidden fallback).
    expect(list.style.position).toBe('fixed');
    // Section headers render when adjacent options have differing headers.
    expect(document.querySelectorAll('[data-testid="typeahead-section-header"]').length).toBeGreaterThanOrEqual(2);
    const rows = document.querySelectorAll('[role="option"]');
    expect(rows.length).toBe(2);
    // mousedown selects the option (and preventDefaults to keep editor focus).
    rows[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(onSelect).toHaveBeenCalled();
    expect(onHighlight).not.toHaveBeenCalled();
  });

  it('positions using window.innerHeight when visualViewport is unavailable', async () => {
    // Removing window.visualViewport drives the `?? 0` (offsetTop) and
    // `?? window.innerHeight` (height) fallback sides, and blurring everything
    // makes `document.activeElement instanceof HTMLElement` take a path where
    // no role=textbox is resolved.
    const desc = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined });
    const bare = document.createElement('span');
    Object.assign(bare.style, { position: 'fixed', top: '220px', left: '20px' });
    document.body.append(bare);
    (document.activeElement as HTMLElement | null)?.blur?.();
    try {
      await render(
        <TypeaheadMenu {...baseProps} options={[opt('a')]} anchorElementRef={{ current: bare }} />,
      );
      const list = document.querySelector('[data-testid="tm"]') as HTMLElement;
      expect(list).not.toBeNull();
      expect(list.style.position).toBe('fixed');
    } finally {
      bare.remove();
      if (desc) Object.defineProperty(window, 'visualViewport', desc);
    }
  });

  it('positions relative to the anchor rect when no composer/editor reference exists', async () => {
    // Anchor that is NOT inside a `[data-message-composer]`, with no focused
    // role=textbox anywhere: the editor lookup chain resolves to undefined, so
    // `editor?.getBoundingClientRect().top ?? anchorRect.top` and the
    // composer?.querySelector ?? activeEditor ?? document.querySelector chain
    // all fall through to their right-hand fallbacks.
    const bare = document.createElement('span');
    Object.assign(bare.style, { position: 'fixed', top: '200px', left: '30px' });
    document.body.append(bare);
    // Ensure nothing is focused as a textbox (blur any prior focus).
    (document.activeElement as HTMLElement | null)?.blur?.();
    try {
      await render(
        <TypeaheadMenu {...baseProps} options={[opt('a'), opt('b')]} anchorElementRef={{ current: bare }} />,
      );
      const list = document.querySelector('[data-testid="tm"]') as HTMLElement;
      expect(list).not.toBeNull();
      // Positioning ran and produced a fixed layout from the anchor rect alone.
      expect(list.style.position).toBe('fixed');
      expect(list.style.bottom).not.toBe('');
    } finally {
      bare.remove();
    }
  });
});
