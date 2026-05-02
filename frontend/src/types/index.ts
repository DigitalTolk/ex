export interface User {
  id: string;
  email: string;
  displayName: string;
  avatarURL?: string;
  systemRole: 'admin' | 'member' | 'guest';
  authProvider?: 'oidc' | 'guest';
  status: string;
  online?: boolean;
  lastSeenAt?: string;
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
}

export interface Attachment {
  id: string;
  sha256: string;
  size: number;
  contentType: string;
  filename: string;
  url?: string; // resolved presigned GET URL — inline (used by <img>/preview)
  downloadURL?: string; // presigned GET URL with forced Content-Disposition: attachment
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

export interface UserChannel {
  channelID: string;
  channelName: string;
  channelType: 'public' | 'private';
  role: number;
  lastReadMsgID?: string;
  muted?: boolean;
  favorite?: boolean;
  categoryID?: string;
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
  lastReadMsgID?: string;
  favorite?: boolean;
  categoryID?: string;
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
