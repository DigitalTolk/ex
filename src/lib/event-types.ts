// Mirror of internal/events/event.go event-name constants. Imported wherever
// we read or dispatch on `msg.type` so a backend rename surfaces as a
// TypeScript error rather than a silent no-op switch case.

export const EventType = {
  MessageNew: 'message.new',
  MessageEdited: 'message.edited',
  MessageDeleted: 'message.deleted',
  MemberJoined: 'member.joined',
  MemberLeft: 'member.left',
  ChannelUpdated: 'channel.updated',
  ConversationNew: 'conversation.new',
  ChannelNew: 'channel.new',
  ChannelArchived: 'channel.archived',
  ChannelRemoved: 'channel.removed',
  MembersChanged: 'members.changed',
  EmojiAdded: 'emoji.added',
  EmojiRemoved: 'emoji.removed',
  PresenceChanged: 'presence.changed',
  UserUpdated: 'user.updated',
  UserChannelUpdated: 'userchannel.updated',
  SidebarUpdated: 'sidebar.updated',
  AttachmentDeleted: 'attachment.deleted',
  ChannelMuted: 'channel.muted',
  NotificationNew: 'notification.new',
  NotificationSettingsUpdated: 'notification.settings_updated',
  DraftUpdated: 'draft.updated',
  ForceLogout: 'auth.force_logout',
  ServerVersion: 'server.version',
  Ping: 'ping',
  ReplayDone: 'replay.done',
  ReplayExhausted: 'replay.exhausted',
  WebhookChanged: 'webhook.changed',
  ActivityNew: 'activity.new',
  ThreadUpdated: 'thread.updated',
} as const;

export type EventTypeName = (typeof EventType)[keyof typeof EventType];

// EPHEMERAL_EVENT_TYPES mirrors the backend `ephemeralTypes` set: events that
// live only on the socket and are NEVER written to the durable inbox, so they
// are never replayed on reconnect. The replay cursor must not advance on these
// — a typing/presence/notification.new frame whose ULID outruns an in-flight
// durable message.new would otherwise push the cursor past that message, and
// the next reconnect (`?since=<cursor>`) would skip replaying it → lost message.
export const EPHEMERAL_EVENT_TYPES = new Set<string>([
  EventType.PresenceChanged,
  EventType.NotificationNew,
  EventType.ServerVersion,
  EventType.Ping,
  EventType.ForceLogout,
  EventType.ReplayDone,
  EventType.ReplayExhausted,
  EventType.ActivityNew,
  EventType.ThreadUpdated,
  'typing',
]);
