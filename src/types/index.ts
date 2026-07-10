export interface User {
  id: string;
  email: string;
  displayName: string;
  avatarURL?: string;
  createdAt?: string;
  updatedAt?: string;
  systemRole: 'admin' | 'member' | 'guest';
  authProvider?: 'oidc' | 'guest';
  emojiSkinTone?: '' | 'light' | 'medium_light' | 'medium' | 'medium_dark' | 'dark';
  userStatus?: UserStatus;
  timeZone?: string;
  status: string;
  online?: boolean;
  lastSeenAt?: string;
  notificationSettings?: NotificationSettings;
}

// NotificationLevel gates which messages fire a sound + popup (desktop) or
// push (mobile). "mentions" covers mentions, DMs and keyword matches.
export type NotificationLevel = 'all' | 'mentions';

// MobileNotificationLevel adds a "default" sentinel meaning "same as desktop".
export type MobileNotificationLevel = 'default' | 'all' | 'mentions';

// NotificationSettings is the account-level baseline every channel inherits.
// Keywords are global. Per-channel overrides live on UserChannel.
export interface NotificationSettings {
  desktopLevel: NotificationLevel;
  mobileLevel: MobileNotificationLevel;
  threadReplies: boolean;
  ignoreGroupMentions: boolean;
  followAllThreads: boolean;
  keywords?: string[];
}

// ChannelNotificationOverride is the per-channel override payload. Each field
// omitted/undefined means "inherit the account default".
export interface ChannelNotificationOverride {
  desktopLevel?: NotificationLevel;
  mobileLevel?: MobileNotificationLevel;
  threadReplies?: boolean;
  ignoreGroupMentions?: boolean;
  followAllThreads?: boolean;
}

export interface UserStatus {
  emoji: string;
  text: string;
  clearAt?: string;
}

export interface Channel {
  id: string;
  name: string;
  slug: string;
  description?: string;
  type: 'public' | 'private';
  createdBy: string;
  archived: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface Message {
  id: string;
  parentID: string;
  parentType?: 'channel' | 'conversation';
  authorID: string;
  body: string;
  system?: boolean;
  createdAt: string;
  editedAt?: string;
  parentMessageID?: string;
  replyCount?: number;
  lastReplyAt?: string;
  recentReplyAuthorIDs?: string[];
  reactions?: Record<string, string[]>; // emoji -> user IDs
  attachmentIDs?: string[];
  pinned?: boolean;
  pinnedAt?: string;
  pinnedBy?: string;
  deleted?: boolean;
  noUnfurl?: boolean;
  // Server-rendered hast tree for `body`. Populated on every read
  // path; missing on legacy messages or when the server's renderer
  // is unwired. Frontend prefers this over re-parsing the markdown
  // source per render.
  rendered?: HastNode;
  webhookUsername?: string;
  webhookAvatarURL?: string;
  webhookIconEmoji?: string;
  messageAttachments?: MessageAttachment[];
}

// HastNode mirrors the server-side hast tree shape. Three node
// variants share one type — root, element, text. Custom domain
// elements use sentinel `tagName: 'ex-mention-user' | 'ex-hashtag'
// | 'ex-giphy' | …` that the renderer's components map maps onto
// the corresponding React component.
export interface HastNode {
  type: 'root' | 'element' | 'text';
  tagName?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  properties?: Record<string, any>;
  children?: HastNode[];
  value?: string;
}

export interface MessageAttachment {
  fallback?: string;
  color?: string;
  pretext?: string;
  text?: string;
  author_name?: string;
  author_link?: string;
  author_icon?: string;
  title?: string;
  title_link?: string;
  fields?: MessageAttachmentField[];
  image_url?: string;
  image_width?: number;
  image_height?: number;
  thumb_url?: string;
  footer?: string;
  footer_icon?: string;
}

export interface MessageAttachmentField {
  title?: string;
  value?: string;
  short?: boolean;
}

export interface MessageDraft {
  id: string;
  userID: string;
  parentID: string;
  parentType: 'channel' | 'conversation';
  parentMessageID?: string;
  body: string;
  attachmentIDs?: string[];
  createdAt: string;
  updatedAt: string;
  // Server-assigned generation token: every accepted write mints a new one,
  // and a save/clear must present the generation it acted on (basisGen) or
  // the server rejects it with 409 + the current state. The client never
  // decides ordering — it only reports events and reconciles.
  gen: string;
}

export interface Attachment {
  id: string;
  sha256: string;
  size: number;
  contentType: string;
  filename: string;
  url?: string; // resolved presigned GET URL — inline (used by <img>/preview)
  downloadURL?: string; // presigned GET URL with forced Content-Disposition: attachment
  thumbnailURL?: string; // 2x WebP preview for single-image message rendering
  squareThumbnailURL?: string; // 2x WebP square preview for compact rows/sidebars
  // Intrinsic pixel dimensions for image attachments. Reported by
  // the browser at upload time and persisted server-side; may be
  // absent on legacy attachments uploaded before this field
  // existed (those backfill on next read). Renderers pass them as
  // width/height attributes on <img> so the layout box is reserved
  // before image decode.
  width?: number;
  height?: number;
  createdBy: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  type: 'dm' | 'group';
  name?: string;
  participantIDs: string[];
  createdBy?: string;
  activated?: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface ChannelMembership {
  channelID: string;
  userID: string;
  role: 'owner' | 'admin' | 'member';
  displayName: string;
  joinedAt: string;
}

export interface WorkspaceSettings {
  maxUploadBytes: number;
  allowedExtensions: string[];
  // Browser key used by the Giphy SDK. Present for authenticated users
  // when the picker is enabled because GIPHY API calls must be made
  // directly from the client, not proxied through this app.
  giphyAPIKey?: string;
  giphyEnabled?: boolean;
}

export interface IncomingWebhook {
  id: string;
  title: string;
  description?: string;
  channelID: string;
  channelName?: string;
  channelSlug?: string;
  lockToChannel: boolean;
  username?: string;
  profileImageURL?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  url?: string;
}

export interface UserChannel {
  channelID: string;
  channelName: string;
  channelType: 'public' | 'private';
  role: number;
  lastReadMsgID?: string;
  // Server-computed unread state (channel.MessageSeq - membership.LastReadSeq).
  // The authoritative source for the sidebar badge on cold load / after
  // reconnect; live message.new events layer a session delta on top.
  unread?: boolean;
  unreadCount?: number;
  // Unread messages that actually ALERTED this user per their notification
  // rules (mentions/keywords/"all messages"; mute suppresses, mention
  // overrides mute). Drives the NUMERIC sidebar badge; plain unread shows
  // only the availability dot. Server-maintained; notification.new events
  // carry the authoritative new value.
  unreadNotifyCount?: number;
  muted?: boolean;
  favorite?: boolean;
  categoryID?: string;
  sidebarPosition?: number;
  // Per-channel notification overrides; undefined = inherit account default.
  desktopLevel?: NotificationLevel;
  mobileLevel?: MobileNotificationLevel;
  threadReplies?: boolean;
  ignoreGroupMentions?: boolean;
  followAllThreads?: boolean;
}

export interface SidebarCategory {
  id: string;
  name: string;
  position: number;
  createdAt?: string;
}

export interface UserConversation {
  conversationID: string;
  type: 'dm' | 'group';
  displayName: string;
  participantIDs?: string[];
  avatarURL?: string;
  userStatus?: UserStatus;
  profileResolved?: boolean;
  lastReadMsgID?: string;
  unread?: boolean;
  // Server-computed exact unread count (Conversation.MessageSeq -
  // UserConversation.LastReadSeq) — same seq model as channels. The sidebar
  // layers the live session delta on top.
  unreadCount?: number;
  // Alerted-unread badge, mirroring UserChannel.unreadNotifyCount (DM
  // messages always alert unless muted).
  unreadNotifyCount?: number;
  favorite?: boolean;
  categoryID?: string;
  sidebarPosition?: number;
  updatedAt?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface CustomEmoji {
  name: string;
  imageURL: string;
  createdBy: string;
  createdAt: string;
  // Pinned into the picker's "Getting Work Done" shelf (set at upload).
  gettingWorkDone?: boolean;
}

export interface PresenceEvent {
  userID: string;
  online: boolean;
}

export interface UserState {
  threadNotifications: string[];
  threadSeen: Record<string, string>;
  hiddenConversations: string[];
}

export type ActivityType = 'reaction' | 'reminder';

export interface ActivityItem {
  id: string;
  type: ActivityType;
  createdAt: string;
  messageID: string;
  parentID: string;
  parentType: 'channel' | 'conversation';
  channelSlug?: string;
  messagePreview?: string;
  // reaction-only
  actorID?: string;
  emoji?: string;
}

export interface ActivityFeed {
  items: ActivityItem[];
  unread: number;
}

export interface Reminder {
  id: string;
  userID: string;
  messageID: string;
  parentID: string;
  parentType: 'channel' | 'conversation';
  channelSlug?: string;
  messagePreview?: string;
  remindAt: string;
  createdAt: string;
}

// ---- Wire-shape drift checks (compile-time only) --------------------------
// The interfaces above are the frontend's hand-written views of the backend
// wire types; src/types/generated.ts is the tygo-generated ground truth from
// internal/model (regenerated by `make types`, drift-gated in `make check`).
// Each entry below asserts a hand-written shape is assignable to its wire
// shape, so a renamed json tag, a new required field, or a changed type in Go
// fails `tsc -b` here — while the richer narrowings (string-literal unions,
// docs) stay hand-written.
import type * as wire from './generated';

type AssertAssignable<T extends U, U> = T;

// Required<> is deliberate: it promotes hand-optional fields before the
// comparison, so a wire-guaranteed field may stay optional here (extra
// guards are harmless and test fixtures need not carry it) while a MISSING
// field, a renamed json tag, or a changed type still fails the build.
// HastNode itself has no entry: its Go side has a custom MarshalJSON that
// tygo cannot model, so the hand-written HastNode IS the wire truth and
// generated.ts imports it.
export type WireDriftChecks = [
  AssertAssignable<Required<User>, wire.User>,
  AssertAssignable<Required<Channel>, wire.Channel>,
  AssertAssignable<Required<Conversation>, wire.Conversation>,
  AssertAssignable<Required<Message>, wire.Message>,
  AssertAssignable<Required<MessageAttachment>, wire.MessageAttachment>,
  AssertAssignable<Required<MessageDraft>, wire.MessageDraft>,
];
