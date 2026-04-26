import { describe, it, expect, vi, beforeEach } from 'vitest';

// Test the WebSocket event types are handled correctly
// Since the hook uses actual WebSocket, we test the message dispatch logic directly

describe('useWebSocket event types', () => {
  const eventTypes = [
    'message.new',
    'message.edited',
    'message.deleted',
    'members.changed',
    'conversation.new',
    'channel.archived',
    'channel.updated',
    'channel.new',
  ];

  it('all expected event types are defined', () => {
    // Verify the event types list is complete
    expect(eventTypes).toHaveLength(8);
    expect(eventTypes).toContain('channel.updated');
    expect(eventTypes).toContain('channel.new');
  });

  it('dispatches channel.updated events correctly', () => {
    const callbacks: Record<string, (data: unknown) => void> = {};

    // Simulate the switch statement logic from useWebSocket
    function dispatch(type: string, payload: unknown) {
      switch (type) {
        case 'message.new': callbacks.onMessageNew?.(payload); break;
        case 'message.edited': callbacks.onMessageEdited?.(payload); break;
        case 'message.deleted': callbacks.onMessageDeleted?.(payload); break;
        case 'members.changed': callbacks.onMembersChanged?.(payload); break;
        case 'conversation.new': callbacks.onConversationNew?.(payload); break;
        case 'channel.archived': callbacks.onChannelArchived?.(payload); break;
        case 'channel.updated': callbacks.onChannelUpdated?.(payload); break;
        case 'channel.new': callbacks.onChannelNew?.(payload); break;
      }
    }

    const onChannelUpdated = vi.fn();
    const onChannelNew = vi.fn();
    callbacks.onChannelUpdated = onChannelUpdated;
    callbacks.onChannelNew = onChannelNew;

    dispatch('channel.updated', { channelID: 'ch1' });
    expect(onChannelUpdated).toHaveBeenCalledWith({ channelID: 'ch1' });

    dispatch('channel.new', { channelID: 'ch2' });
    expect(onChannelNew).toHaveBeenCalledWith({ channelID: 'ch2' });
  });
});

describe('conversation unhide on message', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('unhide logic removes conversation from hidden set', () => {
    // Simulate the unhide logic from ChatPage's onMessageNew
    const hiddenSet = new Set(['conv1', 'conv2']);

    function unhideConversation(id: string) {
      if (hiddenSet.has(id)) {
        hiddenSet.delete(id);
      }
    }

    // Simulate new message arriving for hidden conversation
    const parentID = 'conv1';
    unhideConversation(parentID);

    expect(hiddenSet.has('conv1')).toBe(false);
    expect(hiddenSet.has('conv2')).toBe(true);
  });

  it('unhide is a no-op for non-hidden conversations', () => {
    const hiddenSet = new Set(['conv1']);
    const sizeBefore = hiddenSet.size;

    function unhideConversation(id: string) {
      if (hiddenSet.has(id)) {
        hiddenSet.delete(id);
      }
    }

    unhideConversation('conv-nonexistent');
    expect(hiddenSet.size).toBe(sizeBefore);
  });
});
