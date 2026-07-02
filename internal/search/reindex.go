package search

import (
	"context"
	"fmt"
	"sync"

	"github.com/DigitalTolk/ex/internal/model"
)

// reindexSources is the data the Reindexer pulls from. Each method
// returns the full population — message and conversation lookups go
// channel-by-channel and conversation-by-conversation through the
// concrete loaders, so this slim interface stays focused on listing
// the parents.
type reindexSources interface {
	ListUsers(ctx context.Context) ([]*model.User, error)
	ListChannels(ctx context.Context) ([]*model.Channel, error)
	ListConversations(ctx context.Context) ([]*model.Conversation, error)
	ListMessages(ctx context.Context, parentID string) ([]*model.Message, error)
}

// bulkWriter is the slice of Client used by the reindexer.
type bulkWriter interface {
	Bulk(ctx context.Context, index string, entries []BulkEntry) error
}

// UsersChannelsSource is the slim data source the search-reindex
// migration pulls from to rebuild ex_users and ex_channels — the two
// indices that carry the autocomplete analyzer.
type UsersChannelsSource interface {
	ListUsers(ctx context.Context) ([]*model.User, error)
	ListChannels(ctx context.Context) ([]*model.Channel, error)
}

// indexRecreator drops-and-recreates a single index with the current
// mapping. *Client satisfies it; tests stub it.
type indexRecreator interface {
	RecreateIndex(ctx context.Context, name string) error
	Bulk(ctx context.Context, index string, entries []BulkEntry) error
}

// RecreateUsersChannels rolls the autocomplete mapping onto an existing
// cluster: it drops ex_users and ex_channels, recreates them with the
// current mapping, then bulk-reindexes every user and channel from src.
// Because each index is rebuilt from scratch, orphaned ghost docs
// (users/channels deleted straight from DynamoDB and never de-indexed)
// are dropped as a side effect. Idempotent — safe to re-run.
//
// This reuses the same userDoc/channelDoc builders and Client.Bulk path
// as the full Reindexer, scoped to just the two analyzer-affected
// indices so the migration doesn't have to touch messages/files.
func RecreateUsersChannels(ctx context.Context, rc indexRecreator, src UsersChannelsSource) (users, channels int, err error) {
	usersList, err := src.ListUsers(ctx)
	if err != nil {
		return 0, 0, fmt.Errorf("search reindex: list users: %w", err)
	}
	channelsList, err := src.ListChannels(ctx)
	if err != nil {
		return 0, 0, fmt.Errorf("search reindex: list channels: %w", err)
	}
	if err := rc.RecreateIndex(ctx, IndexUsers); err != nil {
		return 0, 0, err
	}
	userEntries := make([]BulkEntry, 0, len(usersList))
	for _, u := range usersList {
		userEntries = append(userEntries, BulkEntry{ID: u.ID, Doc: userDoc(u)})
	}
	if err := rc.Bulk(ctx, IndexUsers, userEntries); err != nil {
		return 0, 0, fmt.Errorf("search reindex: bulk users: %w", err)
	}
	if err := rc.RecreateIndex(ctx, IndexChannels); err != nil {
		return len(usersList), 0, err
	}
	channelEntries := make([]BulkEntry, 0, len(channelsList))
	for _, ch := range channelsList {
		channelEntries = append(channelEntries, BulkEntry{ID: ch.ID, Doc: channelDoc(ch)})
	}
	if err := rc.Bulk(ctx, IndexChannels, channelEntries); err != nil {
		return len(usersList), 0, fmt.Errorf("search reindex: bulk channels: %w", err)
	}
	return len(usersList), len(channelsList), nil
}

// Reindexer rebuilds every OpenSearch index from the canonical DDB
// data. Triggered by an admin action; runs in a goroutine. Status is
// observable via Status() so the admin UI can show progress.
type Reindexer struct {
	src         reindexSources
	w           bulkWriter
	attachments AttachmentResolver

	mu       sync.Mutex
	running  bool
	lastErr  error
	progress ReindexProgress
}

// SetAttachmentResolver wires filename lookup so reindexed messages
// include the same `attachmentNames` field LiveIndexer writes on
// per-message updates.
func (r *Reindexer) SetAttachmentResolver(a AttachmentResolver) {
	r.attachments = a
}

// ReindexProgress is the snapshot the admin UI polls.
type ReindexProgress struct {
	Running     bool   `json:"running"`
	Users       int    `json:"users"`
	Channels    int    `json:"channels"`
	Messages    int    `json:"messages"`
	Files       int    `json:"files"`
	LastError   string `json:"lastError,omitempty"`
	StartedAt   int64  `json:"startedAt,omitempty"`   // Unix seconds
	CompletedAt int64  `json:"completedAt,omitempty"` // Unix seconds; zero while running
}

// NewReindexer constructs a Reindexer. When `client` is nil (no
// OpenSearch configured) returns nil — handlers should treat that as
// "search not enabled" and return 503.
func NewReindexer(client *Client, src reindexSources) *Reindexer {
	if client == nil || src == nil {
		return nil
	}
	return &Reindexer{src: src, w: client}
}

// Status returns the current progress snapshot.
func (r *Reindexer) Status() ReindexProgress {
	r.mu.Lock()
	defer r.mu.Unlock()
	p := r.progress
	p.Running = r.running
	if r.lastErr != nil {
		p.LastError = r.lastErr.Error()
	}
	return p
}

// Start kicks off a reindex. Returns false if one is already running
// (idempotent — callers can spam the admin button without queueing
// concurrent runs).
func (r *Reindexer) Start(ctx context.Context, now func() int64) bool {
	r.mu.Lock()
	if r.running {
		r.mu.Unlock()
		return false
	}
	r.running = true
	r.lastErr = nil
	r.progress = ReindexProgress{StartedAt: now()}
	r.mu.Unlock()
	go r.run(ctx, now)
	return true
}

func (r *Reindexer) run(ctx context.Context, now func() int64) {
	err := r.doRun(ctx)
	r.mu.Lock()
	r.running = false
	r.lastErr = err
	r.progress.CompletedAt = now()
	r.mu.Unlock()
}

func (r *Reindexer) doRun(ctx context.Context) error {
	users, err := r.src.ListUsers(ctx)
	if err != nil {
		return fmt.Errorf("reindex: list users: %w", err)
	}
	if err := r.bulkUsers(ctx, users); err != nil {
		return err
	}

	channels, err := r.src.ListChannels(ctx)
	if err != nil {
		return fmt.Errorf("reindex: list channels: %w", err)
	}
	if err := r.bulkChannels(ctx, channels); err != nil {
		return err
	}

	convs, err := r.src.ListConversations(ctx)
	if err != nil {
		return fmt.Errorf("reindex: list conversations: %w", err)
	}

	// Walk channels then conversations so messages from each parent
	// pick up the right parentType. Messages are bulk-indexed in
	// per-parent batches to keep memory bounded; the file map
	// accumulates across batches so each attachment is written once
	// with its full set of referencing parents.
	files := make(map[string]*fileBucket)
	for _, ch := range channels {
		msgs, err := r.src.ListMessages(ctx, ch.ID)
		if err != nil {
			return fmt.Errorf("reindex: list messages %s: %w", ch.ID, err)
		}
		if err := r.bulkMessages(ctx, msgs, "channel", files); err != nil {
			return err
		}
	}
	for _, c := range convs {
		msgs, err := r.src.ListMessages(ctx, c.ID)
		if err != nil {
			return fmt.Errorf("reindex: list messages %s: %w", c.ID, err)
		}
		if err := r.bulkMessages(ctx, msgs, "conversation", files); err != nil {
			return err
		}
	}
	return r.bulkFiles(ctx, files)
}

func (r *Reindexer) bulkUsers(ctx context.Context, users []*model.User) error {
	entries := make([]BulkEntry, 0, len(users))
	for _, u := range users {
		entries = append(entries, BulkEntry{ID: u.ID, Doc: userDoc(u)})
	}
	if err := r.w.Bulk(ctx, IndexUsers, entries); err != nil {
		return fmt.Errorf("reindex: bulk users: %w", err)
	}
	r.mu.Lock()
	r.progress.Users = len(users)
	r.mu.Unlock()
	return nil
}

func (r *Reindexer) bulkChannels(ctx context.Context, channels []*model.Channel) error {
	entries := make([]BulkEntry, 0, len(channels))
	for _, ch := range channels {
		entries = append(entries, BulkEntry{ID: ch.ID, Doc: channelDoc(ch)})
	}
	if err := r.w.Bulk(ctx, IndexChannels, entries); err != nil {
		return fmt.Errorf("reindex: bulk channels: %w", err)
	}
	r.mu.Lock()
	r.progress.Channels = len(channels)
	r.mu.Unlock()
	return nil
}

// fileBucket aggregates per-attachment state across all messages we
// re-walk during a reindex so each file is written once with the
// merged parent/message sets. messageIds and parentMessageIds are
// kept index-aligned (parentMessageIds[i] is the thread root of
// messageIds[i], or "" for top-level).
type fileBucket struct {
	a                *model.Attachment
	parentIds        []string
	messageIds       []string
	parentMessageIds []string
	parentSeen       map[string]bool
	msgSeen          map[string]bool
}

func (r *Reindexer) bulkMessages(ctx context.Context, msgs []*model.Message, parentType string, files map[string]*fileBucket) error {
	entries := make([]BulkEntry, 0, len(msgs))
	for _, m := range msgs {
		if m == nil || m.System {
			continue
		}
		entries = append(entries, BulkEntry{ID: m.ID, Doc: messageDoc(m, parentType)})
		if r.attachments == nil || len(m.AttachmentIDs) == 0 || files == nil {
			continue
		}
		atts := r.attachments.ResolveAttachments(ctx, m.AttachmentIDs)
		for _, a := range atts {
			if a == nil {
				continue
			}
			b, ok := files[a.ID]
			if !ok {
				b = &fileBucket{a: a, parentSeen: map[string]bool{}, msgSeen: map[string]bool{}}
				files[a.ID] = b
			}
			if !b.parentSeen[m.ParentID] {
				b.parentSeen[m.ParentID] = true
				b.parentIds = append(b.parentIds, m.ParentID)
			}
			if !b.msgSeen[m.ID] {
				b.msgSeen[m.ID] = true
				b.messageIds = append(b.messageIds, m.ID)
				b.parentMessageIds = append(b.parentMessageIds, m.ParentMessageID)
			}
		}
	}
	if len(entries) == 0 {
		return nil
	}
	if err := r.w.Bulk(ctx, IndexMessages, entries); err != nil {
		return fmt.Errorf("reindex: bulk messages: %w", err)
	}
	r.mu.Lock()
	r.progress.Messages += len(entries)
	r.mu.Unlock()
	return nil
}

func (r *Reindexer) bulkFiles(ctx context.Context, files map[string]*fileBucket) error {
	if len(files) == 0 {
		return nil
	}
	entries := make([]BulkEntry, 0, len(files))
	for id, b := range files {
		entries = append(entries, BulkEntry{
			ID: id,
			Doc: map[string]any{
				"id":               b.a.ID,
				"filename":         b.a.Filename,
				"contentType":      b.a.ContentType,
				"size":             b.a.Size,
				"sharedBy":         b.a.CreatedBy,
				"parentIds":        b.parentIds,
				"messageIds":       b.messageIds,
				"parentMessageIds": b.parentMessageIds,
				"createdAt":        b.a.CreatedAt,
			},
		})
	}
	if err := r.w.Bulk(ctx, IndexFiles, entries); err != nil {
		return fmt.Errorf("reindex: bulk files: %w", err)
	}
	r.mu.Lock()
	r.progress.Files = len(entries)
	r.mu.Unlock()
	return nil
}
