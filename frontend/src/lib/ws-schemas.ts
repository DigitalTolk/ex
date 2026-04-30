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

const channelIDSchema = z.object({ channelID: z.string().min(1) });
const presenceSchema = z.object({ userID: z.string().min(1), online: z.boolean() });
const attachmentDeletedSchema = z.object({ id: z.string().min(1) });
const typingSchema = z.object({ userID: z.string().min(1), parentID: z.string().min(1) });
const serverVersionSchema = z.object({ version: z.string().min(1) });

function parser<T>(schema: z.ZodType<T>): (v: unknown) => T | null {
  return (v: unknown) => {
    const result = schema.safeParse(v);
    return result.success ? result.data : null;
  };
}

export const parseMessage = parser(messageSchema);

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
}
export const parseTyping = parser(typingSchema);

export interface ServerVersionPayload {
  version: string;
}
export const parseServerVersion = parser(serverVersionSchema);
