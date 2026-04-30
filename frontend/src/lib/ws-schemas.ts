import { z } from 'zod';
import type { Message } from '@/types';

// Zod schemas for WebSocket payloads. Server is trusted, but a missing
// or typo'd field — or a payload of a different event type misrouted
// to the wrong handler — must not silently feed garbage into the cache
// (e.g. an "appendMessageToCache" call with no id would corrupt every
// page's items).
//
// Each schema validates only the fields the handler actually reads;
// extras pass through untouched (default zod object behavior). Use the
// matching `parse*` helper from a handler — it returns the typed value
// or null so the call-site stays a single `if (!parsed) return`.

const messageSchema = z.object({
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
  reactions: z.record(z.string(), z.array(z.string())).optional(),
});

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

// Returns Message-shaped data on success. The result type is the app's
// existing Message interface (not zod's inferred type) so call-sites
// don't have to convert; the schema validates the subset of fields the
// runtime reads.
export const parseMessage = parser(messageSchema) as (v: unknown) => Message | null;

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
