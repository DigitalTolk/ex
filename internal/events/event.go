package events

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/oklog/ulid/v2"
)

// monoEntropy is a monotonic ULID entropy source — it guarantees
// strictly-increasing ULIDs within the same millisecond. The replay
// cursor relies on lexicographic ULID comparison being monotonic; a
// plain crypto/rand source can produce two ULIDs in the same ms
// where the second sorts BEFORE the first, breaking cursor logic.
//
// The locked wrapper lets concurrent publishers call NewEvent safely
// — the monotonic entropy maintains an in-process counter that is
// not goroutine-safe on its own.
var (
	monoEntropyMu sync.Mutex
	monoEntropy   = ulid.Monotonic(rand.Reader, 0)
)

func newULID(now time.Time) string {
	monoEntropyMu.Lock()
	defer monoEntropyMu.Unlock()
	return ulid.MustNew(ulid.Timestamp(now), monoEntropy).String()
}

// Event type constants used across the application.
const (
	EventMessageNew         = "message.new"
	EventMessageEdited      = "message.edited"
	EventMessageDeleted     = "message.deleted"
	EventMemberJoined       = "member.joined"
	EventMemberLeft         = "member.left"
	EventChannelUpdated     = "channel.updated"
	EventConversationNew    = "conversation.new"
	EventChannelNew         = "channel.new"
	EventChannelArchived    = "channel.archived"
	EventChannelRemoved     = "channel.removed" // user was removed from a channel — sent to that user's personal channel
	EventMembersChanged     = "members.changed"
	EventEmojiAdded         = "emoji.added"
	EventEmojiRemoved       = "emoji.removed"
	EventPresenceChanged    = "presence.changed"
	EventUserUpdated        = "user.updated"
	EventAttachmentDeleted  = "attachment.deleted"
	EventChannelMuted       = "channel.muted"
	EventUserChannelUpdated = "userchannel.updated" // per-user user-side state changed (favorite/category/notification prefs)
	EventNotificationNew    = "notification.new"
	// EventNotificationSettingsUpdated is sent to a user's own clients when
	// their account-level notification settings (levels, keywords, etc.)
	// change, so every open tab/device stays in sync.
	EventNotificationSettingsUpdated = "notification.settings_updated"
	EventDraftUpdated                = "draft.updated"
	EventForceLogout                 = "auth.force_logout" // sent to a user's personal channel when their session must end (e.g. deactivation)
	EventServerVersion               = "server.version"    // sent once on connect so clients can detect deploys without polling
	EventTyping                      = "typing"            // ephemeral typing indicator — published when a user starts typing in a parent
	EventPing                        = "ping"
	EventReplayDone                  = "replay.done"      // server → client marker frame after a reconnect replay completes
	EventReplayExhausted             = "replay.exhausted" // cursor too old / unknown; client must do a full refetch
	EventWebhookChanged              = "webhook.changed"  // admin incoming-webhook list changed (created/deleted); data-less nudge to refetch
	// EventActivityNew nudges a user's own clients that their activity stream
	// (reaction hints + fired reminders) changed. Data-less: the durable Redis
	// activity store is the source of truth, so the client just refetches the
	// list. Sent to the user's personal channel (pubsub.UserChannel).
	EventActivityNew = "activity.new"
	// EventThreadUpdated patches a thread participant's /threads list live when a
	// reply lands. Sent per-participant (pubsub.UserChannel) — the participant
	// scoping is what the channel-topic message.edited can't provide, so the
	// client can add the row without guessing at participation. Carries a
	// ThreadSummary. Ephemeral: ListUserThreads is the durable source of truth,
	// re-read on reconnect, so replaying this would be noise.
	EventThreadUpdated = "thread.updated"
)

// ephemeralTypes are events that exist only for the live socket — they
// add no value on a reconnect replay because either the next live frame
// supersedes them (presence, typing, ping, server.version) or they
// fired-and-forget at the moment they happened (force_logout). Keeping
// them out of the per-user inbox stream avoids wasting MAXLEN budget on
// noise that would just be discarded by the client anyway.
//
// notification.new is ephemeral on purpose: a notification is a "fire at the
// moment" alert (sound + popup + push). Replaying it on reconnect would re-pop
// a toast the user already saw — a duplicate-notification bug — and the
// underlying unread/thread state is re-reconciled by the client's onReconnect
// refetch anyway. A missed toast on reconnect is far better than a dupe.
var ephemeralTypes = map[string]struct{}{
	EventTyping:          {},
	EventPing:            {},
	EventPresenceChanged: {},
	EventServerVersion:   {},
	EventForceLogout:     {},
	EventReplayDone:      {},
	EventReplayExhausted: {},
	EventNotificationNew: {},
	// activity.new is a data-less "your activity changed" nudge; the durable
	// Redis activity store is the source of truth and the client refetches the
	// list on reconnect, so replaying the nudge would be pure noise.
	EventActivityNew: {},
	// thread.updated is a live /threads-list patch; ListUserThreads is the
	// durable source of truth and is re-read on reconnect, so replaying it
	// would be noise (and could re-add a row the user has since left).
	EventThreadUpdated: {},
}

// IsPersistent reports whether an event of this type should be appended
// to a recipient's durable inbox for later replay on reconnect.
func IsPersistent(eventType string) bool {
	_, ephemeral := ephemeralTypes[eventType]
	return !ephemeral
}

// Event represents a real-time event with a type and JSON payload, delivered
// to clients over WebSocket.
//
// ID is a ULID stamped at publish time. It is the canonical identity the
// client uses to dedup live frames against replayed frames after a
// reconnect (replay + live will race during the cutover and the same
// event can arrive twice).
//
// Ts is the publish-time wallclock in milliseconds since epoch — sent
// alongside ID so clients can show "delivered" or order events without
// re-decoding the ULID.
type Event struct {
	ID   string          `json:"id,omitempty"`
	Ts   int64           `json:"ts,omitempty"`
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

// NewEvent creates an Event by marshaling data to JSON. ID and Ts are
// stamped automatically — every event gets identity, even ephemeral
// ones, because the client's dedup LRU doesn't care which kind it is.
func NewEvent(eventType string, data any) (*Event, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("marshal event data: %w", err)
	}
	now := time.Now()
	return &Event{
		ID:   newULID(now),
		Ts:   now.UnixMilli(),
		Type: eventType,
		Data: raw,
	}, nil
}
