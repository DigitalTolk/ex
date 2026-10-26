import { vi, expect } from 'vitest';
import type { EventTypeName } from '@/lib/event-types';
import {
  dispatchWSEvent,
  wsEventSchemas,
  type AppEventType,
  type WSEventHandlers,
  type WSEventPayloads,
  type WSInvalidPayloadFallbacks,
} from '@/lib/ws-events';

// What a component hands useWebSocket, as a mocked useWebSocket captures it.
export interface CapturedWSOptions {
  handlers: WSEventHandlers;
  invalidPayloadFallbacks?: WSInvalidPayloadFallbacks;
  onReconnect?: () => void;
  onReplayExhausted?: () => void;
  enabled?: boolean;
}

// deliverFrame runs a frame's payload through the real registry — its schema,
// then the captured handler — exactly as useWebSocket does for a live frame.
export function deliverFrame(opts: CapturedWSOptions, type: string, payload: unknown): void {
  dispatchWSEvent(type, payload, opts.handlers, opts.invalidPayloadFallbacks);
}

const INVALID_PAYLOAD = /^ws: dropped a (\S+) frame whose payload failed validation$/;

// deliverMalformedFrame delivers a payload that must FAIL its schema, and
// asserts the failure was reported loudly (console.error) rather than
// dropped quietly.
export function deliverMalformedFrame(opts: CapturedWSOptions, type: string, payload: unknown): void {
  expectInvalidPayloadReported(type, () => deliverFrame(opts, type, payload));
}

// expectInvalidPayloadReported runs `fn` and asserts it reported exactly the
// given invalid payloads (one entry per frame, in order) on console.error.
export function expectInvalidPayloadReported(types: string | string[], fn: () => void): void {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    fn();
    const reported = error.mock.calls
      .map((args) => (typeof args[0] === 'string' ? INVALID_PAYLOAD.exec(args[0])?.[1] : undefined))
      .filter(Boolean);
    expect(reported).toEqual(Array.isArray(types) ? types : [types]);
  } finally {
    error.mockRestore();
  }
}

// wsHandlers fills every event the test doesn't care about with null.
export function wsHandlers(handlers: Partial<{ [K in AppEventType]: (payload: WSEventPayloads[K]) => void }> = {}): WSEventHandlers {
  const all = Object.fromEntries(Object.keys(wsEventSchemas).map((type) => [type, null])) as Record<
    EventTypeName,
    null
  >;
  return { ...all, ...handlers } as WSEventHandlers;
}

// A minimal message payload that passes the message.new / message.edited
// schema.
export function wireMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'm-1',
    parentID: 'ch-1',
    authorID: 'u-2',
    body: 'hi',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// The per-event callback names the app's handlers were known by before the
// registry, kept as a test vocabulary: `onMessageNew(payload)` reads better in
// a test than `deliverFrame(opts, 'message.new', payload)`.
export const CALLBACK_EVENTS = {
  onMessageNew: 'message.new',
  onMessageEdited: 'message.edited',
  onMessageDeleted: 'message.deleted',
  onMembersChanged: 'members.changed',
  onConversationNew: 'conversation.new',
  onConversationConverted: 'conversation.converted',
  onChannelArchived: 'channel.archived',
  onChannelUnarchived: 'channel.unarchived',
  onChannelUpdated: 'channel.updated',
  onChannelNew: 'channel.new',
  onChannelRemoved: 'channel.removed',
  onPresenceChanged: 'presence.changed',
  onEmojiAdded: 'emoji.added',
  onEmojiRemoved: 'emoji.removed',
  onUserUpdated: 'user.updated',
  onUserChannelUpdated: 'userchannel.updated',
  onSidebarUpdated: 'sidebar.updated',
  onAttachmentDeleted: 'attachment.deleted',
  onChannelMuted: 'channel.muted',
  onNotification: 'notification.new',
  onNotificationSettingsUpdated: 'notification.settings_updated',
  onDraftUpdated: 'draft.updated',
  onWebhookChanged: 'webhook.changed',
  onProjectChanged: 'project.changed',
  onSettingsUpdated: 'settings.updated',
  onRunnersChanged: 'runners.changed',
  onActivityNew: 'activity.new',
  onScheduledMessagesChanged: 'scheduled_messages.changed',
  onRemindersChanged: 'reminders.changed',
  onActivityRead: 'activity.read',
  onThreadUpdated: 'thread.updated',
  onForceLogout: 'auth.force_logout',
  onServerVersion: 'server.version',
  onPing: 'ping',
  onTyping: 'typing',
  onRunUpdated: 'run.updated',
  onRunProgress: 'run.progress',
  onRunApproval: 'run.approval',
} as const satisfies Record<string, AppEventType>;

export type CallbackName = keyof typeof CALLBACK_EVENTS;
export type EventCallbacks = CapturedWSOptions & Partial<Record<CallbackName, (data?: unknown) => void>>;

// eventCallbacks views captured useWebSocket options as one callback per
// handled event, each delivering its payload through the real registry
// (schema, then handler). An event whose handler is null has no callback.
export function eventCallbacks(opts: CapturedWSOptions): EventCallbacks {
  const view: EventCallbacks = { ...opts };
  for (const [name, type] of Object.entries(CALLBACK_EVENTS) as [CallbackName, AppEventType][]) {
    if (opts.handlers[type]) view[name] = (data?: unknown) => deliverFrame(opts, type, data);
  }
  return view;
}

// withHandlers builds useWebSocket options from per-event callbacks, for
// tests that drive the real hook.
export function withHandlers(
  options: Partial<Record<CallbackName, (data: never) => void>> & Omit<CapturedWSOptions, 'handlers'>,
): CapturedWSOptions {
  const handlers: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (key in CALLBACK_EVENTS) handlers[CALLBACK_EVENTS[key as CallbackName]] = value;
    else rest[key] = value;
  }
  return { ...(rest as Omit<CapturedWSOptions, 'handlers'>), handlers: wsHandlers(handlers as never) };
}

// payloadParser runs one event's registered schema on its own: the parsed
// payload, or null when it doesn't validate.
export function payloadParser<K extends EventTypeName>(type: K): (payload: unknown) => WSEventPayloads[K] | null {
  return (payload) => {
    const parsed = wsEventSchemas[type].safeParse(payload);
    return parsed.success ? (parsed.data as WSEventPayloads[K]) : null;
  };
}

// The per-event parsers the schemas were once exported as.
export const parseMessage = payloadParser('message.new');
export const parseMessageDeleted = payloadParser('message.deleted');
export const parseChannelID = payloadParser('channel.updated');
export const parseMembersChanged = payloadParser('members.changed');
export const parsePresence = payloadParser('presence.changed');
export const parseAttachmentDeleted = payloadParser('attachment.deleted');
export const parseTyping = payloadParser('typing');
export const parseServerVersion = payloadParser('server.version');
export const parseUserUpdated = payloadParser('user.updated');
export const parseThreadUpdated = payloadParser('thread.updated');
export const parseUserChannelUpdated = payloadParser('userchannel.updated');
export const parseNotification = payloadParser('notification.new');
