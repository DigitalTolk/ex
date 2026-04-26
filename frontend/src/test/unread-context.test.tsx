import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { UnreadProvider, useUnread } from '@/context/UnreadContext';
import type { ReactNode } from 'react';

const wrapper = ({ children }: { children: ReactNode }) => (
  <UnreadProvider>{children}</UnreadProvider>
);

describe('UnreadContext', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('marks and clears channel unread', () => {
    const { result } = renderHook(() => useUnread(), { wrapper });
    act(() => result.current.markChannelUnread('ch1'));
    expect(result.current.unreadChannels.has('ch1')).toBe(true);
    act(() => result.current.clearChannelUnread('ch1'));
    expect(result.current.unreadChannels.has('ch1')).toBe(false);
  });

  it('marks and clears conversation unread', () => {
    const { result } = renderHook(() => useUnread(), { wrapper });
    act(() => result.current.markConversationUnread('conv1'));
    expect(result.current.unreadConversations.has('conv1')).toBe(true);
    act(() => result.current.clearConversationUnread('conv1'));
    expect(result.current.unreadConversations.has('conv1')).toBe(false);
  });

  it('hides and unhides conversations', () => {
    const { result } = renderHook(() => useUnread(), { wrapper });

    act(() => result.current.hideConversation('conv1'));
    expect(result.current.hiddenConversations.has('conv1')).toBe(true);

    // Check persistence
    const stored = JSON.parse(localStorage.getItem('hidden_conversations')!);
    expect(stored).toContain('conv1');

    act(() => result.current.unhideConversation('conv1'));
    expect(result.current.hiddenConversations.has('conv1')).toBe(false);

    const storedAfter = JSON.parse(localStorage.getItem('hidden_conversations')!);
    expect(storedAfter).not.toContain('conv1');
  });

  it('loads hidden conversations from localStorage', () => {
    localStorage.setItem('hidden_conversations', JSON.stringify(['conv1', 'conv2']));
    const { result } = renderHook(() => useUnread(), { wrapper });
    expect(result.current.hiddenConversations.has('conv1')).toBe(true);
    expect(result.current.hiddenConversations.has('conv2')).toBe(true);
  });

  it('unhideConversation is a no-op for non-hidden conversations', () => {
    const { result } = renderHook(() => useUnread(), { wrapper });
    const before = result.current.hiddenConversations;
    act(() => result.current.unhideConversation('nonexistent'));
    // Should be the same reference (no state update)
    expect(result.current.hiddenConversations).toBe(before);
  });

  it('throws when used outside provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => {
      renderHook(() => useUnread());
    }).toThrow('useUnread must be used within UnreadProvider');
    spy.mockRestore();
  });
});
