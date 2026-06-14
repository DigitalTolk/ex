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
});
