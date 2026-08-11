import { describe, it, expect } from 'vitest';
import {
  attentionWindowMs,
  clockJumpMs,
  suppressionWindowMs,
  wakeProbeIntervalMs,
} from '@/lib/user-activity';
import { ackFreshnessMs } from '@/context/NotificationContext';
import { idleDetectorThresholdMs } from '@/lib/idle-detector';

// SPEC I-11 timing lattice. The backend halves are pinned by
// TestAckFallbackDelayInvariants (internal/service/notification_test.go);
// these are mirrors of the Go constants — update BOTH sides together.
const backendAckFallbackDelayMs = 30_000; // internal/service/notification.go ackFallbackDelay
const backendNotifAckTTLMs = 5 * 60_000; // internal/cache/redis.go notifAckTTL

describe('attention timing lattice (SPEC I-11)', () => {
  it('suppression demands fresher proof than acking', () => {
    expect(suppressionWindowMs).toBeLessThanOrEqual(attentionWindowMs);
  });

  it('a buffered ack expires before the deferred mobile push fires', () => {
    // If an ack could flush later than the fallback delay, a stale ack would
    // race (and cancel) a push that already delivered — or worse, one that
    // is about to. Staying under the delay keeps the ordering unambiguous.
    expect(ackFreshnessMs).toBeLessThan(backendAckFallbackDelayMs);
  });

  it('backend lattice mirror stays coherent', () => {
    expect(backendAckFallbackDelayMs).toBeLessThan(backendNotifAckTTLMs);
  });

  it('the wake probe cannot false-positive on its own cadence', () => {
    // A jump is only declared when the gap exceeds interval + clockJumpMs, so
    // the threshold must comfortably exceed ordinary tick jitter.
    expect(clockJumpMs).toBeGreaterThan(wakeProbeIntervalMs);
  });

  it('the browser idle threshold matches the shell posture (60s, Mattermost value)', () => {
    expect(idleDetectorThresholdMs).toBe(60_000);
  });
});
