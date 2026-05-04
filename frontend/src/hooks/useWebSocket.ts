import { useEffect, useRef } from 'react';
import { getAccessToken, refreshAccessToken } from '@/lib/api';
import { EventType } from '@/lib/event-types';
import { setWSSender } from '@/lib/ws-sender';
import { useLatestRef } from '@/hooks/useLatestRef';

type WSCallback = (data: unknown) => void;

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
  onDraftUpdated?: WSCallback;
  onForceLogout?: WSCallback;
  onServerVersion?: WSCallback;
  onPing?: WSCallback;
  onTyping?: WSCallback;
  // Fires when the socket re-opens after a previous failure. The
  // initial connection does NOT trigger this — only true reconnects.
  // With auto-refetch disabled on infinite message queries, this is
  // the hook for catching up on events missed during the disconnect.
  onReconnect?: () => void;
  enabled?: boolean;
}

export function useWebSocket(options: UseWebSocketOptions) {
  const callbacksRef = useLatestRef(options);
  const enabledRef = useLatestRef(options.enabled);
  const wsRef = useRef<WebSocket | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!options.enabled) return;
    let disposed = false;

    async function connect(refreshBeforeConnect = false) {
      let token = getAccessToken();
      if (!token) return;
      if (refreshBeforeConnect) {
        token = await refreshAccessToken();
        if (!token || disposed || !enabledRef.current) return;
      }

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${window.location.host}/api/v1/ws?token=${encodeURIComponent(token)}`;
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
        try {
          const msg = JSON.parse(event.data);
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
            case EventType.DraftUpdated:
              callbacksRef.current.onDraftUpdated?.(payload);
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
            case 'typing':
              callbacksRef.current.onTyping?.(payload);
              break;
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        setWSSender(null);
        if (disposed || !enabledRef.current) return;
        const backoff = Math.min(1000 * Math.pow(2, retryCountRef.current), 30000);
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
