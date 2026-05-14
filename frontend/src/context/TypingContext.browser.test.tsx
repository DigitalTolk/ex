import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render } from 'vitest-browser-react';
import {
  TypingProvider,
  useTyping,
  threadTypingKey,
  formatTypingPhrase,
} from './TypingContext';

// Browser coverage for TypingContext (7.81% → exercise rebuild,
// recordTyping, clearTyping, setSelfUserID, the 1s expiry timer, and
// formatTypingPhrase + threadTypingKey).

beforeEach(() => {
  vi.useRealTimers();
});

interface Probe {
  parents: Record<string, string[]>;
  threads: Record<string, string[]>;
  api: ReturnType<typeof useTyping>;
}

const probe: Probe = { parents: {}, threads: {}, api: null as unknown as ReturnType<typeof useTyping> };

function Capture() {
  const ctx = useTyping();
  useEffect(() => {
    probe.parents = ctx.typingByParent;
    probe.threads = ctx.typingByThread;
    probe.api = ctx;
  });
  return null;
}

async function waitParent(parentID: string, expected: string[] | undefined) {
  await vi.waitFor(() => {
    expect(probe.parents[parentID]).toEqual(expected);
  });
}

describe('TypingContext browser', () => {
  it('records a typing entry on main list and exposes it in typingByParent', async () => {
    await render(
      <TypingProvider>
        <Capture />
      </TypingProvider>,
    );
    probe.api.recordTyping('ch-1', 'u-alice');
    await waitParent('ch-1', ['u-alice']);
  });

  it('records a thread-scoped entry separately into typingByThread', async () => {
    await render(
      <TypingProvider>
        <Capture />
      </TypingProvider>,
    );
    probe.api.recordTyping('ch-1', 'u-bob', 'msg-root');
    await vi.waitFor(() => {
      expect(probe.threads[threadTypingKey('ch-1', 'msg-root')]).toEqual(['u-bob']);
    });
    expect(probe.parents['ch-1']).toBeUndefined();
  });

  it('drops self typing via setSelfUserID', async () => {
    await render(
      <TypingProvider>
        <Capture />
      </TypingProvider>,
    );
    probe.api.recordTyping('ch-1', 'u-me');
    await waitParent('ch-1', ['u-me']);
    probe.api.setSelfUserID('u-me');
    await waitParent('ch-1', undefined);
    probe.api.recordTyping('ch-1', 'u-alice');
    await waitParent('ch-1', ['u-alice']);
  });

  it('clearTyping removes a recorded entry immediately', async () => {
    await render(
      <TypingProvider>
        <Capture />
      </TypingProvider>,
    );
    probe.api.recordTyping('ch-1', 'u-alice');
    probe.api.recordTyping('ch-1', 'u-bob');
    await vi.waitFor(() => {
      expect(probe.parents['ch-1']?.sort()).toEqual(['u-alice', 'u-bob']);
    });
    probe.api.clearTyping('ch-1', 'u-alice');
    await waitParent('ch-1', ['u-bob']);
  });

  it('recordTyping rejects empty parent or user', async () => {
    await render(
      <TypingProvider>
        <Capture />
      </TypingProvider>,
    );
    probe.api.recordTyping('', 'u-alice');
    probe.api.recordTyping('ch-1', '');
    await new Promise((r) => setTimeout(r, 30));
    expect(probe.parents).toEqual({});
  });

  it('clearTyping is a no-op for unknown entries and empty args', async () => {
    await render(
      <TypingProvider>
        <Capture />
      </TypingProvider>,
    );
    probe.api.clearTyping('ch-1', 'u-unknown');
    probe.api.clearTyping('', 'u-alice');
    probe.api.clearTyping('ch-1', '');
    await new Promise((r) => setTimeout(r, 30));
    expect(probe.parents).toEqual({});
  });

  it('rebuild dedupes the same (parent, user) record', async () => {
    await render(
      <TypingProvider>
        <Capture />
      </TypingProvider>,
    );
    probe.api.recordTyping('ch-1', 'u-alice');
    probe.api.recordTyping('ch-1', 'u-alice');
    await waitParent('ch-1', ['u-alice']);
  });

  it('useTyping returns a noop value when used outside provider', async () => {
    let api: ReturnType<typeof useTyping> | null = null;
    function Inner() {
      const ctx = useTyping();
      useEffect(() => {
        api = ctx;
      }, [ctx]);
      return null;
    }
    await render(<Inner />);
    expect(api).not.toBeNull();
    api!.recordTyping('x', 'y');
    api!.clearTyping('x', 'y');
    api!.setSelfUserID('z');
    expect(api!.typingByParent).toEqual({});
    expect(api!.typingByThread).toEqual({});
  });

  it('entries expire after EXPIRY_MS and clear the parent bucket', async () => {
    const originalNow = Date.now;
    let nowOffset = 0;
    Date.now = () => originalNow() + nowOffset;
    try {
      await render(
        <TypingProvider>
          <Capture />
        </TypingProvider>,
      );
      probe.api.recordTyping('ch-1', 'u-alice');
      await waitParent('ch-1', ['u-alice']);
      // Advance virtual clock past EXPIRY_MS so the internal interval
      // sees the expiry on its next 1s tick.
      nowOffset = 10_000;
      await vi.waitFor(
        () => {
          expect(probe.parents['ch-1']).toBeUndefined();
        },
        { timeout: 2500 },
      );
    } finally {
      Date.now = originalNow;
    }
  });
});

describe('formatTypingPhrase', () => {
  it('returns empty string for zero names', () => {
    expect(formatTypingPhrase([])).toBe('');
  });
  it('singular phrasing for one name', () => {
    expect(formatTypingPhrase(['Alice'])).toMatch(/^Alice is typing/);
  });
  it('two names: A and B are typing…', () => {
    expect(formatTypingPhrase(['Alice', 'Bob'])).toMatch(/^Alice and Bob are typing/);
  });
  it('three names: A, B and C', () => {
    expect(formatTypingPhrase(['Alice', 'Bob', 'Cara'])).toMatch(/^Alice, Bob and Cara/);
  });
  it('4-5 names: collapses the tail to "N others"', () => {
    expect(formatTypingPhrase(['A', 'B', 'C', 'D'])).toMatch(/2 others/);
    expect(formatTypingPhrase(['A', 'B', 'C', 'D', 'E'])).toMatch(/3 others/);
  });
  it('6+ names: lots of people', () => {
    expect(formatTypingPhrase(['A', 'B', 'C', 'D', 'E', 'F'])).toMatch(/Lots of people/);
  });
});
