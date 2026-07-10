import { describe, it, expect, afterEach, vi } from 'vitest';
import { BroadcastChannel, createLeaderElection } from 'broadcast-channel';
import {
  initTabCoordinator,
  isLeaderTab,
  hasOtherTabs,
  setTabActiveParent,
  remoteTabViewing,
  remoteUserAtDevice,
  resetTabCoordinatorForTests,
  getTabChannelForTests,
  getTabElectorForTests,
} from '@/lib/tab-leader';
import { markUserActivity, setActivityBroadcast } from '@/lib/user-activity';

// The coordinator runs against REAL broadcast-channel primitives in
// 'simulate' mode: channels created with the same name inside this process
// deliver to each other, so a test can stand in for a second tab.

type AnyMsg = { kind: string; tabId: string; state?: { visible: boolean; lastActivityAt: number; activeParent: string | null } };

function makePeerChannel(): BroadcastChannel<AnyMsg> {
  return new BroadcastChannel<AnyMsg>('ex-tabs', { type: 'simulate' });
}

async function flush(ms = 50): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

afterEach(async () => {
  await resetTabCoordinatorForTests();
  setActivityBroadcast(null);
});

describe('uninitialized (single-tab / test) baseline', () => {
  it('behaves like a lone leader with no remote knowledge', () => {
    expect(isLeaderTab()).toBe(true);
    expect(hasOtherTabs()).toBe(false);
    expect(remoteTabViewing('ch-1', 60_000)).toBe(false);
    expect(remoteUserAtDevice(60_000)).toBe(false);
    // No coordinator → sharing state is a harmless no-op.
    setTabActiveParent('ch-1');
    setTabActiveParent(null);
  });
});

describe('initTabCoordinator', () => {
  it('is idempotent and eventually elects the lone tab leader', async () => {
    initTabCoordinator({ type: 'simulate' });
    initTabCoordinator({ type: 'simulate' }); // second call: no-op
    await vi.waitFor(() => {
      expect(isLeaderTab()).toBe(true);
    });
  });

  it('tracks remote tab state and answers whole-device questions', async () => {
    initTabCoordinator({ type: 'simulate' });
    const peer = makePeerChannel();
    try {
      await peer.postMessage({
        kind: 'state',
        tabId: 'peer-1',
        state: { visible: true, lastActivityAt: Date.now(), activeParent: 'ch-9' },
      });
      await vi.waitFor(() => {
        expect(hasOtherTabs()).toBe(true);
      });
      expect(remoteTabViewing('ch-9', 60_000)).toBe(true);
      expect(remoteTabViewing('ch-other', 60_000)).toBe(false);
      expect(remoteUserAtDevice(60_000)).toBe(true);
      // Stale activity: the tab is there but the human is not.
      await peer.postMessage({
        kind: 'state',
        tabId: 'peer-1',
        state: { visible: true, lastActivityAt: Date.now() - 60 * 60_000, activeParent: 'ch-9' },
      });
      await vi.waitFor(() => {
        expect(remoteUserAtDevice(60_000)).toBe(false);
      });
      expect(remoteTabViewing('ch-9', 60_000)).toBe(false);
      // Hidden tab: never counts as at-device or viewing.
      await peer.postMessage({
        kind: 'state',
        tabId: 'peer-1',
        state: { visible: false, lastActivityAt: Date.now(), activeParent: 'ch-9' },
      });
      await vi.waitFor(() => {
        expect(remoteUserAtDevice(60_000)).toBe(false);
      });
      expect(remoteTabViewing('ch-9', 60_000)).toBe(false);
    } finally {
      await peer.close();
    }
  });

  it('a "bye" removes the remote tab immediately', async () => {
    initTabCoordinator({ type: 'simulate' });
    const peer = makePeerChannel();
    try {
      await peer.postMessage({
        kind: 'state',
        tabId: 'peer-bye',
        state: { visible: true, lastActivityAt: Date.now(), activeParent: null },
      });
      await vi.waitFor(() => {
        expect(hasOtherTabs()).toBe(true);
      });
      await peer.postMessage({ kind: 'bye', tabId: 'peer-bye' });
      await vi.waitFor(() => {
        expect(hasOtherTabs()).toBe(false);
      });
    } finally {
      await peer.close();
    }
  });

  it('broadcasts its own state on init, active-parent change, visibility flip, and (throttled) activity', async () => {
    const peer = makePeerChannel();
    const seen: AnyMsg[] = [];
    peer.onmessage = (m) => {
      seen.push(m);
    };
    try {
      initTabCoordinator({ type: 'simulate' });
      await vi.waitFor(() => {
        expect(seen.some((m) => m.kind === 'state')).toBe(true);
      });

      const before = seen.length;
      setTabActiveParent('ch-42');
      await vi.waitFor(() => {
        expect(seen.length).toBeGreaterThan(before);
      });
      expect(seen[seen.length - 1].state?.activeParent).toBe('ch-42');

      // Visibility change re-broadcasts.
      const beforeVis = seen.length;
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.waitFor(() => {
        expect(seen.length).toBeGreaterThan(beforeVis);
      });

      // Activity forwards through the user-activity seam, throttled: the
      // first stamp after init broadcasts, an immediate second one doesn't.
      const beforeAct = seen.length;
      markUserActivity(Date.now());
      await flush();
      const afterFirst = seen.length;
      expect(afterFirst).toBeGreaterThan(beforeAct);
      markUserActivity(Date.now());
      await flush();
      expect(seen.length).toBe(afterFirst);
    } finally {
      await peer.close();
    }
  });

  it('ignores its own broadcasts (no self-entry in the remote map)', async () => {
    initTabCoordinator({ type: 'simulate' });
    setTabActiveParent('ch-self');
    await flush();
    expect(hasOtherTabs()).toBe(false);
  });
});

describe('leader election across "tabs"', () => {
  it('stays non-leader while another elector holds leadership, then takes over when it dies', async () => {
    // A rival elector (the "other tab") grabs leadership FIRST.
    const rivalChannel = makePeerChannel();
    const rival = createLeaderElection(rivalChannel);
    await rival.awaitLeadership();

    initTabCoordinator({ type: 'simulate' });
    await flush(150);
    expect(isLeaderTab()).toBe(false);

    // The rival tab closes → this tab is promoted.
    await rival.die();
    await rivalChannel.close();
    await vi.waitFor(
      () => {
        expect(isLeaderTab()).toBe(true);
      },
      { timeout: 10_000 },
    );
  }, 15_000);
});

describe('torn-channel failure arms', () => {
  it('a pagehide announces bye; a rejecting channel is swallowed on every post path', async () => {
    initTabCoordinator({ type: 'simulate' });
    const peer = makePeerChannel();
    const byes: AnyMsg[] = [];
    peer.onmessage = (m) => {
      if (m.kind === 'bye') byes.push(m);
    };
    try {
      // Happy path: leaving the page announces the departure.
      window.dispatchEvent(new Event('pagehide'));
      await vi.waitFor(() => {
        expect(byes.length).toBe(1);
      });

      // Torn channel: every post path must swallow the rejection —
      // coordination degrades to the staleness TTL, never a crash.
      const ch = getTabChannelForTests() as { postMessage: (m: unknown) => Promise<void> };
      const spy = vi.spyOn(ch, 'postMessage').mockRejectedValue(new Error('channel torn'));
      setTabActiveParent('ch-torn'); // postState catch arm
      window.dispatchEvent(new Event('pagehide')); // bye catch arm
      await flush();
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    } finally {
      await peer.close();
    }
  });
});

describe('remote-state staleness', () => {
  it('prunes tabs whose snapshots went stale (crashed/never said bye)', async () => {
    initTabCoordinator({ type: 'simulate' });
    const peer = makePeerChannel();
    try {
      await peer.postMessage({
        kind: 'state',
        tabId: 'peer-stale',
        state: { visible: true, lastActivityAt: Date.now(), activeParent: 'ch-1' },
      });
      await vi.waitFor(() => {
        expect(hasOtherTabs()).toBe(true);
      });
      // The peer goes silent past the staleness TTL (a crashed tab never
      // posts "bye"): time-travel past the cutoff.
      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.now() + 61_000);
        // The stale snapshot must count for NOTHING: not as a sibling, not
        // as viewing, not as at-device.
        expect(remoteTabViewing('ch-1', 24 * 60 * 60_000)).toBe(false);
        expect(remoteUserAtDevice(24 * 60 * 60_000)).toBe(false);
        expect(hasOtherTabs()).toBe(false); // prunes the entry
      } finally {
        vi.useRealTimers();
      }
    } finally {
      await peer.close();
    }
  });
});

describe('edge arms', () => {
  it('ignores a message that echoes its own tabId', async () => {
    initTabCoordinator({ type: 'simulate' });
    const peer = makePeerChannel();
    const captured: AnyMsg[] = [];
    peer.onmessage = (m) => {
      captured.push(m);
    };
    try {
      setTabActiveParent('ch-echo'); // makes the module reveal its tabId
      await vi.waitFor(() => {
        expect(captured.length).toBeGreaterThan(0);
      });
      const selfId = captured[0].tabId;
      // A malicious/buggy sibling echoing OUR tabId must not poison the
      // remote map with a phantom self-entry.
      await peer.postMessage({
        kind: 'state',
        tabId: selfId,
        state: { visible: true, lastActivityAt: Date.now(), activeParent: 'ch-echo' },
      });
      await flush();
      expect(hasOtherTabs()).toBe(false);
    } finally {
      await peer.close();
    }
  });

  it('reset survives an already-torn channel (die/close rejections swallowed)', async () => {
    initTabCoordinator({ type: 'simulate' });
    const ch = getTabChannelForTests() as { close: () => Promise<void> };
    const el = getTabElectorForTests() as { die: () => Promise<void> };
    vi.spyOn(el, 'die').mockRejectedValue(new Error('torn'));
    vi.spyOn(ch, 'close').mockRejectedValue(new Error('torn'));
    await resetTabCoordinatorForTests(); // die() + close() reject — swallowed
    expect(isLeaderTab()).toBe(true); // back to the inert single-tab baseline
  });

  it('reset also survives bc returning undefined from close/die (double-teardown shape)', async () => {
    initTabCoordinator({ type: 'simulate' });
    const ch = getTabChannelForTests() as { close: () => Promise<void> };
    await ch.close(); // first close: bc now returns undefined from the second
    await resetTabCoordinatorForTests();
    expect(isLeaderTab()).toBe(true);
  });
});
