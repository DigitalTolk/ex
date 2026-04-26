import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, act } from '@testing-library/react';
import { TypingProvider, useTyping, formatTypingPhrase } from '@/context/TypingContext';

let captured: ReturnType<typeof useTyping> | null = null;
function Probe() {
  const v = useTyping();
  useEffect(() => {
    captured = v;
  }, [v]);
  return null;
}

function setup() {
  return render(
    <TypingProvider>
      <Probe />
    </TypingProvider>,
  );
}

describe('formatTypingPhrase', () => {
  it('handles every cardinality boundary', () => {
    expect(formatTypingPhrase([])).toBe('');
    expect(formatTypingPhrase(['Alice'])).toBe('Alice is typing…');
    expect(formatTypingPhrase(['Alice', 'Bob'])).toBe('Alice and Bob are typing…');
    expect(formatTypingPhrase(['Alice', 'Bob', 'Cara'])).toBe(
      'Alice, Bob and Cara are typing…',
    );
    expect(formatTypingPhrase(['A', 'B', 'C', 'D'])).toBe(
      'A, B and 2 others are typing…',
    );
    expect(formatTypingPhrase(['A', 'B', 'C', 'D', 'E'])).toBe(
      'A, B and 3 others are typing…',
    );
    expect(formatTypingPhrase(['A', 'B', 'C', 'D', 'E', 'F'])).toBe(
      'Lots of people are typing…',
    );
    expect(formatTypingPhrase(['A', 'B', 'C', 'D', 'E', 'F', 'G'])).toBe(
      'Lots of people are typing…',
    );
  });
});

describe('TypingProvider', () => {
  beforeEach(() => {
    captured = null;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records a typing user and exposes them under the parentID', () => {
    setup();
    act(() => {
      captured!.recordTyping('ch-1', 'u-bob');
    });
    expect(captured!.typingByParent).toEqual({ 'ch-1': ['u-bob'] });
  });

  it('drops the viewer themselves from the indicator', () => {
    setup();
    act(() => {
      captured!.setSelfUserID('u-me');
      captured!.recordTyping('ch-1', 'u-me');
      captured!.recordTyping('ch-1', 'u-other');
    });
    expect(captured!.typingByParent['ch-1']).toEqual(['u-other']);
  });

  it('refreshes the expiry on a duplicate ping (does not double-count)', () => {
    setup();
    act(() => {
      captured!.recordTyping('ch-1', 'u-bob');
      captured!.recordTyping('ch-1', 'u-bob');
    });
    expect(captured!.typingByParent['ch-1']).toEqual(['u-bob']);
  });

  it('expires entries after 5 seconds with no refresh', () => {
    setup();
    act(() => {
      captured!.recordTyping('ch-1', 'u-bob');
    });
    expect(captured!.typingByParent['ch-1']).toEqual(['u-bob']);
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(captured!.typingByParent['ch-1']).toBeUndefined();
  });

  it('groups multiple typers under the same parent', () => {
    setup();
    act(() => {
      captured!.recordTyping('ch-1', 'u-a');
      captured!.recordTyping('ch-1', 'u-b');
      captured!.recordTyping('ch-1', 'u-c');
    });
    expect(captured!.typingByParent['ch-1']).toEqual(['u-a', 'u-b', 'u-c']);
  });

  it('keeps separate buckets per parent', () => {
    setup();
    act(() => {
      captured!.recordTyping('ch-1', 'u-a');
      captured!.recordTyping('c-2', 'u-b');
    });
    expect(captured!.typingByParent).toEqual({
      'ch-1': ['u-a'],
      'c-2': ['u-b'],
    });
  });

  it('ignores blank inputs', () => {
    setup();
    act(() => {
      captured!.recordTyping('', 'u-a');
      captured!.recordTyping('ch-1', '');
    });
    expect(captured!.typingByParent).toEqual({});
  });

  it('useTyping returns a no-op fallback outside the provider', () => {
    let outer: ReturnType<typeof useTyping> | null = null;
    function StandaloneProbe() {
      const v = useTyping();
      useEffect(() => {
        outer = v;
      }, [v]);
      return null;
    }
    render(<StandaloneProbe />);
    expect(() => outer!.recordTyping('a', 'c')).not.toThrow();
    expect(outer!.typingByParent).toEqual({});
  });
});
