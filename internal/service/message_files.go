package service

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/safe"
	"github.com/DigitalTolk/ex/internal/store"
	"golang.org/x/sync/errgroup"
)

const (
	// defaultFilePageSize and maxFilePageSize bound one page of ListFiles.
	defaultFilePageSize = 50
	maxFilePageSize     = 100
	// maxFileQueryRunes caps the file-name filter.
	maxFileQueryRunes = 200
	// fileNameWriters bounds the background writes that remember names.
	fileNameWriters = 8
)

// FileQuery selects one page of a parent's files. Query filters by file name
// (case-insensitive, anywhere in the name), Cursor continues after an earlier
// page, and Limit caps the page.
type FileQuery struct {
	Query  string
	Cursor string
	Limit  int
}

// FileEntry is one file shared in the parent: the attachment, ready to show,
// and the latest message that shared it, so the client can link back to it.
type FileEntry struct {
	AttachmentID string            `json:"attachmentID"`
	MessageID    string            `json:"messageID"`
	AuthorID     string            `json:"authorID"`
	CreatedAt    time.Time         `json:"createdAt"`
	Attachment   *model.Attachment `json:"attachment"`
}

// FilePage is one page of ListFiles. NextCursor is empty on the last page.
type FilePage struct {
	Files      []*FileEntry `json:"files"`
	NextCursor string       `json:"nextCursor,omitempty"`
}

// ListFiles returns one page of the files shared in the parent, newest first.
//
// Re-shares of the same physical file collapse to one row keyed on the
// AttachmentID — the AttachmentService dedupes uploads by SHA-256, so the same
// content always resolves to the same ID, and the user only sees the latest
// message that referenced it.
//
// It reads the FILE# index, then one batch of messages and one batch of
// attachments per page, however many files the parent holds. (The panel used
// to fetch every attachment one request at a time, which on a busy channel ran
// into the per-user rate limit it shares with the images in the chat.)
func (s *MessageService) ListFiles(ctx context.Context, userID, parentID, parentType string, q FileQuery) (*FilePage, error) {
	if err := s.checkAccess(ctx, userID, parentID, parentType); err != nil {
		return nil, err
	}
	after, err := parseFileCursor(q.Cursor)
	if err != nil {
		return nil, err
	}
	term := strings.ToLower(strings.TrimSpace(q.Query))
	if utf8.RuneCountInString(term) > maxFileQueryRunes {
		return nil, apperr.Invalid("files: search is too long")
	}
	limit := q.Limit
	if limit <= 0 {
		limit = defaultFilePageSize
	}
	limit = min(limit, maxFilePageSize)

	rows, err := s.parentIndex.ListFileIndex(ctx, parentID)
	if err != nil {
		return nil, fmt.Errorf("message: list file index: %w", err)
	}
	slices.SortFunc(rows, compareFileRows)
	if term != "" {
		if err := s.fillFileNames(ctx, parentID, rows); err != nil {
			return nil, err
		}
		rows = slices.DeleteFunc(rows, func(r FileIndexEntry) bool {
			return !strings.Contains(strings.ToLower(r.Filename), term)
		})
	}
	start := 0
	if after != nil {
		// The first row past the cursor, whether or not the cursor's own row
		// is still there.
		i, found := slices.BinarySearchFunc(rows, *after, compareFileRows)
		if found {
			i++
		}
		start = i
	}

	page := &FilePage{Files: make([]*FileEntry, 0, limit)}
	// Rows whose message no longer carries the file are skipped, so a page
	// can take more than one round to fill; maxListRounds bounds that and the
	// cursor picks up where it stopped.
	for round := 0; start < len(rows) && len(page.Files) < limit && round < maxListRounds; round++ {
		end := min(start+limit-len(page.Files), len(rows))
		entries, err := s.resolveFiles(ctx, userID, parentID, parentType, rows[start:end])
		if err != nil {
			return nil, err
		}
		page.Files = append(page.Files, entries...)
		start = end
	}
	if start < len(rows) {
		page.NextCursor = fileCursor(rows[start-1])
	}
	return page, nil
}

// compareFileRows orders file rows newest first; the attachment ID breaks
// ties so the order — and with it the cursor — is total.
func compareFileRows(a, b FileIndexEntry) int {
	return cmp.Or(b.CreatedAt.Compare(a.CreatedAt), cmp.Compare(b.AttachmentID, a.AttachmentID))
}

// fileCursor names the last row of a page: its time and attachment ID.
func fileCursor(r FileIndexEntry) string {
	return strconv.FormatInt(r.CreatedAt.UnixNano(), 10) + "." + r.AttachmentID
}

func parseFileCursor(cursor string) (*FileIndexEntry, error) {
	if cursor == "" {
		return nil, nil
	}
	nanos, id, ok := strings.Cut(cursor, ".")
	n, err := strconv.ParseInt(nanos, 10, 64)
	if !ok || err != nil || id == "" {
		return nil, apperr.Invalid("files: bad cursor")
	}
	return &FileIndexEntry{CreatedAt: time.Unix(0, n), AttachmentID: id}, nil
}

// fillFileNames gives every row its file name, reading the attachments of the
// rows that don't have one yet, and remembers those names on the index.
func (s *MessageService) fillFileNames(ctx context.Context, parentID string, rows []FileIndexEntry) error {
	var missing []string
	for _, r := range rows {
		if r.Filename == "" {
			missing = append(missing, r.AttachmentID)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	atts, err := s.attachments.LoadMany(ctx, missing)
	if err != nil {
		return fmt.Errorf("message: load file names: %w", err)
	}
	named := make(map[string]string, len(atts))
	for i := range rows {
		if a := atts[rows[i].AttachmentID]; a != nil && rows[i].Filename == "" {
			rows[i].Filename = a.Filename
			named[a.ID] = a.Filename
		}
	}
	s.rememberFileNames(ctx, parentID, named)
	return nil
}

// rememberFileNames writes names onto their index rows in the background, so
// the next search in the parent reads them from the index alone. A failed
// write only means that name is read again next time.
func (s *MessageService) rememberFileNames(ctx context.Context, parentID string, names map[string]string) {
	if len(names) == 0 {
		return
	}
	safe.Go(func() {
		bg, cancel := detachedContext(ctx)
		defer cancel()
		var g errgroup.Group
		g.SetLimit(fileNameWriters)
		for id, name := range names {
			g.Go(func() error {
				defer safe.Recover()
				if err := s.parentIndex.SetFileIndexName(bg, parentID, id, name); err != nil {
					slog.WarnContext(bg, "file index name not saved", "parentID", parentID, "attachmentID", id, "error", err)
				}
				return nil
			})
		}
		_ = g.Wait()
	})
}

// resolveFiles turns index rows into entries: rows whose message still carries
// the file (the message is the truth; the index can trail an edit or a
// delete), with the attachment ready for userID to read from that message.
func (s *MessageService) resolveFiles(ctx context.Context, userID, parentID, parentType string, rows []FileIndexEntry) ([]*FileEntry, error) {
	msgIDs := make([]string, 0, len(rows))
	for _, r := range rows {
		msgIDs = append(msgIDs, r.MessageID)
	}
	slices.Sort(msgIDs)
	msgs, err := s.messagesByID(ctx, parentID, slices.Compact(msgIDs))
	if err != nil {
		return nil, fmt.Errorf("message: read file messages: %w", err)
	}
	shared := make([]FileIndexEntry, 0, len(rows))
	attIDs := make([]string, 0, len(rows))
	for _, r := range rows {
		if m := msgs[r.MessageID]; m != nil && slices.Contains(m.AttachmentIDs, r.AttachmentID) {
			shared = append(shared, r)
			attIDs = append(attIDs, r.AttachmentID)
		}
	}
	atts, err := s.attachments.LoadMany(ctx, attIDs)
	if err != nil {
		return nil, fmt.Errorf("message: read shared files: %w", err)
	}
	out := make([]*FileEntry, 0, len(shared))
	for _, r := range shared {
		a := atts[r.AttachmentID]
		if a == nil {
			continue
		}
		s.attachments.ReadyForReader(ctx, a, MediaGrant{UserID: userID, ParentID: parentID, ParentType: parentType, MessageID: r.MessageID})
		out = append(out, &FileEntry{
			AttachmentID: r.AttachmentID,
			MessageID:    r.MessageID,
			AuthorID:     r.AuthorID,
			CreatedAt:    r.CreatedAt,
			Attachment:   a,
		})
	}
	return out, nil
}

// messagesByID reads the parent's messages with the given (distinct) IDs in
// one batch where the store can, keyed by ID. Missing messages are left out;
// a failed read fails the call.
func (s *MessageService) messagesByID(ctx context.Context, parentID string, ids []string) (map[string]*model.Message, error) {
	out := make(map[string]*model.Message, len(ids))
	if bs, ok := s.messages.(batchMessageStore); ok {
		msgs, err := bs.GetMessagesByIDs(ctx, parentID, ids)
		if err != nil {
			return nil, err
		}
		for _, m := range msgs {
			out[m.ID] = m
		}
		return out, nil
	}
	for _, id := range ids {
		m, err := s.messages.GetMessage(ctx, parentID, id)
		switch {
		case errors.Is(err, store.ErrNotFound):
		case err != nil:
			return nil, err
		default:
			out[id] = m
		}
	}
	return out, nil
}
