// Event names the WebSocket frames carry. The values come from the
// tygo-generated mirror of internal/events/event.go (src/types/generated-events.ts,
// drift-gated by `make check-types-drift`), so a renamed Go constant fails
// `tsc -b` here instead of becoming a silent no-op dispatch, and
// WireEventCoverage below fails the build when Go gains an event this table
// doesn't name.
import * as wire from '@/types/generated-events';

export const EventType = {
  MessageNew: wire.EventMessageNew,
  MessageEdited: wire.EventMessageEdited,
  MessageDeleted: wire.EventMessageDeleted,
  ChannelUpdated: wire.EventChannelUpdated,
  ConversationNew: wire.EventConversationNew,
  ConversationConverted: wire.EventConversationConverted,
  ChannelNew: wire.EventChannelNew,
  ChannelArchived: wire.EventChannelArchived,
  ChannelUnarchived: wire.EventChannelUnarchived,
  ChannelRemoved: wire.EventChannelRemoved,
  MembersChanged: wire.EventMembersChanged,
  EmojiAdded: wire.EventEmojiAdded,
  EmojiRemoved: wire.EventEmojiRemoved,
  PresenceChanged: wire.EventPresenceChanged,
  UserUpdated: wire.EventUserUpdated,
  UserChannelUpdated: wire.EventUserChannelUpdated,
  SidebarUpdated: wire.EventSidebarUpdated,
  AttachmentDeleted: wire.EventAttachmentDeleted,
  ChannelMuted: wire.EventChannelMuted,
  NotificationNew: wire.EventNotificationNew,
  NotificationSettingsUpdated: wire.EventNotificationSettingsUpdated,
  DraftUpdated: wire.EventDraftUpdated,
  ForceLogout: wire.EventForceLogout,
  ServerVersion: wire.EventServerVersion,
  Typing: wire.EventTyping,
  Ping: wire.EventPing,
  ReplayDone: wire.EventReplayDone,
  ReplayExhausted: wire.EventReplayExhausted,
  SessionRenewed: wire.EventSessionRenewed,
  WebhookChanged: wire.EventWebhookChanged,
  ProjectChanged: wire.EventProjectChanged,
  SettingsUpdated: wire.EventSettingsUpdated,
  RunnersChanged: wire.EventRunnersChanged,
  ActivityNew: wire.EventActivityNew,
  ActivityRead: wire.EventActivityRead,
  ScheduledMessagesChanged: wire.EventScheduledMessagesChanged,
  RemindersChanged: wire.EventRemindersChanged,
  ThreadUpdated: wire.EventThreadUpdated,
  RunUpdated: wire.EventRunUpdated,
  RunProgress: wire.EventRunProgress,
  RunApproval: wire.EventRunApproval,
} as const;

export type EventTypeName = (typeof EventType)[keyof typeof EventType];

// Server-internal control frames (the broker's per-user subscribe/unsubscribe):
// Go declares them beside the client events, but they never reach a socket.
export const SERVER_INTERNAL_EVENT_TYPES = [wire.EventBrokerSubscribe, wire.EventBrokerUnsubscribe] as const;

// Every event-name constant Go declares.
type WireEventType = (typeof wire)[Extract<keyof typeof wire, `Event${string}`>];
type UnmappedWireEvent = Exclude<WireEventType, EventTypeName | (typeof SERVER_INTERNAL_EVENT_TYPES)[number]>;
type AssertNever<T extends never> = T;
// Fails `tsc -b` (naming the event) when Go has an event EventType lacks.
export type WireEventCoverage = AssertNever<UnmappedWireEvent>;

// EPHEMERAL_EVENT_TYPES mirrors the backend `ephemeralTypes` set: events that
// live only on the socket and are NEVER written to the durable inbox, so they
// are never replayed on reconnect. The replay cursor must not advance on these
// — a typing/presence/notification.new frame whose ULID outruns an in-flight
// durable message.new would otherwise push the cursor past that message, and
// the next reconnect (`?since=<cursor>`) would skip replaying it → lost message.
// internal/events writes the Go set to src/test/wire-fixtures/
// ephemeral_event_types.json, and event-types.test.ts holds this one to it.
export const EPHEMERAL_EVENT_TYPES: ReadonlySet<string> = new Set<EventTypeName>([
  EventType.PresenceChanged,
  EventType.NotificationNew,
  EventType.ServerVersion,
  EventType.Ping,
  EventType.ForceLogout,
  EventType.ReplayDone,
  EventType.ReplayExhausted,
  EventType.SessionRenewed,
  EventType.ActivityNew,
  EventType.ActivityRead,
  EventType.ScheduledMessagesChanged,
  EventType.RemindersChanged,
  EventType.ThreadUpdated,
  EventType.RunProgress,
  EventType.Typing,
]);
