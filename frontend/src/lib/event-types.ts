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
  AttachmentDeleted: 'attachment.deleted',
  ChannelMuted: 'channel.muted',
  NotificationNew: 'notification.new',
  ForceLogout: 'auth.force_logout',
  ServerVersion: 'server.version',
  Ping: 'ping',
} as const;

export type EventTypeName = (typeof EventType)[keyof typeof EventType];
