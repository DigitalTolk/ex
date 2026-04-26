import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { UnreadProvider, useUnread } from './UnreadContext';

function TestConsumer() {
  const {
    unreadChannels,
    unreadConversations,
    markChannelUnread,
    markConversationUnread,
    clearChannelUnread,
    clearConversationUnread,
  } = useUnread();

  return (
    <div>
      <span data-testid="channels">{JSON.stringify([...unreadChannels])}</span>
      <span data-testid="conversations">{JSON.stringify([...unreadConversations])}</span>
      <button onClick={() => markChannelUnread('ch-1')}>markChannel</button>
      <button onClick={() => clearChannelUnread('ch-1')}>clearChannel</button>
      <button onClick={() => markConversationUnread('conv-1')}>markConvo</button>
      <button onClick={() => clearConversationUnread('conv-1')}>clearConvo</button>
    </div>
  );
}

describe('UnreadContext', () => {
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
});
