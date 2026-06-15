export interface User {
  id: string;
  email: string;
  displayName: string;
  avatarURL?: string;
  systemRole: 'admin' | 'member' | 'guest';
  authProvider?: 'oidc' | 'guest';
  emojiSkinTone?: '' | 'light' | 'medium_light' | 'medium' | 'medium_dark' | 'dark';
  userStatus?: UserStatus;
  timeZone?: string;
  status: string;
  online?: boolean;
  lastSeenAt?: string;
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
  createdAt: string;
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
  muted?: boolean;
  favorite?: boolean;
  categoryID?: string;
  sidebarPosition?: number;
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
}

export interface PresenceEvent {
  userID: string;
  online: boolean;
}

export interface UserState {
  channelNotifications: string[];
  threadNotifications: string[];
  threadSeen: Record<string, string>;
  hiddenConversations: string[];
}
