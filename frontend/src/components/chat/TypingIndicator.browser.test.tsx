import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { TypingIndicator, ThreadTypingIndicator } from './TypingIndicator';

const typingState = vi.hoisted(() => ({
  typingByParent: {} as Record<string, string[]>,
  typingByThread: {} as Record<string, string[]>,
}));

vi.mock('@/context/TypingContext', () => ({
  useTyping: () => typingState,
  threadTypingKey: (parentID: string, threadRootID: string) => `${parentID}::${threadRootID}`,
  formatTypingPhrase: (names: string[]) => {
    if (names.length === 1) return `${names[0]} is typing…`;
    return `${names.join(', ')} are typing…`;
  },
}));

describe('TypingIndicator browser behaviour', () => {
  it('renders nothing when no parentID is provided', async () => {
    typingState.typingByParent = { 'ch-1': ['u-2'] };
    await render(<TypingIndicator userMap={{ 'u-2': { displayName: 'Bob' } }} />);
    expect(document.querySelector('[data-testid="typing-indicator"]')).toBeNull();
  });

  it('renders nothing when the parent has no typers', async () => {
    typingState.typingByParent = {};
    await render(<TypingIndicator parentID="ch-1" userMap={{}} />);
    expect(document.querySelector('[data-testid="typing-indicator"]')).toBeNull();
  });

  it('renders the typing phrase resolved against userMap', async () => {
    typingState.typingByParent = { 'ch-1': ['u-2'] };
    const screen = await render(
      <TypingIndicator parentID="ch-1" userMap={{ 'u-2': { displayName: 'Bob' } }} />,
    );
    await expect.element(screen.getByText(/Bob is typing/)).toBeVisible();
  });

  it('falls back to the userID when the map lacks a displayName', async () => {
    typingState.typingByParent = { 'ch-1': ['u-X'] };
    const screen = await render(<TypingIndicator parentID="ch-1" userMap={{}} />);
    await expect.element(screen.getByText(/u-X is typing/)).toBeVisible();
  });
});

describe('ThreadTypingIndicator browser behaviour', () => {
  it('renders nothing when parentID or threadRootID is missing', async () => {
    typingState.typingByThread = { 'ch-1::root-1': ['u-2'] };
    await render(<ThreadTypingIndicator threadRootID="" userMap={{}} />);
    expect(document.querySelector('[data-testid="thread-typing-indicator"]')).toBeNull();
  });

  it('renders the phrase keyed off threadTypingKey(parentID, threadRootID)', async () => {
    typingState.typingByThread = { 'ch-1::root-1': ['u-2'] };
    const screen = await render(
      <ThreadTypingIndicator
        parentID="ch-1"
        threadRootID="root-1"
        userMap={{ 'u-2': { displayName: 'Bob' } }}
      />,
    );
    await expect.element(screen.getByText(/Bob is typing/)).toBeVisible();
  });
});
