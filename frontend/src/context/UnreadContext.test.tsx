import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { UnreadProvider, useUnread } from './UnreadContext';

function TestConsumer() {
  const {
    unreadChannels,
    unreadChannelNotifications,
    unreadConversations,
    unreadThreadNotifications,
    hiddenConversations,
    channelUnreadCounts,
    conversationUnreadCounts,
    syncServerCounts,
    markChannelUnread,
    markChannelNotificationUnread,
    markConversationUnread,
    markThreadNotificationUnread,
    clearChannelUnread,
    clearConversationUnread,
    resetSessionUnread,
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
      <span data-testid="channel-notifications">{JSON.stringify([...unreadChannelNotifications])}</span>
      <span data-testid="conversations">{JSON.stringify([...unreadConversations])}</span>
      <span data-testid="thread-notifications">{JSON.stringify([...unreadThreadNotifications])}</span>
      <span data-testid="hidden">{JSON.stringify([...hiddenConversations])}</span>
      <span data-testid="channel-counts">{JSON.stringify([...channelUnreadCounts])}</span>
      <span data-testid="conv-counts">{JSON.stringify([...conversationUnreadCounts])}</span>
      <span data-testid="is-active-ch">{String(isActiveChannel('ch-1'))}</span>
      <span data-testid="is-active-conv">{String(isActiveConversation('conv-1'))}</span>
      <button onClick={() => markChannelUnread('ch-1')}>markChannel</button>
      <button onClick={() => markChannelNotificationUnread('ch-1')}>markChannelNotification</button>
      <button onClick={() => clearChannelUnread('ch-1')}>clearChannel</button>
      <button onClick={() => markConversationUnread('conv-1')}>markConvo</button>
      <button onClick={() => markThreadNotificationUnread('root-1')}>markThreadNotification</button>
      <button onClick={() => clearConversationUnread('conv-1')}>clearConvo</button>
      <button onClick={() => resetSessionUnread()}>resetSession</button>
      <button onClick={() => syncServerCounts(new Map([['ch-1', 3], ['ch-2', 0]]), new Map([['conv-1', 2]]))}>syncSeed</button>
      <button onClick={() => syncServerCounts(new Map([['ch-1', 3]]), new Map([['conv-1', 1]]))}>syncOne</button>
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

  it('markChannelNotificationUnread and clearChannelUnread work', () => {
    render(
      <UnreadProvider>
        <TestConsumer />
      </UnreadProvider>,
    );

    expect(screen.getByTestId('channel-notifications')).toHaveTextContent('[]');

    act(() => {
      screen.getByText('markChannelNotification').click();
    });
    expect(screen.getByTestId('channel-notifications')).toHaveTextContent('["ch-1"]');

    act(() => {
      screen.getByText('clearChannel').click();
    });
    expect(screen.getByTestId('channel-notifications')).toHaveTextContent('[]');
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
    act(() => screen.getByText('markChannelNotification').click());
    expect(screen.getByTestId('channels')).toHaveTextContent('[]');
    expect(screen.getByTestId('channel-notifications')).toHaveTextContent('[]');

    // Deactivating allows mark to land again.
    act(() => screen.getByText('deactivateCh').click());
    act(() => screen.getByText('markChannel').click());
    act(() => screen.getByText('markChannelNotification').click());
    expect(screen.getByTestId('channels')).toHaveTextContent('["ch-1"]');
    expect(screen.getByTestId('channel-notifications')).toHaveTextContent('["ch-1"]');

    // Activating clears any existing unread for that id.
    act(() => screen.getByText('activateCh').click());
    expect(screen.getByTestId('channels')).toHaveTextContent('[]');
    expect(screen.getByTestId('channel-notifications')).toHaveTextContent('[]');
  });

  it('syncServerCounts seeds absolute unread counts and drops zero/missing entries', () => {
    render(
      <UnreadProvider>
        <TestConsumer />
      </UnreadProvider>,
    );
    act(() => screen.getByText('syncSeed').click());
    // ch-2 had a server count of 0 → dropped; ch-1 and conv-1 are seeded.
    expect(screen.getByTestId('channel-counts')).toHaveTextContent('[["ch-1",3]]');
    expect(screen.getByTestId('conv-counts')).toHaveTextContent('[["conv-1",2]]');
  });

  it('a single live DM message reads as 1, never doubled against the server base', () => {
    // Regression for the "DM counter always shows 2" bug: the count map is the
    // SINGLE source. A read DM (server 0) that gets one live message is 1, and
    // a follow-up server sync (now 1) keeps it at 1 — never 1 + 1.
    render(
      <UnreadProvider>
        <TestConsumer />
      </UnreadProvider>,
    );
    act(() => screen.getByText('markConvo').click());
    expect(screen.getByTestId('conv-counts')).toHaveTextContent('[["conv-1",1]]');
    act(() => screen.getByText('syncOne').click()); // server now reports 1
    expect(screen.getByTestId('conv-counts')).toHaveTextContent('[["conv-1",1]]');
  });

  it('syncServerCounts never resurrects the channel/conversation being viewed', () => {
    render(
      <UnreadProvider>
        <TestConsumer />
      </UnreadProvider>,
    );
    act(() => screen.getByText('activateConv').click());
    act(() => screen.getByText('activateCh').click());
    // Server still reports unread for both active targets — they must be skipped
    // so the open channel/DM isn't lit up while you're looking at it.
    act(() => screen.getByText('syncSeed').click());
    expect(screen.getByTestId('channel-counts')).toHaveTextContent('[]');
    expect(screen.getByTestId('conv-counts')).toHaveTextContent('[]');
  });

  it('resetSessionUnread clears the live unread sets and counts', () => {
    render(
      <UnreadProvider>
        <TestConsumer />
      </UnreadProvider>,
    );
    act(() => screen.getByText('markChannel').click());
    act(() => screen.getByText('markConvo').click());
    expect(screen.getByTestId('channel-counts')).toHaveTextContent('[["ch-1",1]]');
    act(() => screen.getByText('resetSession').click());
    expect(screen.getByTestId('channels')).toHaveTextContent('[]');
    expect(screen.getByTestId('channel-counts')).toHaveTextContent('[]');
    expect(screen.getByTestId('conv-counts')).toHaveTextContent('[]');
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
