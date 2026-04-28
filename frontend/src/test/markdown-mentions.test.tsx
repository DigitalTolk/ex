import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { renderMarkdown } from '@/lib/markdown';

describe('renderMarkdown — mentions', () => {
  it('renders @[id|name] as a pill carrying the mention metadata', () => {
    render(<>{renderMarkdown('hi @[u-1|Alice], welcome')}</>);
    const pill = screen.getByTestId('mention-pill');
    expect(pill).toHaveTextContent('@Alice');
    expect(pill.getAttribute('data-mention-user-id')).toBe('u-1');
    expect(pill.getAttribute('data-mention-self')).toBe('false');
  });

  it('marks the pill as self when currentUserId matches', () => {
    render(<>{renderMarkdown('@[u-me|Me]', { currentUserId: 'u-me' })}</>);
    expect(screen.getByTestId('mention-pill').getAttribute('data-mention-self')).toBe('true');
  });

  it('renders @all as a group pill (no userID metadata)', () => {
    render(<>{renderMarkdown('hey @all please review')}</>);
    const pill = screen.getByTestId('mention-pill');
    expect(pill).toHaveTextContent('@all');
    expect(pill.getAttribute('data-mention-group')).toBe('all');
    expect(pill.getAttribute('data-mention-user-id')).toBeNull();
  });

  it('renders @here as a group pill', () => {
    render(<>{renderMarkdown('@here anyone?')}</>);
    const pill = screen.getByTestId('mention-pill');
    expect(pill).toHaveTextContent('@here');
    expect(pill.getAttribute('data-mention-group')).toBe('here');
  });

  it('does NOT render @all-like fragments inside email addresses', () => {
    render(<>{renderMarkdown('write user@all-hands.example.com please')}</>);
    expect(screen.queryByTestId('mention-pill')).toBeNull();
  });

  it('uses the renderUserMention callback when provided', () => {
    const wrapped = renderMarkdown('hello @[u-1|Alice]', {
      renderUserMention: (userId, displayName, isSelf, pill) => (
        <span data-testid="wrap" data-id={userId} data-name={displayName} data-self={String(isSelf)}>
          {pill}
        </span>
      ),
    });
    render(<>{wrapped}</>);
    const wrap = screen.getByTestId('wrap');
    expect(wrap.getAttribute('data-id')).toBe('u-1');
    expect(wrap.getAttribute('data-name')).toBe('Alice');
    expect(wrap.getAttribute('data-self')).toBe('false');
    // The default pill is still rendered inside the wrapper.
    expect(screen.getByTestId('mention-pill')).toBeInTheDocument();
  });

  it('renders multiple mixed mentions in one paragraph', () => {
    render(<>{renderMarkdown('@[u-1|Alice] and @[u-2|Bob] — also @here')}</>);
    const pills = screen.getAllByTestId('mention-pill');
    expect(pills).toHaveLength(3);
    expect(pills.map((p) => p.textContent)).toEqual(['@Alice', '@Bob', '@here']);
  });

  it('does NOT confuse @[id|name] with a [text](url) link', () => {
    render(<>{renderMarkdown('plain [docs](https://x) and @[u-1|Alice]')}</>);
    expect(screen.getByTestId('mention-pill')).toHaveTextContent('@Alice');
    // The plain link still renders as an anchor.
    expect(screen.getByRole('link', { name: 'docs' })).toBeInTheDocument();
  });

  it('renders ~[id|slug] as a clickable channel pill linking to /channel/<slug>', () => {
    render(<>{renderMarkdown('see ~[c-1|general] for details')}</>);
    const pill = screen.getByTestId('channel-mention-pill');
    expect(pill).toHaveTextContent('~general');
    expect(pill.getAttribute('href')).toBe('/channel/general');
    expect(pill.getAttribute('data-channel-id')).toBe('c-1');
  });
});
