import { useEffect, useRef } from 'react';
import { ExponentialBackoff } from 'cockatiel';
import { apiFetch, getAccessToken } from '@/lib/api';
import { EventType, EPHEMERAL_EVENT_TYPES } from '@/lib/event-types';
import { setWSSender, clearWSPending } from '@/lib/ws-sender';
import { useLatestRef } from '@/hooks/useLatestRef';

type WSCallback = (data: unknown) => void;

// Reconnect backoff (cockatiel): exponential with DECORRELATED JITTER, capped
// at 30s, unbounded attempts. The old fixed ladder (1s×3, 2s×3, …) had zero
// jitter, so a server restart made every client reconnect in synchronized
// waves and then poll in a synchronized 30s lockstep forever — a self-made
// thundering herd on exactly the worst day. Jitter spreads the fleet out.
const reconnectBackoffFactory = new ExponentialBackoff({ initialDelay: 1000, maxDelay: 30_000 });

// Half-open detection window for the wake probe. The server writes an
// app-level ping frame every 15s (internal/handler/ws.go wsKeepAliveInterval),
// so a socket that has produced NO frame for three ping intervals after the
// app comes back to the foreground is dead-but-doesn't-know-it — a mobile
// OS kills background TCP without a close event, so onclose (the only other
// reconnect trigger) never fires.
const staleFrameMs = 45_000;

// Dedup window for replay-vs-live races. On a reconnect the server
// replays missed events from the durable inbox; any event that also
// arrives via the live channel during the cutover would otherwise be
// applied twice. We keep the most recent N event IDs we've delivered
// to a callback and skip duplicates. N=512 covers the worst-case
// burst comfortably without unbounded memory.
const dedupCapacity = 512;

interface UseWebSocketOptions {
  onMessageNew?: WSCallback;
  onMessageEdited?: WSCallback;
  onMessageDeleted?: WSCallback;
  onMembersChanged?: WSCallback;
  onConversationNew?: WSCallback;
  onChannelArchived?: WSCallback;
  onChannelUpdated?: WSCallback;
  onChannelNew?: WSCallback;
  onChannelRemoved?: WSCallback;
  onPresenceChanged?: WSCallback;
  onEmojiAdded?: WSCallback;
  onEmojiRemoved?: WSCallback;
  onUserUpdated?: WSCallback;
  onUserChannelUpdated?: WSCallback;
  onSidebarUpdated?: WSCallback;
  onAttachmentDeleted?: WSCallback;
  onChannelMuted?: WSCallback;
  onNotification?: WSCallback;
  onNotificationSettingsUpdated?: WSCallback;
  onDraftUpdated?: WSCallback;
  onWebhookChanged?: WSCallback;
  onActivityNew?: WSCallback;
  onActivityRead?: WSCallback;
  onThreadUpdated?: WSCallback;
  onForceLogout?: WSCallback;
  onServerVersion?: WSCallback;
  onPing?: WSCallback;
  onTyping?: WSCallback;
  onRunUpdated?: WSCallback;
  onRunProgress?: WSCallback;
  onRunApproval?: WSCallback;
  // Fires when the socket re-opens after a previous failure. The
  // initial connection does NOT trigger this — only true reconnects.
  // With auto-refetch disabled on infinite message queries, this is
  // the hook for catching up on events missed during the disconnect.
  onReconnect?: () => void;
  // Fires when the server reports our replay cursor is too old —
  // every event since then has been trimmed from the inbox. Caller
  // should do a full refetch of anything that could be stale.
  onReplayExhausted?: () => void;
  enabled?: boolean;
}

export function useWebSocket(options: UseWebSocketOptions) {
  const callbacksRef = useLatestRef(options);
  const enabledRef = useLatestRef(options.enabled);
  const wsRef = useRef<WebSocket | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Current position on the jittered backoff curve; null = start over.
  const backoffRef = useRef<ReturnType<typeof reconnectBackoffFactory.next> | null>(null);
  // Cursor for replay-on-reconnect. Updated on every event that
  // carries an `id` field — both live and replay use the same ULID,
  // so any frame moves the cursor forward.
  const lastEventIdRef = useRef<string>('');
  // Bounded FIFO of recently delivered event IDs for dedup. Insertion
  // order = arrival order; on overflow we drop the oldest. A Set is
  // O(1) for has/add/delete which is what we need.
  const seenIdsRef = useRef<Set<string>>(new Set());
  const seenOrderRef = useRef<string[]>([]);

  // Arrival time of the most recent frame (any type — the server's 15s
  // app-ping counts), for the wake probe's half-open check.
  const lastFrameAtRef = useRef(0);

  useEffect(() => {
    if (!options.enabled) return;
    let disposed = false;
    // connect() awaits a token refresh before opening the socket, so two wake
    // events in quick succession could otherwise race two parallel connects.
    let connectInFlight = false;

    // recordSeen marks an id as delivered AFTER its handler ran, so a replay/live
    // duplicate is dropped by the peek (seenIdsRef.has) at the top of onmessage.
    // Bounded ring of the last `dedupCapacity` ids. The caller guards a non-empty,
    // not-yet-seen id, so this just appends.
    function recordSeen(id: string) {
      seenIdsRef.current.add(id);
      seenOrderRef.current.push(id);
      if (seenOrderRef.current.length > dedupCapacity) {
        const oldest = seenOrderRef.current.shift();
        /* v8 ignore next -- length just exceeded dedupCapacity, so shift() always returns a string; the falsy arm is defensive */
        /* istanbul ignore next -- length just exceeded dedupCapacity, so shift() always returns a string; the falsy arm is defensive */
        if (oldest) seenIdsRef.current.delete(oldest);
      }
    }

    // Books the next reconnect attempt on the jittered backoff curve. Used by
    // both the onclose path and a failed pre-connect ticket mint.
    function scheduleReconnect() {
      backoffRef.current = backoffRef.current
        ? backoffRef.current.next(undefined)
        : reconnectBackoffFactory.next();
      retryCountRef.current++;
      retryTimerRef.current = setTimeout(() => {
        void connect();
      }, backoffRef.current.duration);
    }

    async function connect() {
      if (connectInFlight) return;
      connectInFlight = true;
      let ticket: string | null;
      // The finally is the ONLY release of connectInFlight — every early
      // return and the mint await funnel through it. Everything after this
      // block is synchronous, so releasing the flag before the socket is
      // constructed cannot race a second connect.
      try {
        if (!getAccessToken()) return;
        // Mint a one-time upgrade ticket: the access JWT itself never rides
        // the WS URL (it used to leak into LB/proxy logs and browser
        // history). apiFetch handles the 401→refresh→retry dance, and a
        // TERMINAL auth rejection fires the global auth-invalid logout —
        // the old flow silently stalled here with a dead socket and no
        // logout until an unrelated request happened to 401.
        try {
          const res = await apiFetch<{ ticket: string }>('/api/v1/ws/ticket', { method: 'POST' });
          ticket = res?.ticket ?? null;
        } catch {
          // Network-level failure (offline, server restarting) — retry on
          // the backoff. If this was a terminal auth rejection, apiFetch
          // already dispatched the logout; `enabled` flips false and tears
          // this effect (and the pending retry) down.
          if (!disposed && enabledRef.current) scheduleReconnect();
          return;
        }
        if (!ticket || disposed || !enabledRef.current) return;
      } finally {
        connectInFlight = false;
      }

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const since = lastEventIdRef.current;
      const sinceParam = since ? `&since=${encodeURIComponent(since)}` : '';
      const url = `${proto}//${window.location.host}/api/v1/ws?ticket=${encodeURIComponent(ticket)}${sinceParam}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      lastFrameAtRef.current = Date.now();

      ws.onopen = () => {
        const reconnected = retryCountRef.current > 0;
        retryCountRef.current = 0;
        backoffRef.current = null; // healthy again — restart the curve fresh
        // Expose the live socket's send to other components (typing
        // indicator and similar ephemera) without prop-drilling.
        setWSSender((frame) => ws.send(frame));
        if (reconnected) callbacksRef.current.onReconnect?.();
      };

      ws.onmessage = (event) => {
        lastFrameAtRef.current = Date.now();
        let msg: { id?: unknown; type?: string; data?: unknown };
        try {
          msg = JSON.parse(event.data);
        } catch (err) {
          console.debug('ws message handler skipped a malformed frame', err);
          return;
        }
        // Dedup PEEK only (don't record yet): an already-delivered frame
        // (replay/live race) is dropped without re-running its handler.
        if (typeof msg.id === 'string' && msg.id && seenIdsRef.current.has(msg.id)) {
          return;
        }
        try {
          const payload = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data ?? msg;
          switch (msg.type) {
            case EventType.MessageNew:
              callbacksRef.current.onMessageNew?.(payload);
              break;
            case EventType.MessageEdited:
              callbacksRef.current.onMessageEdited?.(payload);
              break;
            case EventType.MessageDeleted:
              callbacksRef.current.onMessageDeleted?.(payload);
              break;
            case EventType.MembersChanged:
              callbacksRef.current.onMembersChanged?.(payload);
              break;
            case EventType.ConversationNew:
              callbacksRef.current.onConversationNew?.(payload);
              break;
            case EventType.ChannelArchived:
              callbacksRef.current.onChannelArchived?.(payload);
              break;
            case EventType.ChannelUpdated:
              callbacksRef.current.onChannelUpdated?.(payload);
              break;
            case EventType.ChannelNew:
              callbacksRef.current.onChannelNew?.(payload);
              break;
            case EventType.ChannelRemoved:
              callbacksRef.current.onChannelRemoved?.(payload);
              break;
            case EventType.PresenceChanged:
              callbacksRef.current.onPresenceChanged?.(payload);
              break;
            case EventType.EmojiAdded:
              callbacksRef.current.onEmojiAdded?.(payload);
              break;
            case EventType.EmojiRemoved:
              callbacksRef.current.onEmojiRemoved?.(payload);
              break;
            case EventType.UserUpdated:
              callbacksRef.current.onUserUpdated?.(payload);
              break;
            case EventType.UserChannelUpdated:
              callbacksRef.current.onUserChannelUpdated?.(payload);
              break;
            case EventType.SidebarUpdated:
              callbacksRef.current.onSidebarUpdated?.(payload);
              break;
            case EventType.AttachmentDeleted:
              callbacksRef.current.onAttachmentDeleted?.(payload);
              break;
            case EventType.ChannelMuted:
              callbacksRef.current.onChannelMuted?.(payload);
              break;
            case EventType.NotificationNew:
              callbacksRef.current.onNotification?.(payload);
              break;
            case EventType.NotificationSettingsUpdated:
              callbacksRef.current.onNotificationSettingsUpdated?.(payload);
              break;
            case EventType.DraftUpdated:
              callbacksRef.current.onDraftUpdated?.(payload);
              break;
            case EventType.WebhookChanged:
              callbacksRef.current.onWebhookChanged?.(payload);
              break;
            case EventType.ActivityNew:
              callbacksRef.current.onActivityNew?.(payload);
              break;
            case EventType.ActivityRead:
              callbacksRef.current.onActivityRead?.(payload);
              break;
            case EventType.ThreadUpdated:
              callbacksRef.current.onThreadUpdated?.(payload);
              break;
            case EventType.ForceLogout:
              callbacksRef.current.onForceLogout?.(payload);
              break;
            case EventType.ServerVersion:
              callbacksRef.current.onServerVersion?.(payload);
              break;
            case EventType.Ping:
              callbacksRef.current.onPing?.(payload);
              break;
            case EventType.ReplayExhausted:
              // Server couldn't satisfy our cursor — the inbox has
              // been trimmed past it. Drop the cursor so the next
              // reconnect doesn't keep asking for a hopeless window,
              // and let the caller refetch whatever might be stale.
              lastEventIdRef.current = '';
              callbacksRef.current.onReplayExhausted?.();
              break;
            case EventType.ReplayDone:
              // Marker frame, no-op — the replay entries that
              // preceded it advanced the cursor already.
              break;
            case 'typing':
              callbacksRef.current.onTyping?.(payload);
              break;
            case EventType.RunUpdated:
              callbacksRef.current.onRunUpdated?.(payload);
              break;
            case EventType.RunProgress:
              callbacksRef.current.onRunProgress?.(payload);
              break;
            case EventType.RunApproval:
              callbacksRef.current.onRunApproval?.(payload);
              break;
          }
        } catch (err) {
          // The handler threw — do NOT record the id as seen or advance the
          // cursor, so this (possibly durable) frame can still be replayed on the
          // next reconnect and isn't swallowed by dedup. Surface at debug level
          // so a real bug in a cache-patch handler is greppable.
          console.debug('ws message handler skipped a frame', err);
          return;
        }
        // The handler delivered successfully. ONLY NOW commit the dedup record
        // and advance the replay cursor — committing before delivery (the old
        // ordering) let a throwing handler permanently lose a durable event.
        // ULIDs sort lexicographically, so the cursor only moves forward, and
        // only for DURABLE events (an ephemeral frame whose id outruns an
        // in-flight message.new must not skip it on the next reconnect replay).
        if (typeof msg.id === 'string' && msg.id) {
          recordSeen(msg.id);
          if (typeof msg.type === 'string' && !EPHEMERAL_EVENT_TYPES.has(msg.type) && msg.id > lastEventIdRef.current) {
            lastEventIdRef.current = msg.id;
          }
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        setWSSender(null);
        if (disposed || !enabledRef.current) return;
        scheduleReconnect();
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    // Wake probe: onclose+backoff is the only other reconnect trigger, but a
    // mobile OS (or a network change) can kill the socket in the background
    // WITHOUT a close event — the app then resumes with a socket that looks
    // OPEN (or already null) and never reconnects. On every foreground /
    // connectivity signal: reconnect immediately if the socket is gone
    // (skipping any pending backoff), or force-close a half-open one (no
    // frame for staleFrameMs despite the server's 15s app-ping) so the
    // normal onclose → reconnect → replay path takes over.
    function wakeProbe() {
      /* v8 ignore next 2 -- defensive: the wake listeners are removed at dispose and the whole effect tears down when `enabled` flips, so a live probe can only observe disposed=false && enabled=true; kept as belt-and-braces on the notification-critical reconnect path */
      /* istanbul ignore next -- see v8 note above */
      if (disposed || !enabledRef.current) return;
      const ws = wsRef.current;
      if (ws) {
        // The half-open force-close is deferred while hidden: background
        // tabs' timers are throttled and the close→reconnect churn buys
        // nothing until the user can see the tab again.
        if (document.visibilityState === 'hidden') return;
        if (ws.readyState === WebSocket.OPEN && Date.now() - lastFrameAtRef.current > staleFrameMs) {
          ws.close();
        }
        // CONNECTING/CLOSING resolve on their own via onopen/onclose.
        return;
      }
      // Socket GONE: reconnect even while hidden — an `online` event in a
      // background tab used to be ignored, leaving the tab dark until
      // foregrounded (and its notifications with it).
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      void connect();
    }

    const wakeTargets: Array<[EventTarget, string]> = [
      [document, 'visibilitychange'],
      [window, 'focus'],
      [window, 'online'],
      [window, 'pageshow'],
    ];
    for (const [target, event] of wakeTargets) target.addEventListener(event, wakeProbe);

    void connect();

    return () => {
      disposed = true;
      for (const [target, event] of wakeTargets) target.removeEventListener(event, wakeProbe);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setWSSender(null);
      // Drop any buffered frames (queued acks) so they can never flush onto
      // a DIFFERENT user's session after a logout/login on the same page.
      clearWSPending();
    };
  }, [options.enabled, callbacksRef, enabledRef]);
}
