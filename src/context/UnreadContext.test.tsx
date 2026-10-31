import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, act } from '@testing-library/react';
import { UnreadProvider, useUnread } from './UnreadContext';
import { addInViewThread, resetThreadScopeForTests } from '@/lib/thread-scope';
import { setActiveParent } from '@/stores/active-parent';

function TestConsumer() {
  // Active channel/conversation are refs (no re-render on change); a tick forces
  // a re-render so the rendered flags reflect the latest ref value.
  const [, setTick] = useState(0);
  const {
    hiddenConversations,
    hideConversation,
    unhideConversation,
    isActiveChannel,
    isActiveConversation,
    setActiveThread,
    isActiveThread,
  } = useUnread();

  return (
    <div>
      <span data-testid="hidden">{JSON.stringify([...hiddenConversations])}</span>
      <span data-testid="is-active-ch">{String(isActiveChannel('ch-1'))}</span>
      <span data-testid="is-active-conv">{String(isActiveConversation('conv-1'))}</span>
      <span data-testid="is-active-thread">{String(isActiveThread('root-1'))}</span>
      <button onClick={() => hideConversation('conv-1')}>hideConvo</button>
      <button onClick={() => unhideConversation('conv-1')}>unhideConvo</button>
      <button onClick={() => setActiveParent({ kind: 'channel', id: 'ch-1' })}>activateCh</button>
      <button onClick={() => setActiveParent({ kind: 'conversation', id: 'conv-1' })}>activateConv</button>
      <button onClick={() => setActiveParent(null)}>deactivate</button>
      <button onClick={() => setActiveThread('root-1')}>activateThread</button>
      <button onClick={() => setActiveThread(null)}>deactivateThread</button>
      <button onClick={() => setTick((t) => t + 1)}>tick</button>
    </div>
  );
}

describe('UnreadContext', () => {
  beforeEach(() => {
    localStorage.clear();
    resetThreadScopeForTests();
  });

  it('throws when used outside its provider', () => {
    function Lone() {
      useUnread();
      return null;
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Lone />)).toThrow(/UnreadProvider/);
    spy.mockRestore();
  });

  it('setActiveThread marks the thread active, and null clears it', () => {
    render(
      <UnreadProvider>
        <TestConsumer />
      </UnreadProvider>,
    );
    expect(screen.getByTestId('is-active-thread')).toHaveTextContent('false');

    // The active thread is a ref: the tick re-renders the probe to show it.
    act(() => screen.getByText('activateThread').click());
    act(() => screen.getByText('tick').click());
    expect(screen.getByTestId('is-active-thread')).toHaveTextContent('true');

    act(() => screen.getByText('deactivateThread').click());
    act(() => screen.getByText('tick').click());
    expect(screen.getByTestId('is-active-thread')).toHaveTextContent('false');
  });

  it('isActiveThread also covers a /threads card in the viewport (SPEC GAP-5)', () => {
    render(
      <UnreadProvider>
        <TestConsumer />
      </UnreadProvider>,
    );
    expect(screen.getByTestId('is-active-thread')).toHaveTextContent('false');
    // Reading the thread inline on /threads (card in view, no panel open)
    // must count as active so replies neither badge nor popup.
    act(() => {
      addInViewThread('root-1');
      screen.getByText('tick').click();
    });
    expect(screen.getByTestId('is-active-thread')).toHaveTextContent('true');
  });

  it('hide/unhide conversation persists to localStorage', () => {
    render(
      <UnreadProvider>
        <TestConsumer />
      </UnreadProvider>,
    );
    expect(screen.getByTestId('hidden')).toHaveTextContent('[]');

    act(() => screen.getByText('hideConvo').click());
    expect(screen.getByTestId('hidden')).toHaveTextContent('["conv-1"]');
    expect(localStorage.getItem('hidden_conversations')).toBe('["conv-1"]');

    // Unhide removes it and persists.
    act(() => screen.getByText('unhideConvo').click());
    expect(screen.getByTestId('hidden')).toHaveTextContent('[]');
    expect(localStorage.getItem('hidden_conversations')).toBe('[]');

    // Unhide again — already absent, should keep state (early return branch).
    act(() => screen.getByText('unhideConvo').click());
    expect(screen.getByTestId('hidden')).toHaveTextContent('[]');
  });

  it('loads hidden conversations from localStorage on mount', () => {
    localStorage.setItem('hidden_conversations', JSON.stringify(['conv-x', 'conv-y']));
    render(
      <UnreadProvider>
        <TestConsumer />
      </UnreadProvider>,
    );
    expect(screen.getByTestId('hidden')).toHaveTextContent('["conv-x","conv-y"]');
  });

  it('falls back to empty set when localStorage is corrupt', () => {
    localStorage.setItem('hidden_conversations', '{not json');
    render(
      <UnreadProvider>
        <TestConsumer />
      </UnreadProvider>,
    );
    expect(screen.getByTestId('hidden')).toHaveTextContent('[]');
  });

  // The open parent is one record (stores/active-parent): opening a
  // conversation closes the channel that was open.
  it('reads the one active parent', () => {
    render(
      <UnreadProvider>
        <TestConsumer />
      </UnreadProvider>,
    );
    expect(screen.getByTestId('is-active-ch')).toHaveTextContent('false');
    expect(screen.getByTestId('is-active-conv')).toHaveTextContent('false');

    act(() => screen.getByText('activateCh').click());
    act(() => screen.getByText('tick').click());
    expect(screen.getByTestId('is-active-ch')).toHaveTextContent('true');
    expect(screen.getByTestId('is-active-conv')).toHaveTextContent('false');

    act(() => screen.getByText('activateConv').click());
    act(() => screen.getByText('tick').click());
    expect(screen.getByTestId('is-active-ch')).toHaveTextContent('false');
    expect(screen.getByTestId('is-active-conv')).toHaveTextContent('true');

    act(() => screen.getByText('deactivate').click());
    act(() => screen.getByText('tick').click());
    expect(screen.getByTestId('is-active-ch')).toHaveTextContent('false');
    expect(screen.getByTestId('is-active-conv')).toHaveTextContent('false');
  });
});
