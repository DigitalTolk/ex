import { useEffect, useRef } from 'react';
import { getAccessToken, refreshAccessToken } from '@/lib/api';
import { EventType, EPHEMERAL_EVENT_TYPES } from '@/lib/event-types';
import { setWSSender } from '@/lib/ws-sender';
import { useLatestRef } from '@/hooks/useLatestRef';

type WSCallback = (data: unknown) => void;

const reconnectDelayStepsMs = [1000, 2000, 4000, 8000, 16000, 30000];
const reconnectAttemptsPerStep = 3;

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
  onAttachmentDeleted?: WSCallback;
  onChannelMuted?: WSCallback;
  onNotification?: WSCallback;
  onNotificationSettingsUpdated?: WSCallback;
  onDraftUpdated?: WSCallback;
  onWebhookChanged?: WSCallback;
  onForceLogout?: WSCallback;
  onServerVersion?: WSCallback;
  onPing?: WSCallback;
  onTyping?: WSCallback;
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
  // Cursor for replay-on-reconnect. Updated on every event that
  // carries an `id` field — both live and replay use the same ULID,
  // so any frame moves the cursor forward.
  const lastEventIdRef = useRef<string>('');
  // Bounded FIFO of recently delivered event IDs for dedup. Insertion
  // order = arrival order; on overflow we drop the oldest. A Set is
  // O(1) for has/add/delete which is what we need.
  const seenIdsRef = useRef<Set<string>>(new Set());
  const seenOrderRef = useRef<string[]>([]);

  useEffect(() => {
    if (!options.enabled) return;
    let disposed = false;

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
        if (oldest) seenIdsRef.current.delete(oldest);
      }
    }

    async function connect(refreshBeforeConnect = false) {
      let token = getAccessToken();
      if (!token) return;
      if (refreshBeforeConnect) {
        token = await refreshAccessToken();
        if (!token || disposed || !enabledRef.current) return;
      }

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const since = lastEventIdRef.current;
      const sinceParam = since ? `&since=${encodeURIComponent(since)}` : '';
      const url = `${proto}//${window.location.host}/api/v1/ws?token=${encodeURIComponent(token)}${sinceParam}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        const reconnected = retryCountRef.current > 0;
        retryCountRef.current = 0;
        // Expose the live socket's send to other components (typing
        // indicator and similar ephemera) without prop-drilling.
        setWSSender((frame) => ws.send(frame));
        if (reconnected) callbacksRef.current.onReconnect?.();
      };

      ws.onmessage = (event) => {
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
        const delayStep = Math.floor(retryCountRef.current / reconnectAttemptsPerStep);
        const backoff = reconnectDelayStepsMs[Math.min(delayStep, reconnectDelayStepsMs.length - 1)];
        retryCountRef.current++;
        retryTimerRef.current = setTimeout(() => {
          void connect(true);
        }, backoff);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    void connect();

    return () => {
      disposed = true;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setWSSender(null);
    };
  }, [options.enabled, callbacksRef, enabledRef]);
}
