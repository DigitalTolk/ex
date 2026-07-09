import { describe, it, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { TypingProvider, useTyping } from '@/context/TypingContext';
import { ThreadTypingIndicator } from './TypingIndicator';

// Captures recordTyping so a test can populate the thread typing map, then
// renders the thread indicator alongside it.
function Harness({ capture }: { capture: (fn: (p: string, u: string, r: string) => void) => void }) {
  const { recordTyping } = useTyping();
  useEffect(() => {
    capture(recordTyping);
  }, [recordTyping, capture]);
  return <ThreadTypingIndicator parentID="p1" threadRootID="r1" userMap={{}} />;
}

describe('ThreadTypingIndicator', () => {
  it('falls back to the raw user id when the typist is absent from userMap', () => {
    let record: ((p: string, u: string, r: string) => void) | undefined;
    render(
      <TypingProvider>
        <Harness capture={(fn) => { record = fn; }} />
      </TypingProvider>,
    );

    act(() => record!('p1', 'u-unknown', 'r1'));

    // u-unknown is not in userMap, so its id is rendered verbatim.
    expect(screen.getByTestId('thread-typing-indicator')).toHaveTextContent('u-unknown is typing');
  });

  it('renders nothing when no one is typing in the thread', () => {
    render(
      <TypingProvider>
        <ThreadTypingIndicator parentID="p1" threadRootID="r1" userMap={{}} />
      </TypingProvider>,
    );
    expect(screen.queryByTestId('thread-typing-indicator')).toBeNull();
  });
});
