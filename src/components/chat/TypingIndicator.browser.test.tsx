import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { TypingIndicator, ThreadTypingIndicator } from './TypingIndicator';
import { threadTypingKey, useTypingStore } from '@/stores/typing';

// The indicators subscribe to the typing STORE per-bucket (not the
// context), so these tests seed the real store; the global afterEach in
// browser-setup resets it between tests.

function seedParent(map: Record<string, string[]>) {
  useTypingStore.setState({ typingByParent: map });
}
function seedThread(map: Record<string, string[]>) {
  useTypingStore.setState({ typingByThread: map });
}

describe('TypingIndicator browser behaviour', () => {
  it('renders nothing when no parentID is provided', async () => {
    seedParent({ 'ch-1': ['u-2'] });
    await render(<TypingIndicator userMap={{ 'u-2': { displayName: 'Bob' } }} />);
    expect(document.querySelector('[data-testid="typing-indicator"]')).toBeNull();
  });

  it('renders nothing when the parent has no typers', async () => {
    seedParent({});
    await render(<TypingIndicator parentID="ch-1" userMap={{}} />);
    expect(document.querySelector('[data-testid="typing-indicator"]')).toBeNull();
  });

  it('renders the typing phrase resolved against userMap', async () => {
    seedParent({ 'ch-1': ['u-2'] });
    const screen = await render(
      <TypingIndicator parentID="ch-1" userMap={{ 'u-2': { displayName: 'Bob' } }} />,
    );
    await expect.element(screen.getByText(/Bob is typing/)).toBeVisible();
  });

  it('falls back to the userID when the map lacks a displayName', async () => {
    seedParent({ 'ch-1': ['u-X'] });
    const screen = await render(<TypingIndicator parentID="ch-1" userMap={{}} />);
    await expect.element(screen.getByText(/u-X is typing/)).toBeVisible();
  });
});

describe('ThreadTypingIndicator browser behaviour', () => {
  it('renders nothing when parentID or threadRootID is missing', async () => {
    seedThread({ [threadTypingKey('ch-1', 'root-1')]: ['u-2'] });
    await render(<ThreadTypingIndicator threadRootID="" userMap={{}} />);
    expect(document.querySelector('[data-testid="thread-typing-indicator"]')).toBeNull();
  });

  it('renders the phrase keyed off threadTypingKey(parentID, threadRootID)', async () => {
    seedThread({ [threadTypingKey('ch-1', 'root-1')]: ['u-2'] });
    const screen = await render(
      <ThreadTypingIndicator
        parentID="ch-1"
        threadRootID="root-1"
        userMap={{ 'u-2': { displayName: 'Bob' } }}
      />,
    );
    await expect.element(screen.getByText(/Bob is typing/)).toBeVisible();
  });

  it('falls back to the userID when the thread map lacks a displayName', async () => {
    // No userMap entry for the typer → the `?? id` fallback resolves the
    // raw userID instead of a display name.
    seedThread({ [threadTypingKey('ch-1', 'root-1')]: ['u-Z'] });
    const screen = await render(
      <ThreadTypingIndicator parentID="ch-1" threadRootID="root-1" userMap={{}} />,
    );
    await expect.element(screen.getByText(/u-Z is typing/)).toBeVisible();
  });
});
