package search

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// Reindex status is persisted to DynamoDB (durable + cluster-visible) rather
// than kept only in process memory. Unlike the mapping rebuild there is no
// distributed lock (a bare in-process mutex guards same-instance double-runs),
// so crash recovery rides on a heartbeat: the runner refreshes UpdatedAt as it
// writes progress, and Status treats a "running" record whose heartbeat has gone
// stale as an interrupted run — otherwise a crash would leave the panel wedged
// on "running" forever (process memory used to clear on restart).
const (
	// reindexPersistThrottle floors how often progress is flushed to DynamoDB
	// during a run, so a 10k-parent walk doesn't become 10k writes.
	reindexPersistThrottle = 10 * time.Second
	// reindexStaleAfter is how long a "running" record may go without a
	// heartbeat before Status reports it interrupted. Comfortably exceeds the
	// throttle so an actively-working run is never flagged, yet a dead runner
	// un-sticks the panel within a minute.
	reindexStaleAfter = 60 * time.Second
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

// IndexRebuilder is the slice of Client the zero-downtime index rebuild
// uses. *Client satisfies it; tests stub it.
type IndexRebuilder interface {
	BeginIndexRebuild(ctx context.Context, name string) (string, error)
	PromoteIndex(ctx context.Context, name, staging string) error
	AbortIndexRebuild(ctx context.Context, staging string)
	Bulk(ctx context.Context, index string, entries []BulkEntry) error
	DeleteDoc(ctx context.Context, index, id string) error
}

// RecreateUsersChannels rolls the autocomplete mapping onto an existing
// cluster with zero downtime: for each of ex_users and ex_channels it
// builds a fresh staging index with the current mapping, bulk-populates
// it from src, atomically promotes it under the logical name, then runs
// a repair pass. Because each index is rebuilt from scratch, orphaned
// ghost docs (users/channels deleted straight from DynamoDB and never
// de-indexed) are dropped as a side effect. Idempotent — safe to re-run.
// Counts are only meaningful on success; every error path returns 0, 0.
//
// This reuses the same userDoc/channelDoc builders and Client.Bulk path
// as the full Reindexer, scoped to just the two analyzer-affected
// indices so the migration doesn't have to touch messages/files.
func RecreateUsersChannels(ctx context.Context, rc IndexRebuilder, src UsersChannelsSource) (users, channels int, err error) {
	users, err = rebuildIndex(ctx, rc, IndexUsers, func(ctx context.Context) ([]BulkEntry, error) {
		list, err := src.ListUsers(ctx)
		if err != nil {
			return nil, err
		}
		entries := make([]BulkEntry, 0, len(list))
		for _, u := range list {
			entries = append(entries, BulkEntry{ID: u.ID, Doc: userDoc(u)})
		}
		return entries, nil
	})
	if err != nil {
		return 0, 0, err
	}
	channels, err = rebuildIndex(ctx, rc, IndexChannels, func(ctx context.Context) ([]BulkEntry, error) {
		list, err := src.ListChannels(ctx)
		if err != nil {
			return nil, err
		}
		entries := make([]BulkEntry, 0, len(list))
		for _, ch := range list {
			entries = append(entries, BulkEntry{ID: ch.ID, Doc: channelDoc(ch)})
		}
		return entries, nil
	})
	if err != nil {
		return 0, 0, err
	}
	return users, channels, nil
}

// rebuildIndex swaps a fresh copy of `name` live without a gap:
//
//	list → create staging → bulk into staging → atomic promote →
//	repair pass (list again + bulk through the live name)
//
// The live index keeps serving reads AND writes until the promote, so
// concurrent searches never 404 and a failure before the promote leaves
// the old index fully intact (the staging index is aborted). The repair
// pass re-lists from the canonical store after the promote: entities
// created or renamed while the rebuild ran (their live-index writes died
// with the old index) are re-indexed, and entities deleted mid-rebuild
// (present in pass 1, gone in pass 2) are removed from the new index.
// The returned count is only meaningful on success; error paths return 0.
func rebuildIndex(ctx context.Context, rc IndexRebuilder, name string, list func(ctx context.Context) ([]BulkEntry, error)) (int, error) {
	first, err := list(ctx)
	if err != nil {
		return 0, fmt.Errorf("search reindex: list %s: %w", name, err)
	}
	staging, err := rc.BeginIndexRebuild(ctx, name)
	if err != nil {
		return 0, err
	}
	if err := rc.Bulk(ctx, staging, first); err != nil {
		rc.AbortIndexRebuild(ctx, staging)
		return 0, fmt.Errorf("search reindex: bulk %s: %w", name, err)
	}
	if err := rc.PromoteIndex(ctx, name, staging); err != nil {
		rc.AbortIndexRebuild(ctx, staging)
		return 0, err
	}
	second, err := list(ctx)
	if err != nil {
		return 0, fmt.Errorf("search reindex: repair list %s: %w", name, err)
	}
	if err := rc.Bulk(ctx, name, second); err != nil {
		return 0, fmt.Errorf("search reindex: repair bulk %s: %w", name, err)
	}
	alive := make(map[string]bool, len(second))
	for _, e := range second {
		alive[e.ID] = true
	}
	for _, e := range first {
		if !alive[e.ID] {
			if err := rc.DeleteDoc(ctx, name, e.ID); err != nil {
				return 0, fmt.Errorf("search reindex: repair delete %s/%s: %w", name, e.ID, err)
			}
		}
	}
	return len(second), nil
}

// Reindexer rebuilds every OpenSearch index from the canonical DDB
// data. Triggered by an admin action; runs in a goroutine. Status is
// observable via Status() so the admin UI can show progress.
type Reindexer struct {
	src         reindexSources
	w           bulkWriter
	attachments AttachmentResolver
	status      StatusStore
	now         func() int64

	mu          sync.Mutex
	running     bool
	lastErr     error
	progress    ReindexProgress
	lastPersist int64 // Unix secs of the last DynamoDB status flush (throttle)
}

// SetAttachmentResolver wires filename lookup so reindexed messages
// include the same `attachmentNames` field LiveIndexer writes on
// per-message updates.
func (r *Reindexer) SetAttachmentResolver(a AttachmentResolver) {
	r.attachments = a
}

// ReindexProgress is the snapshot the admin UI polls. It is persisted to
// DynamoDB, so `dynamodbav` tags mirror the json tags. UpdatedAt is the
// heartbeat: refreshed on every flush so a stale value marks a dead runner.
type ReindexProgress struct {
	Running     bool   `json:"running" dynamodbav:"running"`
	Users       int    `json:"users" dynamodbav:"users"`
	Channels    int    `json:"channels" dynamodbav:"channels"`
	Messages    int    `json:"messages" dynamodbav:"messages"`
	Files       int    `json:"files" dynamodbav:"files"`
	LastError   string `json:"lastError,omitempty" dynamodbav:"lastError,omitempty"`
	StartedAt   int64  `json:"startedAt,omitempty" dynamodbav:"startedAt,omitempty"`     // Unix seconds
	CompletedAt int64  `json:"completedAt,omitempty" dynamodbav:"completedAt,omitempty"` // Unix seconds; zero while running
	UpdatedAt   int64  `json:"updatedAt,omitempty" dynamodbav:"updatedAt,omitempty"`     // Unix seconds; heartbeat
}

// NewReindexer constructs a Reindexer. When `client` or `status` is nil (no
// OpenSearch / no status store configured) returns nil — handlers should treat
// that as "search not enabled" and return 503.
func NewReindexer(client *Client, src reindexSources, status StatusStore) *Reindexer {
	if client == nil || src == nil || status == nil {
		return nil
	}
	return &Reindexer{src: src, w: client, status: status, now: func() int64 { return time.Now().Unix() }}
}

// Status returns the current progress snapshot, read from the durable store so
// every instance reports the same state. A never-run reindex reports the zero
// value. A "running" record whose heartbeat has gone stale (the runner crashed)
// is reported not-running with an interrupted note so the panel un-sticks.
func (r *Reindexer) Status(ctx context.Context) (ReindexProgress, error) {
	var p ReindexProgress
	found, err := r.status.GetSearchStatus(ctx, searchJobReindex, &p)
	if err != nil {
		return ReindexProgress{}, err
	}
	if !found {
		return ReindexProgress{}, nil
	}
	if p.Running && p.UpdatedAt > 0 && r.now()-p.UpdatedAt > int64(reindexStaleAfter.Seconds()) {
		p.Running = false
		if p.LastError == "" {
			p.LastError = "reindex interrupted (runner exited before completion)"
		}
	}
	return p, nil
}

// Start kicks off a reindex. Returns false if one is already running ON THIS
// INSTANCE (a bare in-process mutex — there is no distributed lock, so two
// instances can run concurrently; the shared status just reflects the last
// write). Idempotent per instance — callers can spam the admin button.
func (r *Reindexer) Start(ctx context.Context) bool {
	r.mu.Lock()
	if r.running {
		r.mu.Unlock()
		return false
	}
	r.running = true
	r.lastErr = nil
	r.lastPersist = 0
	r.progress = ReindexProgress{StartedAt: r.now()}
	r.mu.Unlock()
	r.persist(ctx, true) // publish "running" immediately so the panel flips
	go r.run(ctx)
	return true
}

func (r *Reindexer) run(ctx context.Context) {
	err := r.doRun(ctx)
	r.mu.Lock()
	r.running = false
	r.lastErr = err
	r.progress.CompletedAt = r.now()
	r.mu.Unlock()
	r.persist(ctx, true) // terminal status, forced past the throttle
}

// persist flushes the current progress to the durable store. Throttled unless
// forced: the runner calls it after every bulk phase, but a write lands at most
// once per reindexPersistThrottle so a many-parent walk doesn't storm DynamoDB.
// Best-effort — the run is authoritative in memory; a failed flush only means a
// staler panel, so it's logged, not fatal.
func (r *Reindexer) persist(ctx context.Context, force bool) {
	if r.status == nil {
		return
	}
	r.mu.Lock()
	now := r.now()
	if !force && now-r.lastPersist < int64(reindexPersistThrottle.Seconds()) {
		r.mu.Unlock()
		return
	}
	r.lastPersist = now
	p := r.progress
	p.Running = r.running
	p.UpdatedAt = now
	if r.lastErr != nil {
		p.LastError = r.lastErr.Error()
	}
	r.mu.Unlock()
	if err := r.status.PutSearchStatus(ctx, searchJobReindex, p); err != nil {
		slog.Warn("reindex: persist status failed", "error", err)
	}
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
	r.persist(ctx, false)
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
	r.persist(ctx, false)
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
	r.persist(ctx, false)
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
	r.persist(ctx, false)
	return nil
}
