import { z } from 'zod';
import type { Message } from '@/types';

// Zod schemas for WebSocket payloads. A misrouted event or missing
// field must not silently feed garbage into the cache (e.g. an
// appendMessageToCache call with no id would corrupt every page's
// items). Each schema validates the fields the handler reads; extras
// (avatars, attachments, reactions) pass through untouched via zod's
// default `passthrough` behavior so cache-stored messages keep them.

// `reactions` and similar map/array fields aren't validated in detail —
// they pass through, and downstream consumers handle their own shape.
const messageSchema: z.ZodType<Message> = z.object({
  id: z.string().min(1),
  parentID: z.string().min(1),
  parentType: z.enum(['channel', 'conversation']).optional(),
  authorID: z.string().min(1),
  body: z.string(),
  createdAt: z.string().min(1),
  parentMessageID: z.string().optional(),
  replyCount: z.number().optional(),
  recentReplyAuthorIDs: z.array(z.string()).optional(),
  lastReplyAt: z.string().optional(),
  pinned: z.boolean().optional(),
  noUnfurl: z.boolean().optional(),
}).passthrough() as z.ZodType<Message>;

const messageDeletedSchema = z.object({
  id: z.string().min(1),
  parentID: z.string().min(1),
  parentMessageID: z.string().min(1).optional(),
}).passthrough();

const channelIDSchema = z.object({ channelID: z.string().min(1) });
const presenceSchema = z.object({ userID: z.string().min(1), online: z.boolean() });
const attachmentDeletedSchema = z.object({ id: z.string().min(1) });
// `parentMessageID` is set only when the typing happened inside a thread
// reply composer; absent for ordinary channel/DM typing. Both shapes
// share a topic on the wire — the receiver routes by presence/absence.
const typingSchema = z.object({
  userID: z.string().min(1),
  parentID: z.string().min(1),
  parentMessageID: z.string().min(1).optional(),
});
const serverVersionSchema = z.object({ version: z.string().min(1) });
const userUpdatedSchema = z.object({
  id: z.string().min(1),
  // userStatus is an arbitrary object or explicit null (cleared); validate it's
  // present-or-null without over-constraining the nested shape.
  userStatus: z.unknown().optional(),
  timeZone: z.string().optional(),
  lastSeenAt: z.string().optional(),
});

// thread.updated carries a full ThreadSummary so the client can add/patch the
// /threads row without a refetch. The server only sends it to participants, so
// receipt itself is the participation signal — the handler patches unconditionally.
const threadUpdatedSchema = z.object({
  parentID: z.string().min(1),
  parentType: z.enum(['channel', 'conversation']),
  threadRootID: z.string().min(1),
  rootAuthorID: z.string().min(1),
  rootBody: z.string(),
  rootCreatedAt: z.string().min(1),
  replyCount: z.number(),
  latestActivityAt: z.string().min(1),
}).passthrough();

function parser<T>(schema: z.ZodType<T>): (v: unknown) => T | null {
  return (v: unknown) => {
    const result = schema.safeParse(v);
    return result.success ? result.data : null;
  };
}

export const parseMessage = parser(messageSchema);

export type MessageDeletedPayload = z.infer<typeof messageDeletedSchema>;
export const parseMessageDeleted = parser(messageDeletedSchema);

export interface ChannelIDPayload {
  channelID: string;
}
export const parseChannelID = parser(channelIDSchema);
export const parseMembersChanged = parseChannelID;

export interface PresencePayload {
  userID: string;
  online: boolean;
}
export const parsePresence = parser(presenceSchema);

export interface AttachmentDeletedPayload {
  id: string;
}
export const parseAttachmentDeleted = parser(attachmentDeletedSchema);

export interface TypingPayload {
  userID: string;
  parentID: string;
  parentMessageID?: string;
}
export const parseTyping = parser(typingSchema);

export interface ServerVersionPayload {
  version: string;
}
export const parseServerVersion = parser(serverVersionSchema);

export interface UserUpdatedPayload {
  id: string;
  userStatus?: unknown;
  timeZone?: string;
  lastSeenAt?: string;
}
export const parseUserUpdated = parser(userUpdatedSchema);

// `userchannel.updated` multiplexes several per-user sidebar-state changes
// over one event type; the payload KEYS identify which change happened
// (conversation activity touch, mark-read, favorite, category move,
// notification prefs, category CRUD, user-state). Every field is optional
// so each publisher's shape validates; ChatPage dispatches on presence.
const userChannelUpdatedSchema = z.object({
  channelID: z.string().min(1).optional(),
  conversationID: z.string().min(1).optional(),
  updatedAt: z.string().optional(),
  favorite: z.boolean().optional(),
  categoryID: z.string().optional(),
  sidebarPosition: z.number().optional(),
  notificationPrefs: z.unknown().optional(),
  categories: z.boolean().optional(),
  userState: z.boolean().optional(),
}).passthrough();

export interface UserChannelUpdatedPayload {
  channelID?: string;
  conversationID?: string;
  updatedAt?: string;
  favorite?: boolean;
  categoryID?: string;
  sidebarPosition?: number;
  notificationPrefs?: unknown;
  categories?: boolean;
  userState?: boolean;
}
export const parseUserChannelUpdated = parser(userChannelUpdatedSchema) as (
  v: unknown,
) => UserChannelUpdatedPayload | null;

export interface ThreadUpdatedPayload {
  parentID: string;
  parentType: 'channel' | 'conversation';
  threadRootID: string;
  rootAuthorID: string;
  rootBody: string;
  rootCreatedAt: string;
  replyCount: number;
  latestActivityAt: string;
}
export const parseThreadUpdated = parser(threadUpdatedSchema) as (v: unknown) => ThreadUpdatedPayload | null;
