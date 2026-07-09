import { describe, it, expect, vi } from 'vitest';
import { useEffect } from 'react';
import { render, screen, act } from '@testing-library/react';
import { TypingProvider, useTyping } from '@/context/TypingContext';
import { TypingIndicator, ThreadTypingIndicator } from '@/components/chat/TypingIndicator';

const recorderRef: { current: ReturnType<typeof useTyping>['recordTyping'] | null } = {
  current: null,
};

function Recorder() {
  const { recordTyping } = useTyping();
  useEffect(() => {
    recorderRef.current = recordTyping;
  }, [recordTyping]);
  return null;
}

function recordExternal(parentID: string, _parentType: string, userID: string, threadRootID = '') {
  recorderRef.current?.(parentID, userID, threadRootID);
}

function Harness({ parentID }: { parentID?: string }) {
  return (
    <TypingProvider>
      <Recorder />
      <TypingIndicator
        parentID={parentID}
        userMap={{
          'u-1': { displayName: 'Alice' },
          'u-2': { displayName: 'Bob' },
        }}
      />
    </TypingProvider>
  );
}

describe('TypingIndicator', () => {
  it('renders nothing when nobody is typing', () => {
    render(<Harness parentID="ch-1" />);
    expect(screen.queryByTestId('typing-indicator')).toBeNull();
  });

  it('renders the formatted phrase using userMap names', () => {
    render(<Harness parentID="ch-1" />);
    act(() => {
      recordExternal('ch-1', 'channel', 'u-1');
    });
    expect(screen.getByTestId('typing-indicator').textContent).toBe('Alice is typing…');
  });

  it('falls back to userID when the userMap entry is missing', () => {
    render(<Harness parentID="ch-1" />);
    act(() => {
      recordExternal('ch-1', 'channel', 'u-stranger');
    });
    expect(screen.getByTestId('typing-indicator').textContent).toBe('u-stranger is typing…');
  });

  it('renders nothing when parentID is missing', () => {
    render(<Harness parentID={undefined} />);
    act(() => {
      recordExternal('ch-1', 'channel', 'u-1');
    });
    expect(screen.queryByTestId('typing-indicator')).toBeNull();
  });

  it('combines two names with "and"', () => {
    render(<Harness parentID="ch-1" />);
    act(() => {
      recordExternal('ch-1', 'channel', 'u-1');
      recordExternal('ch-1', 'channel', 'u-2');
    });
    expect(screen.getByTestId('typing-indicator').textContent).toBe(
      'Alice and Bob are typing…',
    );
  });

  it('does NOT render thread typing in the main typing indicator', () => {
    // Bob is typing inside the m-1 thread of ch-1; the channel-level
    // TypingIndicator must not surface him — that belongs in the
    // ThreadPanel only.
    render(<Harness parentID="ch-1" />);
    act(() => {
      recordExternal('ch-1', 'channel', 'u-2', 'm-1');
    });
    expect(screen.queryByTestId('typing-indicator')).toBeNull();
  });
});

function ThreadHarness({
  parentID,
  threadRootID,
}: {
  parentID?: string;
  threadRootID: string;
}) {
  return (
    <TypingProvider>
      <Recorder />
      <ThreadTypingIndicator
        parentID={parentID}
        threadRootID={threadRootID}
        userMap={{
          'u-1': { displayName: 'Alice' },
          'u-2': { displayName: 'Bob' },
        }}
      />
    </TypingProvider>
  );
}

describe('ThreadTypingIndicator', () => {
  it('renders nothing when nobody is typing in the thread', () => {
    render(<ThreadHarness parentID="ch-1" threadRootID="m-1" />);
    expect(screen.queryByTestId('thread-typing-indicator')).toBeNull();
  });

  it('renders typing scoped to the (parentID, threadRootID) pair', () => {
    render(<ThreadHarness parentID="ch-1" threadRootID="m-1" />);
    act(() => {
      recordExternal('ch-1', 'channel', 'u-2', 'm-1');
    });
    expect(screen.getByTestId('thread-typing-indicator').textContent).toBe(
      'Bob is typing…',
    );
  });

  it('does NOT render main-list typing inside a thread', () => {
    // u-2 is typing in the main composer for ch-1; ThreadPanel for m-1
    // must not reflect that.
    render(<ThreadHarness parentID="ch-1" threadRootID="m-1" />);
    act(() => {
      recordExternal('ch-1', 'channel', 'u-2');
    });
    expect(screen.queryByTestId('thread-typing-indicator')).toBeNull();
  });

  it('does NOT render typing from a different thread on the same channel', () => {
    render(<ThreadHarness parentID="ch-1" threadRootID="m-1" />);
    act(() => {
      recordExternal('ch-1', 'channel', 'u-2', 'm-OTHER');
    });
    expect(screen.queryByTestId('thread-typing-indicator')).toBeNull();
  });

  it('renders nothing when parentID is missing', () => {
    render(<ThreadHarness parentID={undefined} threadRootID="m-1" />);
    act(() => {
      recordExternal('ch-1', 'channel', 'u-1', 'm-1');
    });
    expect(screen.queryByTestId('thread-typing-indicator')).toBeNull();
  });
});

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
