// ws-sender is a tiny singleton that lets any component send a frame
// over the open WebSocket without having to thread the connection
// through React context. The lifecycle is owned by useWebSocket — it
// installs a sender on connect and clears it on close.

type Sender = (frame: string) => void;

let current: Sender | null = null;

// Frames flagged `buffer: true` (e.g. notification acks) must survive a brief
// socket outage: if the socket is down (or the send throws) when they're sent,
// they're queued and flushed on the next (re)connect. Without this, an ack sent
// during a reconnect blip is silently dropped — and `notification.new` is
// ephemeral / non-replayable, so the desktop popup the user already saw would
// fail to cancel the deferred mobile push. Bounded so a long outage can't grow
// the queue without limit (oldest dropped first).
//
// Frames may also carry `maxAgeMs` (SPEC I-13): a frame older than that at
// flush time is DROPPED, not sent. An ack computed while the user was at the
// desk, buffered through a sleep + wake + reconnect, must not cancel a mobile
// push minutes later — by then the phone is the right destination.
interface BufferedFrame {
  frame: string;
  enqueuedAt: number;
  maxAgeMs?: number;
}

const pending: BufferedFrame[] = [];
const MAX_PENDING = 64;

function enqueue(entry: BufferedFrame): void {
  pending.push(entry);
  if (pending.length > MAX_PENDING) pending.shift();
}

// clearWSPending drops any buffered-but-unsent frames. Called when the WS
// hook tears down for good (logout / user switch): a queued ack must never
// survive into a different user's next session on the same page.
export function clearWSPending(): void {
  pending.length = 0;
}

export function setWSSender(s: Sender | null): void {
  current = s;
  if (!s) return;
  // Flush buffered frames oldest-first, dropping expired ones. If the
  // freshly-installed socket dies mid-flush, keep the unsent remainder queued
  // for the next reconnect.
  while (pending.length > 0) {
    const head = pending[0];
    if (head.maxAgeMs !== undefined && Date.now() - head.enqueuedAt > head.maxAgeMs) {
      pending.shift();
      continue;
    }
    try {
      s(head.frame);
      pending.shift();
    } catch {
      break;
    }
  }
}

// sendWS serialises and sends a frame. Pass `{ buffer: true }` for frames that
// must not be lost across a reconnect blip (acks); fire-and-forget ephemera
// (typing pings) omit it and are simply dropped when the socket is down.
// `maxAgeMs` bounds how stale a buffered frame may be at flush time.
export function sendWS(payload: unknown, opts?: { buffer?: boolean; maxAgeMs?: number }): void {
  let frame: string;
  try {
    frame = JSON.stringify(payload);
  } catch {
    // Unserialisable payload — nothing we can do, and buffering it is pointless.
    return;
  }
  if (current) {
    try {
      current(frame);
      return;
    } catch {
      // Socket died between the null-check and the send — fall through so a
      // buffered frame is still queued for the next reconnect.
    }
  }
  if (opts?.buffer) enqueue({ frame, enqueuedAt: Date.now(), maxAgeMs: opts.maxAgeMs });
}
