import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { TagSearchProvider, useTagOpen, useTagState } from './TagSearchContext';

function Consumer() {
  const { openTag } = useTagOpen();
  const { activeTag, tagNonce, closeTag } = useTagState();
  return (
    <div>
      <span data-testid="tag">{activeTag ?? 'null'}</span>
      <span data-testid="nonce">{tagNonce}</span>
      <button onClick={() => openTag('one')}>open-one</button>
      <button onClick={() => openTag('two')}>open-two</button>
      <button onClick={closeTag}>close</button>
    </div>
  );
}

describe('TagSearchContext', () => {
  it('starts with no active tag and nonce 0', () => {
    render(
      <TagSearchProvider>
        <Consumer />
      </TagSearchProvider>,
    );
    expect(screen.getByTestId('tag')).toHaveTextContent('null');
    expect(screen.getByTestId('nonce')).toHaveTextContent('0');
  });

  it('honors initialTag prop', () => {
    render(
      <TagSearchProvider initialTag="seed">
        <Consumer />
      </TagSearchProvider>,
    );
    expect(screen.getByTestId('tag')).toHaveTextContent('seed');
  });

  it('openTag sets the tag and bumps the nonce on every call', () => {
    render(
      <TagSearchProvider>
        <Consumer />
      </TagSearchProvider>,
    );
    act(() => screen.getByText('open-one').click());
    expect(screen.getByTestId('tag')).toHaveTextContent('one');
    expect(screen.getByTestId('nonce')).toHaveTextContent('1');

    // Re-clicking the same tag still bumps the nonce so a stale-cache
    // search can refire.
    act(() => screen.getByText('open-one').click());
    expect(screen.getByTestId('nonce')).toHaveTextContent('2');

    act(() => screen.getByText('open-two').click());
    expect(screen.getByTestId('tag')).toHaveTextContent('two');
    expect(screen.getByTestId('nonce')).toHaveTextContent('3');
  });

  it('closeTag clears the active tag without changing the nonce', () => {
    render(
      <TagSearchProvider>
        <Consumer />
      </TagSearchProvider>,
    );
    act(() => screen.getByText('open-one').click());
    const beforeNonce = screen.getByTestId('nonce').textContent;
    act(() => screen.getByText('close').click());
    expect(screen.getByTestId('tag')).toHaveTextContent('null');
    expect(screen.getByTestId('nonce').textContent).toBe(beforeNonce);
  });

  it('useTagOpen / useTagState outside a provider return no-op defaults', () => {
    render(<Consumer />);
    expect(screen.getByTestId('tag')).toHaveTextContent('null');
    // openTag and closeTag should both be no-ops without throwing.
    act(() => screen.getByText('open-one').click());
    expect(screen.getByTestId('tag')).toHaveTextContent('null');
    expect(screen.getByTestId('nonce')).toHaveTextContent('0');
    act(() => screen.getByText('close').click());
    expect(screen.getByTestId('tag')).toHaveTextContent('null');
  });
});
