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
  reactions?: Record<string, string[]>; // emoji -> user IDs
  attachmentIDs?: string[];
  pinned?: boolean;
  pinnedAt?: string;
  pinnedBy?: string;
}

export interface Attachment {
  id: string;
  sha256: string;
  size: number;
  contentType: string;
  filename: string;
  url?: string; // resolved presigned GET URL
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
}

export interface UserChannel {
  channelID: string;
  channelName: string;
  channelType: 'public' | 'private';
  role: number;
  lastReadMsgID?: string;
  muted?: boolean;
}

export interface UserConversation {
  conversationID: string;
  type: 'dm' | 'group';
  displayName: string;
  participantIDs?: string[];
  lastReadMsgID?: string;
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
