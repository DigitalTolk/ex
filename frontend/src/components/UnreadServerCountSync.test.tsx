import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { UnreadServerCountSync } from './UnreadServerCountSync';

const mockState = vi.hoisted(() => ({
  isAuthenticated: true,
  channels: undefined as { channelID: string; unreadCount?: number }[] | undefined,
  conversations: undefined as { conversationID: string; unreadCount?: number }[] | undefined,
  syncServerCounts: vi.fn(),
  useUserChannels: vi.fn(),
  useUserConversations: vi.fn(),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: mockState.isAuthenticated }),
}));
vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({ syncServerCounts: mockState.syncServerCounts }),
}));
vi.mock('@/hooks/useChannels', () => ({
  useUserChannels: (opts?: { enabled?: boolean }) => {
    mockState.useUserChannels(opts);
    return { data: mockState.channels };
  },
}));
vi.mock('@/hooks/useConversations', () => ({
  useUserConversations: (opts?: { enabled?: boolean }) => {
    mockState.useUserConversations(opts);
    return { data: mockState.conversations };
  },
}));

describe('UnreadServerCountSync', () => {
  beforeEach(() => {
    mockState.isAuthenticated = true;
    mockState.channels = undefined;
    mockState.conversations = undefined;
    mockState.syncServerCounts.mockClear();
    mockState.useUserChannels.mockClear();
    mockState.useUserConversations.mockClear();
  });

  it('reconciles the server seq counts into the context maps', () => {
    mockState.channels = [
      { channelID: 'ch-1', unreadCount: 3 },
      { channelID: 'ch-2' }, // missing unreadCount → coerced to 0
    ];
    mockState.conversations = [
      { conversationID: 'conv-1', unreadCount: 2 },
      { conversationID: 'conv-2' }, // missing unreadCount → coerced to 0
    ];

    render(<UnreadServerCountSync />);

    expect(mockState.syncServerCounts).toHaveBeenCalledTimes(1);
    const [channelCounts, conversationCounts] = mockState.syncServerCounts.mock.calls[0];
    expect(channelCounts).toEqual(new Map([['ch-1', 3], ['ch-2', 0]]));
    expect(conversationCounts).toEqual(new Map([['conv-1', 2], ['conv-2', 0]]));
  });

  it('passes empty maps when the lists have not loaded yet', () => {
    render(<UnreadServerCountSync />);
    expect(mockState.syncServerCounts).toHaveBeenCalledWith(new Map(), new Map());
  });

  it('gates the underlying list fetches on authentication', () => {
    mockState.isAuthenticated = false;
    render(<UnreadServerCountSync />);
    expect(mockState.useUserChannels).toHaveBeenCalledWith({ enabled: false });
    expect(mockState.useUserConversations).toHaveBeenCalledWith({ enabled: false });
  });

  it('renders nothing', () => {
    const { container } = render(<UnreadServerCountSync />);
    expect(container).toBeEmptyDOMElement();
  });
});
