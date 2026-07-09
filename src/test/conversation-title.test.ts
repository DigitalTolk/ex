import { describe, it, expect } from 'vitest';

// Test the conversation title derivation logic from ConversationView
// Extracted here for unit testing without full component rendering

interface MinimalConversation {
  type: 'dm' | 'group';
  name?: string;
}

function deriveTitle(
  conversation: MinimalConversation | undefined,
  participantNames: Record<string, string>,
  currentUserId: string,
): { title: string; subtitle: string | undefined } {
  let title = conversation?.name || 'Direct Message';
  let subtitle: string | undefined;

  if (conversation?.type === 'dm' && Object.keys(participantNames).length > 0) {
    const otherName = Object.entries(participantNames).find(([pid]) => pid !== currentUserId)?.[1];
    if (otherName) title = otherName;
  } else if (conversation?.type === 'group' && Object.keys(participantNames).length > 0) {
    const names = Object.entries(participantNames)
      .filter(([pid]) => pid !== currentUserId)
      .map(([, name]) => name);
    if (!conversation?.name && names.length > 0) {
      title = names.join(', ');
    }
    subtitle = Object.values(participantNames).join(', ');
  }

  return { title, subtitle };
}

describe('conversation title derivation', () => {
  it('shows other user name for DMs', () => {
    const result = deriveTitle(
      { type: 'dm' },
      { user1: 'Me', user2: 'Alice' },
      'user1',
    );
    expect(result.title).toBe('Alice');
    expect(result.subtitle).toBeUndefined();
  });

  it('falls back to "Direct Message" when no participants loaded', () => {
    const result = deriveTitle({ type: 'dm' }, {}, 'user1');
    expect(result.title).toBe('Direct Message');
  });

  it('shows group name when set', () => {
    const result = deriveTitle(
      { type: 'group', name: 'Project Team' },
      { user1: 'Me', user2: 'Alice', user3: 'Bob' },
      'user1',
    );
    expect(result.title).toBe('Project Team');
    expect(result.subtitle).toBe('Me, Alice, Bob');
  });

  it('shows participant names as title for unnamed groups', () => {
    const result = deriveTitle(
      { type: 'group' },
      { user1: 'Me', user2: 'Alice', user3: 'Bob' },
      'user1',
    );
    expect(result.title).toBe('Alice, Bob');
    expect(result.subtitle).toBe('Me, Alice, Bob');
  });

  it('handles self-only DM', () => {
    const result = deriveTitle(
      { type: 'dm' },
      { user1: 'Me' },
      'user1',
    );
    // No other user found, stays as default
    expect(result.title).toBe('Direct Message');
  });

  it('handles undefined conversation', () => {
    const result = deriveTitle(undefined, {}, 'user1');
    expect(result.title).toBe('Direct Message');
    expect(result.subtitle).toBeUndefined();
  });
});
