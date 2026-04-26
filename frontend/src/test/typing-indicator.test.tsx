import { describe, it, expect, vi } from 'vitest';
import { useEffect } from 'react';
import { render, screen, act } from '@testing-library/react';
import { TypingProvider, useTyping } from '@/context/TypingContext';
import { TypingIndicator } from '@/components/chat/TypingIndicator';

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

function recordExternal(parentID: string, _parentType: string, userID: string) {
  recorderRef.current?.(parentID, userID);
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
});

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
