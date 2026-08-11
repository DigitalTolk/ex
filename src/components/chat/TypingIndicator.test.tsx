import { describe, it, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { TypingProvider, useTyping } from '@/context/TypingContext';
import { ThreadTypingIndicator, TypingIndicator } from './TypingIndicator';

// Captures recordTyping so a test can populate the thread typing map, then
// renders the thread indicator alongside it.
function Harness({ capture }: { capture: (fn: (p: string, u: string, r: string) => void) => void }) {
  const { recordTyping } = useTyping();
  useEffect(() => {
    capture(recordTyping);
  }, [recordTyping, capture]);
  return <ThreadTypingIndicator parentID="p1" threadRootID="r1" userMap={{}} />;
}

// Same, for the main-list indicator.
function MainHarness({ capture }: { capture: (fn: (p: string, u: string) => void) => void }) {
  const { recordTyping } = useTyping();
  useEffect(() => {
    capture(recordTyping);
  }, [recordTyping, capture]);
  return <TypingIndicator parentID="p1" userMap={{}} />;
}

describe('bot typing', () => {
  it('names Cliffy by name while it composes a reply, in the channel and in a thread', () => {
    // Cliffy is a bot user, so it is never in userMap — without this it would
    // show up as "bot_cliffy is typing".
    let record: ((p: string, u: string) => void) | undefined;
    const main = render(
      <TypingProvider>
        <MainHarness capture={(fn) => { record = fn; }} />
      </TypingProvider>,
    );
    act(() => record!('p1', 'bot_cliffy'));
    expect(screen.getByTestId('typing-indicator')).toHaveTextContent('Cliffy is typing');
    main.unmount();

    let threadRecord: ((p: string, u: string, r: string) => void) | undefined;
    render(
      <TypingProvider>
        <Harness capture={(fn) => { threadRecord = fn; }} />
      </TypingProvider>,
    );
    act(() => threadRecord!('p1', 'bot_cliffy', 'r1'));
    expect(screen.getByTestId('thread-typing-indicator')).toHaveTextContent('Cliffy is typing');
  });
});

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
