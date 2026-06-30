import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, act } from '@testing-library/react';
import { UnreadProvider, useUnread } from './UnreadContext';

function TestConsumer() {
  // Active channel/conversation are refs (no re-render on change); a tick forces
  // a re-render so the rendered flags reflect the latest ref value.
  const [, setTick] = useState(0);
  const {
    unreadThreadNotifications,
    hiddenConversations,
    markThreadNotificationUnread,
    hideConversation,
    unhideConversation,
    setActiveChannel,
    setActiveConversation,
    isActiveChannel,
    isActiveConversation,
    setActiveThread,
    isActiveThread,
  } = useUnread();

  return (
    <div>
      <span data-testid="thread-notifications">{JSON.stringify([...unreadThreadNotifications])}</span>
      <span data-testid="hidden">{JSON.stringify([...hiddenConversations])}</span>
      <span data-testid="is-active-ch">{String(isActiveChannel('ch-1'))}</span>
      <span data-testid="is-active-conv">{String(isActiveConversation('conv-1'))}</span>
      <span data-testid="is-active-thread">{String(isActiveThread('root-1'))}</span>
      <button onClick={() => markThreadNotificationUnread('root-1')}>markThreadNotification</button>
      <button onClick={() => hideConversation('conv-1')}>hideConvo</button>
      <button onClick={() => unhideConversation('conv-1')}>unhideConvo</button>
      <button onClick={() => setActiveChannel('ch-1')}>activateCh</button>
      <button onClick={() => setActiveChannel(null)}>deactivateCh</button>
      <button onClick={() => setActiveConversation('conv-1')}>activateConv</button>
      <button onClick={() => setActiveConversation(null)}>deactivateConv</button>
      <button onClick={() => setActiveThread('root-1')}>activateThread</button>
      <button onClick={() => setActiveThread(null)}>deactivateThread</button>
      <button onClick={() => setTick((t) => t + 1)}>tick</button>
    </div>
  );
}

describe('UnreadContext', () => {
  beforeEach(() => {
    localStorage.clear();
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

  it('markThreadNotificationUnread is cleared when that thread is marked seen', () => {
    render(
      <UnreadProvider>
        <TestConsumer />
      </UnreadProvider>,
    );

    act(() => {
      screen.getByText('markThreadNotification').click();
    });
    expect(screen.getByTestId('thread-notifications')).toHaveTextContent('["root-1"]');

    act(() => {
      window.dispatchEvent(new CustomEvent('ex:threads-seen-changed', { detail: { threadRootID: 'root-1' } }));
    });
    expect(screen.getByTestId('thread-notifications')).toHaveTextContent('[]');
  });

  it('thread-seen event without a rootID is a no-op', () => {
    render(
      <UnreadProvider>
        <TestConsumer />
      </UnreadProvider>,
    );
    act(() => screen.getByText('markThreadNotification').click());
    act(() => {
      window.dispatchEvent(new CustomEvent('ex:threads-seen-changed', { detail: {} }));
    });
    // No rootID → set unchanged.
    expect(screen.getByTestId('thread-notifications')).toHaveTextContent('["root-1"]');
  });

  it('setActiveThread clears a pending thread notification, and null is a no-op', () => {
    render(
      <UnreadProvider>
        <TestConsumer />
      </UnreadProvider>,
    );
    act(() => screen.getByText('markThreadNotification').click());
    expect(screen.getByTestId('is-active-thread')).toHaveTextContent('false');

    act(() => screen.getByText('activateThread').click());
    expect(screen.getByTestId('is-active-thread')).toHaveTextContent('true');
    expect(screen.getByTestId('thread-notifications')).toHaveTextContent('[]');

    // Activating again (already absent) keeps the set, and null clears the ref.
    act(() => screen.getByText('activateThread').click());
    expect(screen.getByTestId('thread-notifications')).toHaveTextContent('[]');
    act(() => screen.getByText('deactivateThread').click());
    act(() => screen.getByText('tick').click());
    expect(screen.getByTestId('is-active-thread')).toHaveTextContent('false');
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

  it('tracks the active channel and conversation refs', () => {
    render(
      <UnreadProvider>
        <TestConsumer />
      </UnreadProvider>,
    );
    expect(screen.getByTestId('is-active-ch')).toHaveTextContent('false');
    expect(screen.getByTestId('is-active-conv')).toHaveTextContent('false');

    act(() => screen.getByText('activateCh').click());
    act(() => screen.getByText('activateConv').click());
    act(() => screen.getByText('tick').click());
    expect(screen.getByTestId('is-active-ch')).toHaveTextContent('true');
    expect(screen.getByTestId('is-active-conv')).toHaveTextContent('true');

    act(() => screen.getByText('deactivateCh').click());
    act(() => screen.getByText('deactivateConv').click());
    act(() => screen.getByText('tick').click());
    expect(screen.getByTestId('is-active-ch')).toHaveTextContent('false');
    expect(screen.getByTestId('is-active-conv')).toHaveTextContent('false');
  });
});
