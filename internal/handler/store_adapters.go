package handler

import (
	"context"
	"time"

	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// The store impls satisfy the service-layer interfaces directly (the method
// names were aligned), so no per-store rename adapters exist anymore. What
// remains here are the two genuine adapters: UnreadSeqAdapter composes two
// functions into one interface, and ParentIndexAdapter maps store row types
// onto service entry types.

// UnreadSeqAdapter binds a parent's message-seq incrementer and per-user
// last-read setter into one service.UnreadSeqStore. It lets channels (counter
// on the channel store, last-read on the membership store) and conversations
// (both on the conversation store) share the same MessageService unread path.
type UnreadSeqAdapter struct {
	incr     func(ctx context.Context, parentID string) (int64, error)
	lastRead func(ctx context.Context, parentID, userID string, seq int64) error
}

func NewUnreadSeqAdapter(
	incr func(ctx context.Context, parentID string) (int64, error),
	lastRead func(ctx context.Context, parentID, userID string, seq int64) error,
) *UnreadSeqAdapter {
	return &UnreadSeqAdapter{incr: incr, lastRead: lastRead}
}

func (a *UnreadSeqAdapter) IncrementMessageSeq(ctx context.Context, parentID string) (int64, error) {
	return a.incr(ctx, parentID)
}
func (a *UnreadSeqAdapter) SetLastRead(ctx context.Context, parentID, userID string, seq int64) error {
	return a.lastRead(ctx, parentID, userID, seq)
}

// ParentIndexAdapter bridges store.ParentIndexStoreImpl into the
// service layer's ParentPinFileIndexStore interface (named after its
// concrete consumers — ListPinned and ListFiles — so service code
// reads as "set pin index, set file index" without importing the
// store package).
type ParentIndexAdapter struct {
	s parentIndexBacking
}

// parentIndexBacking is the small surface ParentIndexAdapter needs.
// Mirrored as an interface so tests can inject a fake without spinning
// up DynamoDB — this adapter does real type mapping (store row types →
// service entry types), unlike the deleted rename adapters.
type parentIndexBacking interface {
	SetPinIndex(ctx context.Context, parentID, msgID, pinnedBy string, pinnedAt time.Time) error
	DeletePinIndex(ctx context.Context, parentID, msgID string) error
	ListPinIndex(ctx context.Context, parentID string) ([]*store.PinIndexRow, error)
	SetFileIndex(ctx context.Context, parentID, attachmentID, msgID, authorID string, createdAt time.Time) error
	DeleteFileIndex(ctx context.Context, parentID, attachmentID string) error
	ListFileIndex(ctx context.Context, parentID string) ([]*store.FileIndexRow, error)
}

func NewParentIndexAdapter(s *store.ParentIndexStoreImpl) *ParentIndexAdapter {
	return &ParentIndexAdapter{s: s}
}

// newParentIndexAdapterFromBacking is the test-friendly variant that
// accepts any conforming backing — used by adapter tests to swap in
// an in-memory fake. Not exported because production callers always
// have a real *ParentIndexStoreImpl.
func newParentIndexAdapterFromBacking(b parentIndexBacking) *ParentIndexAdapter {
	return &ParentIndexAdapter{s: b}
}

func (a *ParentIndexAdapter) SetPinIndex(ctx context.Context, parentID, msgID, pinnedBy string, pinnedAt time.Time) error {
	return a.s.SetPinIndex(ctx, parentID, msgID, pinnedBy, pinnedAt)
}

func (a *ParentIndexAdapter) DeletePinIndex(ctx context.Context, parentID, msgID string) error {
	return a.s.DeletePinIndex(ctx, parentID, msgID)
}

func (a *ParentIndexAdapter) ListPinIndex(ctx context.Context, parentID string) ([]service.PinIndexEntry, error) {
	rows, err := a.s.ListPinIndex(ctx, parentID)
	if err != nil {
		return nil, err
	}
	out := make([]service.PinIndexEntry, 0, len(rows))
	for _, r := range rows {
		out = append(out, service.PinIndexEntry{
			MessageID: r.MessageID,
			PinnedBy:  r.PinnedBy,
			PinnedAt:  r.PinnedAt,
		})
	}
	return out, nil
}

func (a *ParentIndexAdapter) SetFileIndex(ctx context.Context, parentID, attachmentID, msgID, authorID string, createdAt time.Time) error {
	return a.s.SetFileIndex(ctx, parentID, attachmentID, msgID, authorID, createdAt)
}

func (a *ParentIndexAdapter) DeleteFileIndex(ctx context.Context, parentID, attachmentID string) error {
	return a.s.DeleteFileIndex(ctx, parentID, attachmentID)
}

func (a *ParentIndexAdapter) ListFileIndex(ctx context.Context, parentID string) ([]service.FileIndexEntry, error) {
	rows, err := a.s.ListFileIndex(ctx, parentID)
	if err != nil {
		return nil, err
	}
	out := make([]service.FileIndexEntry, 0, len(rows))
	for _, r := range rows {
		out = append(out, service.FileIndexEntry{
			AttachmentID: r.AttachmentID,
			MessageID:    r.MessageID,
			AuthorID:     r.AuthorID,
			CreatedAt:    r.CreatedAt,
		})
	}
	return out, nil
}
