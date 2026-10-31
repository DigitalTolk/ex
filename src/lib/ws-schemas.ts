import { z } from 'zod';
import type { Message, NotificationSettings, UserStatus } from '@/types';
import type * as wire from '@/types/generated';

// Zod schemas for WebSocket payloads, one per event (the registry that maps
// event names to these lives in ./ws-events). A misrouted event or missing
// field must not silently feed garbage into the cache (e.g. an
// appendMessageToCache call with no id would corrupt every page's items).
// Each schema validates the fields its handler reads; extras (avatars,
// attachments, reactions) pass through untouched (z.looseObject) so
// cache-stored messages keep them.
//
// Where Go encodes a payload from a model type, the schema is checked against
// the tygo mirror (src/types/generated.ts) at compile time — WSWireChecks at
// the bottom: a schema may only declare fields the wire type has, each parsing
// to a value the wire allows. Payloads Go builds as ad-hoc maps say so.

const id = z.string().min(1);
const parentType = z.enum(['channel', 'conversation']);

// --- message.new / message.edited / message.deleted (model.Message) -------

// `reactions` and similar map/array fields aren't validated in detail —
// they pass through, and downstream consumers handle their own shape.
const messageObject = z.looseObject({
  id,
  parentID: id,
  parentType: parentType.optional(),
  authorID: id,
  body: z.string(),
  createdAt: id,
  parentMessageID: z.string().optional(),
  replyCount: z.number().optional(),
  recentReplyAuthorIDs: z.array(z.string()).optional(),
  lastReplyAt: z.string().optional(),
  pinned: z.boolean().optional(),
  noUnfurl: z.boolean().optional(),
  system: z.boolean().optional(),
});
// The validated fields above plus the passthrough rest, which is the server's
// encoding of model.Message — so the parsed value IS a Message.
export const messageSchema = messageObject as unknown as z.ZodType<Message>;

export const messageDeletedSchema = z.looseObject({
  id,
  parentID: id,
  parentMessageID: id.optional(),
  // Present on service-published deletes; narrows which cache scope
  // (channel vs conversation) the handlers patch.
  parentType: parentType.optional(),
});

// --- channel / membership events (Go map payloads) -------------------------

// channel.updated, channel.archived/unarchived, channel.removed and
// members.changed all carry the channel they concern.
export const channelIDSchema = z.looseObject({ channelID: id });

// A group message became a private channel (same ID).
export const conversationConvertedSchema = z.looseObject({
  conversationID: id,
  channelID: id,
  slug: id,
});

// --- presence / typing / users -------------------------------------------

// Go map payload.
export const presenceSchema = z.object({ userID: id, online: z.boolean() });

// Go map payload. `parentMessageID` is set only when the typing happened
// inside a thread reply composer; absent for ordinary channel/DM typing. Both
// shapes share a topic on the wire — the receiver routes by presence/absence.
export const typingSchema = z.object({
  userID: id,
  parentID: id,
  parentMessageID: id.optional(),
});

const userStatusSchema: z.ZodType<UserStatus> = z.looseObject({
  emoji: z.string(),
  text: z.string(),
  clearAt: z.string().optional(),
});

// user.updated (a map of model.User fields).
export const userUpdatedSchema = z.object({
  id,
  // Present-or-null: null means the status was cleared.
  userStatus: userStatusSchema.nullable().optional(),
  timeZone: z.string().optional(),
  lastSeenAt: z.string().optional(),
  // Profile saves and directory syncs carry the new name and the resolved
  // avatar URL ("" = none); an admin's (de)activation carries `status`.
  displayName: z.string().optional(),
  avatarURL: z.string().optional(),
  status: z.string().optional(),
  // Directory attributes (MS365 login sync). manager is a small object or
  // explicit null (cleared in the directory); phone "" means cleared.
  phone: z.string().optional(),
  manager: z
    .object({ displayName: z.string(), email: z.string().optional(), userID: z.string().optional() })
    .nullable()
    .optional(),
});
export type UserUpdatedPayload = z.output<typeof userUpdatedSchema>;

// `userchannel.updated` multiplexes several per-user sidebar-state changes
// over one event type; the payload KEYS identify which change happened
// (conversation activity touch, mark-read, favorite, category move,
// notification prefs, category CRUD, user-state). Every field is optional
// so each publisher's shape validates; ChatPage dispatches on presence.
export const userChannelUpdatedSchema = z.looseObject({
  channelID: id.optional(),
  conversationID: id.optional(),
  updatedAt: z.string().optional(),
  favorite: z.boolean().optional(),
  categoryID: z.string().optional(),
  sidebarPosition: z.number().optional(),
  notificationPrefs: z.unknown().optional(),
  categories: z.boolean().optional(),
  userState: z.boolean().optional(),
  // Marked unread (not read) elsewhere — refetch the row.
  unread: z.boolean().optional(),
  // A thread was followed or unfollowed on another tab or device.
  threads: z.boolean().optional(),
});

// --- misc entity events ----------------------------------------------------

// Go map payload.
export const attachmentDeletedSchema = z.object({ id });

// Go map payload.
// session.renewed: the socket's deadline moved out; expiresIn (ms) is how long
// it now lives.
export const sessionRenewedSchema = z.object({ expiresIn: z.number() });

export const serverVersionSchema = z.object({ version: id });

// emoji.added carries the model.CustomEmoji.
export const customEmojiSchema = z.looseObject({
  name: id,
  imageURL: id,
  // Shown nowhere the picker needs them; a missing value isn't worth
  // dropping the emoji over.
  createdBy: z.string().catch(''),
  createdAt: z.string().catch(''),
  gettingWorkDone: z.boolean().optional(),
});
// Go map payload.
export const emojiRemovedSchema = z.object({ name: id });

const notificationSettingsSchema: z.ZodType<NotificationSettings> = z.looseObject({
  desktopLevel: z.enum(['all', 'mentions']),
  mobileLevel: z.enum(['default', 'all', 'mentions']),
  threadReplies: z.boolean(),
  ignoreGroupMentions: z.boolean(),
  followAllThreads: z.boolean(),
  keywords: z.array(z.string()).optional(),
});
// notification.settings_updated (a map carrying model.NotificationSettings).
export const notificationSettingsUpdatedSchema = z.looseObject({ settings: notificationSettingsSchema });

// thread.updated carries a full ThreadSummary (internal/service, not mirrored)
// so the client can add/patch the /threads row without a refetch. The server
// only sends it to participants, so receipt itself is the participation
// signal — the handler patches unconditionally.
export const threadUpdatedSchema = z.looseObject({
  parentID: id,
  parentType,
  threadRootID: id,
  rootAuthorID: id,
  rootBody: z.string(),
  rootCreatedAt: id,
  replyCount: z.number(),
  latestActivityAt: id,
  following: z.boolean().optional(),
});

// --- notification.new (model.Notification) ---------------------------------

// LENIENT on purpose. A notification.new is an alert the backend already
// decided the user must get (CLAUDE.md's delivery contract): a schema that
// rejected it over a field delivery doesn't need would silently drop the
// alert. Only what routing needs is required — kind and parentID; any other
// field that is missing or mistyped falls back to empty/absent instead of
// failing the parse, and unknown fields pass through. A payload that fails
// even this is reported loudly (ws-events).
const lenientString = z.string().catch('');
const optionalString = z.string().optional().catch(undefined);
export const notificationSchema = z.looseObject({
  // Any kind: the backend decides which kinds alert (approval and catchup
  // included); the client never re-gates on it.
  kind: id,
  parentID: z.string(),
  parentType: parentType.catch('channel'),
  title: lenientString,
  body: lenientString,
  deepLink: lenientString,
  createdAt: optionalString,
  messageID: optionalString,
  // Set on alerts that can recur for one message (a fired reminder): replaces
  // messageID as the dedup/ack key. Absent → keyed by messageID.
  alertID: optionalString,
  parentMessageID: optionalString,
  // The author, for own-author echo suppression ("webhook" for webhook posts).
  authorID: optionalString,
  // True for incoming-webhook posts (CI/deploy/alert bots), which are exempt
  // from the own-author echo suppression. Whether to notify at all is the
  // backend's level-gated decision, same as any other message.
  webhook: z.boolean().optional().catch(undefined),
  // Authoritative alerted-unread badge for the parent AFTER this alert
  // (top-level messages only). Clients SET the sidebar row to this value —
  // never increment locally — so duplicate/replayed events can't drift it.
  parentUnreadNotifyCount: z.number().optional().catch(undefined),
});
export type NotificationPayload = z.output<typeof notificationSchema>;

// --- activity (model.ActivityNewEvent / model.ActivityChangedEvent) --------

const activityItemSchema = z.looseObject({
  id,
  type: z.enum(['reaction', 'reminder', 'mention', 'thread_reply', 'dm', 'channel_added', 'channel_message']),
  createdAt: z.string(),
  messageID: z.string(),
  parentID: z.string(),
  parentType,
  parentMessageID: z.string().optional(),
  channelSlug: z.string().optional(),
  messagePreview: z.string().optional(),
  actorID: z.string().optional(),
  actorName: z.string().optional(),
  webhook: z.boolean().optional(),
  emoji: z.string().optional(),
  parentName: z.string().optional(),
  mentionKind: z.enum(['user', 'all', 'here', 'keyword']).optional(),
  read: z.boolean().optional(),
});
export const activityNewSchema = z.looseObject({ item: activityItemSchema });

export const activityChangedSchema = z.looseObject({
  all: z.boolean().optional(),
  ids: z.array(z.string()).optional(),
  read: z.boolean().optional(),
  removed: z.array(z.string()).optional(),
  updated: z.array(z.string()).optional(),
  parentID: z.string().optional(),
  threadRootID: z.string().optional(),
});

// --- agent runs (model.Run / model.Approval) --------------------------------

// run.updated carries the run (the full model.Run to the invoker, a channel
// view of it to the parent's members).
export const runUpdatedSchema = z.looseObject({
  id,
  agentID: id,
  parentID: id,
  state: id,
  invokerID: z.string().optional(),
  threadRootID: z.string().optional(),
});
export type RunUpdatedPayload = z.output<typeof runUpdatedSchema>;

// run.progress: a Go map of the run's routing fields plus a kind-specific
// beat (tool name, text delta).
export const runProgressSchema = z.looseObject({
  runID: id,
  agentID: id,
  parentID: id,
  invokerID: z.string().optional(),
  threadRootID: z.string().optional(),
  kind: z.string().optional(),
  text: z.string().optional(),
  tool: z.string().optional(),
});
export type RunProgressPayload = z.output<typeof runProgressSchema>;

// run.approval: a Go map of the model.Approval (its id as approvalID) plus the
// run's routing fields. Go writes a nil Options slice as null.
export const runApprovalSchema = z.looseObject({
  approvalID: id,
  parentID: id,
  runID: z.string().optional(),
  agentID: z.string().optional(),
  agentName: z.string().optional(),
  invokerID: z.string().optional(),
  parentType: z.string().optional(),
  messageID: z.string().optional(),
  summary: z.string().optional(),
  risk: z.string().optional(),
  kind: z.string().optional(),
  purpose: z.string().optional(),
  options: z.array(z.string()).nullish(),
  state: z.string().optional(),
  deadline: z.string().optional(),
  replyText: z.string().optional(),
  replyToMessageID: z.string().optional(),
});
export type RunApprovalPayload = z.output<typeof runApprovalSchema>;

// The run.approval frame as Go builds it (orchestrator_gates.go).
type RunApprovalWire = Pick<
  wire.Approval,
  | 'runID'
  | 'agentID'
  | 'invokerID'
  | 'summary'
  | 'risk'
  | 'kind'
  | 'purpose'
  | 'options'
  | 'choice'
  | 'state'
  | 'deadline'
  | 'replyText'
  | 'replyToMessageID'
> &
  Pick<wire.Run, 'parentID' | 'parentType' | 'messageID'> & { approvalID: wire.Approval['id']; agentName: string };
// The run.progress frame's routing fields (orchestrator.go publishProgress).
type RunProgressWire = Pick<wire.Run, 'agentID' | 'invokerID' | 'parentID' | 'parentType' | 'threadRootID'> & {
  runID: wire.Run['id'];
  kind: string;
  text: string;
  tool: string;
};

// ---- Wire checks (compile-time only) --------------------------------------
// WireView<W>: some of W's fields, each with W's type — or null, which is how
// Go encodes a nil pointer or slice inside a map payload.
type WireView<W> = { [K in keyof W]?: W[K] | null };
// FitsWire is true when schema S declares only fields the wire type W has and
// parses each to a value W allows; otherwise it names the offending fields.
type FitsWire<S extends z.ZodObject, W> = [Exclude<keyof S['shape'], keyof W>] extends [never]
  ? z.output<S> extends WireView<W>
    ? true
    : { outputDoesNotFitWire: z.output<S> }
  : { notOnWire: Exclude<keyof S['shape'], keyof W> };
type Expect<T extends true> = T;

export type WSWireChecks = [
  Expect<FitsWire<typeof messageObject, wire.Message>>,
  Expect<FitsWire<typeof messageObject, Message>>,
  Expect<FitsWire<typeof messageDeletedSchema, wire.Message>>,
  Expect<FitsWire<typeof userUpdatedSchema, wire.User>>,
  Expect<FitsWire<typeof customEmojiSchema, wire.CustomEmoji>>,
  Expect<FitsWire<typeof notificationSchema, wire.Notification>>,
  // The item itself is checked on the next line (the view is one level deep).
  Expect<FitsWire<typeof activityNewSchema, { [K in keyof wire.ActivityNewEvent]: unknown }>>,
  Expect<FitsWire<typeof activityItemSchema, wire.ActivityFeedItem>>,
  Expect<FitsWire<typeof activityChangedSchema, wire.ActivityChangedEvent>>,
  Expect<FitsWire<typeof runUpdatedSchema, wire.Run>>,
  Expect<FitsWire<typeof runProgressSchema, RunProgressWire>>,
  Expect<FitsWire<typeof runApprovalSchema, RunApprovalWire>>,
  Expect<FitsWire<typeof conversationConvertedSchema, { conversationID: string; channelID: wire.Channel['id']; slug: wire.Channel['slug'] }>>,
  Expect<FitsWire<typeof notificationSettingsUpdatedSchema, { settings: wire.NotificationSettings }>>,
];
