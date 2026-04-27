import { useEffect, useRef } from 'react';
import { getAccessToken } from '@/lib/api';
import { EventType } from '@/lib/event-types';
import { setWSSender } from '@/lib/ws-sender';

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
  onAttachmentDeleted?: WSCallback;
  onChannelMuted?: WSCallback;
  onNotification?: WSCallback;
  onForceLogout?: WSCallback;
  onServerVersion?: WSCallback;
  onTyping?: WSCallback;
  enabled?: boolean;
}

export function useWebSocket(options: UseWebSocketOptions) {
  const callbacksRef = useRef(options);
  const wsRef = useRef<WebSocket | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const enabledRef = useRef(options.enabled);

  useEffect(() => {
    callbacksRef.current = options;
    enabledRef.current = options.enabled;
  });

  useEffect(() => {
    if (!options.enabled) return;

    function connect() {
      const token = getAccessToken();
      if (!token) return;

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${window.location.host}/api/v1/ws?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        retryCountRef.current = 0;
        // Expose the live socket's send to other components (typing
        // indicator and similar ephemera) without prop-drilling.
        setWSSender((frame) => ws.send(frame));
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
            case EventType.AttachmentDeleted:
              callbacksRef.current.onAttachmentDeleted?.(payload);
              break;
            case EventType.ChannelMuted:
              callbacksRef.current.onChannelMuted?.(payload);
              break;
            case EventType.NotificationNew:
              callbacksRef.current.onNotification?.(payload);
              break;
            case EventType.ForceLogout:
              callbacksRef.current.onForceLogout?.(payload);
              break;
            case EventType.ServerVersion:
              callbacksRef.current.onServerVersion?.(payload);
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
        if (!enabledRef.current) return;
        const backoff = Math.min(1000 * Math.pow(2, retryCountRef.current), 30000);
        retryCountRef.current++;
        retryTimerRef.current = setTimeout(connect, backoff);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setWSSender(null);
    };
  }, [options.enabled]);
}
