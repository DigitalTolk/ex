import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { UnreadProvider, useUnread } from './UnreadContext';

function TestConsumer() {
  const {
    unreadChannels,
    unreadConversations,
    hiddenConversations,
    markChannelUnread,
    markConversationUnread,
    clearChannelUnread,
    clearConversationUnread,
    hideConversation,
    unhideConversation,
    setActiveChannel,
    setActiveConversation,
    isActiveChannel,
    isActiveConversation,
  } = useUnread();

  return (
    <div>
      <span data-testid="channels">{JSON.stringify([...unreadChannels])}</span>
      <span data-testid="conversations">{JSON.stringify([...unreadConversations])}</span>
      <span data-testid="hidden">{JSON.stringify([...hiddenConversations])}</span>
      <span data-testid="is-active-ch">{String(isActiveChannel('ch-1'))}</span>
      <span data-testid="is-active-conv">{String(isActiveConversation('conv-1'))}</span>
      <button onClick={() => markChannelUnread('ch-1')}>markChannel</button>
      <button onClick={() => clearChannelUnread('ch-1')}>clearChannel</button>
      <button onClick={() => markConversationUnread('conv-1')}>markConvo</button>
      <button onClick={() => clearConversationUnread('conv-1')}>clearConvo</button>
      <button onClick={() => hideConversation('conv-1')}>hideConvo</button>
      <button onClick={() => unhideConversation('conv-1')}>unhideConvo</button>
      <button onClick={() => setActiveChannel('ch-1')}>activateCh</button>
      <button onClick={() => setActiveChannel(null)}>deactivateCh</button>
      <button onClick={() => setActiveConversation('conv-1')}>activateConv</button>
      <button onClick={() => setActiveConversation(null)}>deactivateConv</button>
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

  it('markChannelUnread and clearChannelUnread work', () => {
    render(
      <UnreadProvider>
        <TestConsumer />
      </UnreadProvider>,
    );

    expect(screen.getByTestId('channels')).toHaveTextContent('[]');

    act(() => {
      screen.getByText('markChannel').click();
    });
    expect(screen.getByTestId('channels')).toHaveTextContent('["ch-1"]');

    act(() => {
      screen.getByText('clearChannel').click();
    });
    expect(screen.getByTestId('channels')).toHaveTextContent('[]');
  });

  it('markConversationUnread and clearConversationUnread work', () => {
    render(
      <UnreadProvider>
        <TestConsumer />
      </UnreadProvider>,
    );

    expect(screen.getByTestId('conversations')).toHaveTextContent('[]');

    act(() => {
      screen.getByText('markConvo').click();
    });
    expect(screen.getByTestId('conversations')).toHaveTextContent('["conv-1"]');

    act(() => {
      screen.getByText('clearConvo').click();
    });
    expect(screen.getByTestId('conversations')).toHaveTextContent('[]');
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

    // Unhide a non-hidden id is a no-op (must hit the early-return in unhide).
    act(() => screen.getByText('unhideConvo').click());
    expect(screen.getByTestId('hidden')).toHaveTextContent('[]');
    expect(localStorage.getItem('hidden_conversations')).toBe('[]');

    // Unhide again — already absent, should keep state.
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

  it('setActiveChannel suppresses markChannelUnread for that id', () => {
    render(
      <UnreadProvider>
        <TestConsumer />
      </UnreadProvider>,
    );
    act(() => screen.getByText('activateCh').click());
    expect(screen.getByTestId('is-active-ch')).toHaveTextContent('true');
    // Try to mark unread — should be suppressed.
    act(() => screen.getByText('markChannel').click());
    expect(screen.getByTestId('channels')).toHaveTextContent('[]');

    // Deactivating allows mark to land again.
    act(() => screen.getByText('deactivateCh').click());
    act(() => screen.getByText('markChannel').click());
    expect(screen.getByTestId('channels')).toHaveTextContent('["ch-1"]');

    // Activating clears any existing unread for that id.
    act(() => screen.getByText('activateCh').click());
    expect(screen.getByTestId('channels')).toHaveTextContent('[]');
  });

  it('setActiveConversation suppresses markConversationUnread for that id', () => {
    render(
      <UnreadProvider>
        <TestConsumer />
      </UnreadProvider>,
    );
    act(() => screen.getByText('activateConv').click());
    expect(screen.getByTestId('is-active-conv')).toHaveTextContent('true');
    act(() => screen.getByText('markConvo').click());
    expect(screen.getByTestId('conversations')).toHaveTextContent('[]');

    act(() => screen.getByText('deactivateConv').click());
    act(() => screen.getByText('markConvo').click());
    expect(screen.getByTestId('conversations')).toHaveTextContent('["conv-1"]');

    // Re-activating clears the unread again.
    act(() => screen.getByText('activateConv').click());
    expect(screen.getByTestId('conversations')).toHaveTextContent('[]');
  });
});
