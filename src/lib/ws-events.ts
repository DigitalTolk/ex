import { z } from 'zod';
import { EventType, type EventTypeName } from '@/lib/event-types';
import { reportError } from '@/lib/sentry';
import {
  activityChangedSchema,
  activityNewSchema,
  attachmentDeletedSchema,
  channelIDSchema,
  conversationConvertedSchema,
  customEmojiSchema,
  emojiRemovedSchema,
  messageDeletedSchema,
  messageSchema,
  notificationSchema,
  notificationSettingsUpdatedSchema,
  presenceSchema,
  runApprovalSchema,
  runProgressSchema,
  runUpdatedSchema,
  serverVersionSchema,
  threadUpdatedSchema,
  typingSchema,
  userChannelUpdatedSchema,
  userUpdatedSchema,
} from '@/lib/ws-schemas';

// A data-less "refetch your list" nudge (or a payload its handler ignores):
// anything validates.
const nudge = z.unknown();

// The one registry of WebSocket events: every event name Go declares (see
// event-types) maps to the schema its payload must pass before a handler sees
// it. `satisfies` keeps it exhaustive — a new EventType without a schema fails
// the build.
export const wsEventSchemas = {
  [EventType.MessageNew]: messageSchema,
  [EventType.MessageEdited]: messageSchema,
  [EventType.MessageDeleted]: messageDeletedSchema,
  [EventType.ChannelUpdated]: channelIDSchema,
  [EventType.ConversationNew]: nudge,
  [EventType.ConversationConverted]: conversationConvertedSchema,
  [EventType.ChannelNew]: nudge,
  [EventType.ChannelArchived]: channelIDSchema,
  [EventType.ChannelUnarchived]: channelIDSchema,
  [EventType.ChannelRemoved]: channelIDSchema,
  [EventType.MembersChanged]: channelIDSchema,
  [EventType.EmojiAdded]: customEmojiSchema,
  [EventType.EmojiRemoved]: emojiRemovedSchema,
  [EventType.PresenceChanged]: presenceSchema,
  [EventType.UserUpdated]: userUpdatedSchema,
  [EventType.UserChannelUpdated]: userChannelUpdatedSchema,
  [EventType.SidebarUpdated]: nudge,
  [EventType.AttachmentDeleted]: attachmentDeletedSchema,
  [EventType.ChannelMuted]: nudge,
  [EventType.NotificationNew]: notificationSchema,
  [EventType.NotificationSettingsUpdated]: notificationSettingsUpdatedSchema,
  [EventType.DraftUpdated]: nudge,
  [EventType.ForceLogout]: nudge,
  [EventType.ServerVersion]: serverVersionSchema,
  [EventType.Typing]: typingSchema,
  [EventType.Ping]: nudge,
  [EventType.ReplayDone]: nudge,
  [EventType.ReplayExhausted]: nudge,
  [EventType.WebhookChanged]: nudge,
  [EventType.ProjectChanged]: nudge,
  [EventType.SettingsUpdated]: nudge,
  [EventType.RunnersChanged]: nudge,
  [EventType.ActivityNew]: activityNewSchema,
  [EventType.ActivityRead]: activityChangedSchema,
  [EventType.ScheduledMessagesChanged]: nudge,
  [EventType.RemindersChanged]: nudge,
  [EventType.ThreadUpdated]: threadUpdatedSchema,
  [EventType.RunUpdated]: runUpdatedSchema,
  [EventType.RunProgress]: runProgressSchema,
  [EventType.RunApproval]: runApprovalSchema,
} satisfies { [K in EventTypeName]: z.ZodType };

export type WSEventPayloads = { [K in EventTypeName]: z.output<(typeof wsEventSchemas)[K]> };

// Frames the socket layer consumes itself (replay bookkeeping in
// useWebSocket); the app never handles them.
type TransportEventType = typeof EventType.ReplayDone | typeof EventType.ReplayExhausted;
export type AppEventType = Exclude<EventTypeName, TransportEventType>;

// The app's handler for every event, keyed like the registry. Exhaustive on
// purpose: an event the app ignores is written down as `null`, so a new event
// can't go unhandled by accident.
export type WSEventHandlers = { [K in AppEventType]: ((payload: WSEventPayloads[K]) => void) | null };

// What to do instead when an event's payload fails its schema (after the
// failure is reported) — the safe floor, usually a refetch.
export type WSInvalidPayloadFallbacks = Partial<Record<AppEventType, () => void>>;

function isAppEventType(type: string): type is AppEventType {
  return Object.hasOwn(wsEventSchemas, type) && type !== EventType.ReplayDone && type !== EventType.ReplayExhausted;
}

// A payload our own server sent that its schema rejects is a contract bug that
// cost the user an update (or, for notification.new, an alert): say so in the
// console and in Sentry rather than dropping it quietly.
function reportInvalidPayload(type: AppEventType, error: z.ZodError, payload: unknown): void {
  const issues = error.issues.map((issue) => `${issue.path.join('.') || '(payload)'}: ${issue.message}`);
  console.error(`ws: dropped a ${type} frame whose payload failed validation`, issues, payload);
  reportError(new Error(`ws: invalid ${type} payload`), { type, issues });
}

// dispatchWSEvent validates a frame's payload against its registered schema
// and hands the parsed value to the app's handler. Unknown and transport
// types are ignored. A handler's throw propagates (the socket layer then
// leaves the frame replayable).
export function dispatchWSEvent(
  type: string,
  payload: unknown,
  handlers: WSEventHandlers,
  fallbacks: WSInvalidPayloadFallbacks = {},
): void {
  if (!isAppEventType(type)) return;
  const handler = handlers[type] as ((payload: unknown) => void) | null;
  if (!handler) return;
  const parsed = wsEventSchemas[type].safeParse(payload);
  if (!parsed.success) {
    reportInvalidPayload(type, parsed.error, payload);
    fallbacks[type]?.();
    return;
  }
  handler(parsed.data);
}
