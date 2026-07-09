import { describe, it, expect } from 'vitest';
import type {
  User,
  Channel,
  Message,
  Conversation,
  ChannelMembership,
  UserChannel,
  UserConversation,
  PaginatedResponse,
} from './index';

describe('type interfaces compile and can be used at runtime', () => {
  it('User shape is valid', () => {
    const user: User = {
      id: '1',
      email: 'test@example.com',
      displayName: 'Test',
      systemRole: 'member',
      status: 'active',
    };
    expect(user.id).toBe('1');
    expect(user.systemRole).toBe('member');
  });

  it('Channel shape is valid', () => {
    const channel: Channel = {
      id: 'ch-1',
      name: 'general',
      type: 'public',
      createdBy: 'user-1',
      archived: false,
      createdAt: '2025-01-01T00:00:00Z',
    };
    expect(channel.name).toBe('general');
    expect(channel.type).toBe('public');
  });

  it('Message shape is valid', () => {
    const message: Message = {
      id: 'msg-1',
      parentID: 'ch-1',
      authorID: 'user-1',
      body: 'Hello!',
      createdAt: '2025-01-01T00:00:00Z',
    };
    expect(message.body).toBe('Hello!');
    expect(message.editedAt).toBeUndefined();
  });

  it('Conversation shape is valid', () => {
    const conv: Conversation = {
      id: 'conv-1',
      type: 'dm',
      participantIDs: ['u1', 'u2'],
      createdAt: '2025-01-01T00:00:00Z',
    };
    expect(conv.type).toBe('dm');
    expect(conv.participantIDs).toHaveLength(2);
  });

  it('ChannelMembership shape is valid', () => {
    const m: ChannelMembership = {
      channelID: 'ch-1',
      userID: 'u-1',
      role: 'member',
      displayName: 'Alice',
      joinedAt: '2025-01-01T00:00:00Z',
    };
    expect(m.role).toBe('member');
  });

  it('UserChannel shape is valid', () => {
    const uc: UserChannel = {
      channelID: 'ch-1',
      channelName: 'general',
      channelType: 'public',
      role: 2,
    };
    expect(uc.channelName).toBe('general');
    expect(uc.lastReadMsgID).toBeUndefined();
  });

  it('UserConversation shape is valid', () => {
    const uc: UserConversation = {
      conversationID: 'conv-1',
      type: 'dm',
      displayName: 'Bob',
    };
    expect(uc.type).toBe('dm');
  });

  it('PaginatedResponse shape is valid', () => {
    const page: PaginatedResponse<Message> = {
      items: [
        {
          id: 'msg-1',
          parentID: 'ch-1',
          authorID: 'u-1',
          body: 'hi',
          createdAt: '2025-01-01T00:00:00Z',
        },
      ],
      hasMore: true,
      nextCursor: 'cursor-abc',
    };
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
  });
});
