//go:build integration

package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// ============================================================================
// Attachment Store Tests
// ============================================================================

func makeAttachment(id, hash, filename string) *model.Attachment {
	return &model.Attachment{
		ID:          id,
		SHA256:      hash,
		Size:        1024,
		ContentType: "image/png",
		Filename:    filename,
		S3Key:       "uploads/" + id,
		CreatedBy:   "u-uploader",
		CreatedAt:   time.Now().Truncate(time.Millisecond),
	}
}

func TestAttachmentStore_CreateAndGetByID(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewAttachmentStore(db)
	ctx := context.Background()

	a := makeAttachment("att-1", "hash-1", "pic.png")
	if err := s.Create(ctx, a); err != nil {
		t.Fatalf("Create: %v", err)
	}

	got, err := s.GetByID(ctx, "att-1")
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if got.SHA256 != "hash-1" {
		t.Errorf("SHA256 = %q, want %q", got.SHA256, "hash-1")
	}
	if got.Filename != "pic.png" {
		t.Errorf("Filename = %q, want %q", got.Filename, "pic.png")
	}
	if got.Size != 1024 {
		t.Errorf("Size = %d, want 1024", got.Size)
	}
}

func TestAttachmentStore_GetByID_NotFound(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewAttachmentStore(db)
	ctx := context.Background()

	_, err := s.GetByID(ctx, "att-missing")
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestAttachmentStore_Create_Duplicate(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewAttachmentStore(db)
	ctx := context.Background()

	a := makeAttachment("att-dup", "hash-dup", "dup.png")
	if err := s.Create(ctx, a); err != nil {
		t.Fatalf("Create first: %v", err)
	}

	err := s.Create(ctx, a)
	if !errors.Is(err, ErrAlreadyExists) {
		t.Errorf("expected ErrAlreadyExists, got %v", err)
	}
}

func TestAttachmentStore_GetByHash(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewAttachmentStore(db)
	ctx := context.Background()

	a := makeAttachment("att-hash", "unique-hash-abc", "hash.png")
	if err := s.Create(ctx, a); err != nil {
		t.Fatalf("Create: %v", err)
	}

	got, err := s.GetByHash(ctx, "unique-hash-abc")
	if err != nil {
		t.Fatalf("GetByHash: %v", err)
	}
	if got.ID != "att-hash" {
		t.Errorf("ID = %q, want %q", got.ID, "att-hash")
	}
}

func TestAttachmentStore_GetByHash_NotFound(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewAttachmentStore(db)
	ctx := context.Background()

	_, err := s.GetByHash(ctx, "no-such-hash")
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestAttachmentStore_AddRef_RemoveRef(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewAttachmentStore(db)
	ctx := context.Background()

	a := makeAttachment("att-ref", "hash-ref", "ref.png")
	if err := s.Create(ctx, a); err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Add two refs.
	if err := s.AddRef(ctx, "att-ref", "msg-A"); err != nil {
		t.Fatalf("AddRef A: %v", err)
	}
	if err := s.AddRef(ctx, "att-ref", "msg-B"); err != nil {
		t.Fatalf("AddRef B: %v", err)
	}

	got, err := s.GetByID(ctx, "att-ref")
	if err != nil {
		t.Fatalf("GetByID after add: %v", err)
	}
	if len(got.MessageIDs) != 2 {
		t.Errorf("MessageIDs len = %d, want 2 (got %v)", len(got.MessageIDs), got.MessageIDs)
	}

	// Remove one ref; should return updated attachment.
	updated, err := s.RemoveRef(ctx, "att-ref", "msg-A")
	if err != nil {
		t.Fatalf("RemoveRef: %v", err)
	}
	if len(updated.MessageIDs) != 1 {
		t.Errorf("after remove, MessageIDs len = %d, want 1 (got %v)", len(updated.MessageIDs), updated.MessageIDs)
	}
	if updated.MessageIDs[0] != "msg-B" {
		t.Errorf("remaining ref = %q, want msg-B", updated.MessageIDs[0])
	}

	// Remove the last ref; the string-set attribute itself goes away in DynamoDB,
	// so MessageIDs should be empty.
	final, err := s.RemoveRef(ctx, "att-ref", "msg-B")
	if err != nil {
		t.Fatalf("RemoveRef last: %v", err)
	}
	if len(final.MessageIDs) != 0 {
		t.Errorf("after remove last, MessageIDs len = %d, want 0", len(final.MessageIDs))
	}
}

func TestAttachmentStore_AddRef_NotFound(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewAttachmentStore(db)
	ctx := context.Background()

	err := s.AddRef(ctx, "att-ghost", "msg-x")
	if err == nil {
		t.Error("expected error adding ref to nonexistent attachment")
	}
}

func TestAttachmentStore_RemoveRef_NotFound(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewAttachmentStore(db)
	ctx := context.Background()

	_, err := s.RemoveRef(ctx, "att-ghost", "msg-x")
	if err == nil {
		t.Error("expected error removing ref from nonexistent attachment")
	}
}

func TestAttachmentStore_Delete(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewAttachmentStore(db)
	ctx := context.Background()

	a := makeAttachment("att-del", "hash-del", "del.png")
	if err := s.Create(ctx, a); err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := s.Delete(ctx, "att-del"); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	_, err := s.GetByID(ctx, "att-del")
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound after delete, got %v", err)
	}
}

func TestAttachmentStore_Delete_Idempotent(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewAttachmentStore(db)
	ctx := context.Background()

	if err := s.Delete(ctx, "att-no-such"); err != nil {
		t.Errorf("expected no error deleting nonexistent attachment, got %v", err)
	}
}

func TestAttachmentStore_SetDimensions(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewAttachmentStore(db)
	ctx := context.Background()

	a := makeAttachment("att-dims", "hash-dims", "dims.png")
	if err := s.Create(ctx, a); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := s.SetDimensions(ctx, a.ID, 640, 480); err != nil {
		t.Fatalf("SetDimensions: %v", err)
	}
	got, err := s.GetByID(ctx, a.ID)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if got.Width != 640 || got.Height != 480 {
		t.Fatalf("dimensions = %dx%d, want 640x480", got.Width, got.Height)
	}
	if err := s.SetDimensions(ctx, "att-missing", 1, 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing SetDimensions err = %v, want ErrNotFound", err)
	}
}

func TestAttachmentStore_SetThumbnailKeys(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewAttachmentStore(db)
	ctx := context.Background()

	a := makeAttachment("att-thumbs", "hash-thumbs", "thumbs.png")
	if err := s.Create(ctx, a); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := s.SetThumbnailKeys(ctx, a.ID, "attachments/att-thumbs/thumb-message@2x.webp", "attachments/att-thumbs/thumb-square@2x.webp"); err != nil {
		t.Fatalf("SetThumbnailKeys: %v", err)
	}
	got, err := s.GetByID(ctx, a.ID)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if got.ThumbnailS3Key != "attachments/att-thumbs/thumb-message@2x.webp" {
		t.Fatalf("ThumbnailS3Key = %q", got.ThumbnailS3Key)
	}
	if got.SquareThumbnailS3Key != "attachments/att-thumbs/thumb-square@2x.webp" {
		t.Fatalf("SquareThumbnailS3Key = %q", got.SquareThumbnailS3Key)
	}
	if err := s.SetThumbnailKeys(ctx, "att-missing", "thumb", "square"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing SetThumbnailKeys err = %v, want ErrNotFound", err)
	}
}

func TestAttachmentStore_KeyHelpers(t *testing.T) {
	if got := attachmentPK("a1"); got != "ATT#a1" {
		t.Errorf("attachmentPK = %q, want %q", got, "ATT#a1")
	}
	if got := attHashGSI1PK("h1"); got != "ATTHASH#h1" {
		t.Errorf("attHashGSI1PK = %q, want %q", got, "ATTHASH#h1")
	}
}

// ============================================================================
// Attachment Store: error paths against missing table
// ============================================================================

func TestAttachmentStore_NonexistentTable(t *testing.T) {
	db := brokenDB(t)
	s := NewAttachmentStore(db)
	ctx := context.Background()

	a := makeAttachment("att-bk", "hash-bk", "bk.png")
	if err := s.Create(ctx, a); err == nil {
		t.Error("Create: expected error on missing table")
	}
	if _, err := s.GetByID(ctx, "att-bk"); err == nil {
		t.Error("GetByID: expected error")
	}
	if _, err := s.GetByHash(ctx, "hash-bk"); err == nil {
		t.Error("GetByHash: expected error")
	}
	if err := s.AddRef(ctx, "att-bk", "msg-x"); err == nil {
		t.Error("AddRef: expected error")
	}
	if _, err := s.RemoveRef(ctx, "att-bk", "msg-x"); err == nil {
		t.Error("RemoveRef: expected error")
	}
	if err := s.SetDimensions(ctx, "att-bk", 1, 1); err == nil {
		t.Error("SetDimensions: expected error")
	}
	if err := s.Delete(ctx, "att-bk"); err == nil {
		t.Error("Delete: expected error")
	}
}

// ============================================================================
// Emoji Store Tests
// ============================================================================

func makeEmoji(name string) *model.CustomEmoji {
	return &model.CustomEmoji{
		Name:      name,
		ImageURL:  "https://cdn.example.com/" + name + ".png",
		ImageKey:  "emoji/" + name,
		CreatedBy: "u-creator",
		CreatedAt: time.Now().Truncate(time.Millisecond),
	}
}

func TestEmojiStore_CreateAndGet(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewEmojiStore(db)
	ctx := context.Background()

	e := makeEmoji("partyparrot")
	if err := s.Create(ctx, e); err != nil {
		t.Fatalf("Create: %v", err)
	}

	got, err := s.GetByName(ctx, "partyparrot")
	if err != nil {
		t.Fatalf("GetByName: %v", err)
	}
	if got.Name != "partyparrot" {
		t.Errorf("Name = %q, want %q", got.Name, "partyparrot")
	}
	if got.CreatedBy != "u-creator" {
		t.Errorf("CreatedBy = %q, want %q", got.CreatedBy, "u-creator")
	}
}

func TestEmojiStore_GetByName_NotFound(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewEmojiStore(db)
	ctx := context.Background()

	_, err := s.GetByName(ctx, "no-such-emoji")
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestEmojiStore_Create_Duplicate(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewEmojiStore(db)
	ctx := context.Background()

	e := makeEmoji("dup-emoji")
	if err := s.Create(ctx, e); err != nil {
		t.Fatalf("Create first: %v", err)
	}
	err := s.Create(ctx, e)
	if !errors.Is(err, ErrAlreadyExists) {
		t.Errorf("expected ErrAlreadyExists, got %v", err)
	}
}

func TestEmojiStore_List(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewEmojiStore(db)
	ctx := context.Background()

	for i := 0; i < 3; i++ {
		e := makeEmoji(fmt.Sprintf("emoji-list-%d", i))
		if err := s.Create(ctx, e); err != nil {
			t.Fatalf("Create %d: %v", i, err)
		}
	}

	all, err := s.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(all) < 3 {
		t.Errorf("expected at least 3 emojis, got %d", len(all))
	}
}

// TestEmojiStore_List_PaginatesAcrossDDBPages verifies List doesn't
// silently drop emojis when DynamoDB returns more than one Query
// page. We force pagination by creating enough rows that a single
// Query response will be split — the bug manifested in production as
// reactions rendering as text because the catalog returned without
// the matching shortcode. Setting the test ExclusiveStartKey-style
// pagination directly is brittle; the pragmatic check is to insert a
// large catalog and assert all rows come back.
func TestEmojiStore_List_PaginatesAcrossDDBPages(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewEmojiStore(db)
	ctx := context.Background()

	const total = 250
	for i := 0; i < total; i++ {
		// Long padded body so each item is several KB, pushing the
		// total comfortably beyond DDB's per-page response cap when
		// repeated across the catalog.
		e := makeEmoji(fmt.Sprintf("paginated-emoji-%04d", i))
		e.ImageURL = fmt.Sprintf("https://example.test/%s/%s", e.Name,
			strings.Repeat("x", 4096))
		if err := s.Create(ctx, e); err != nil {
			t.Fatalf("Create %d: %v", i, err)
		}
	}

	all, err := s.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	got := 0
	seen := make(map[string]bool, len(all))
	for _, e := range all {
		if strings.HasPrefix(e.Name, "paginated-emoji-") {
			got++
			seen[e.Name] = true
		}
	}
	if got != total {
		t.Errorf("List returned %d paginated emojis, want %d", got, total)
	}
	for i := 0; i < total; i++ {
		name := fmt.Sprintf("paginated-emoji-%04d", i)
		if !seen[name] {
			t.Errorf("emoji %q missing from List result — pagination dropped it", name)
			break
		}
	}
}

func TestChannelStore_ListAll_ReturnsPublicAndPrivate(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewChannelStore(db)
	ctx := context.Background()

	pub := &model.Channel{ID: "ch-listall-pub", Name: "pub", Slug: "pub", Type: model.ChannelTypePublic, CreatedAt: time.Now()}
	priv := &model.Channel{ID: "ch-listall-priv", Name: "priv", Slug: "priv", Type: model.ChannelTypePrivate, CreatedAt: time.Now()}
	if err := s.Create(ctx, pub); err != nil {
		t.Fatalf("Create pub: %v", err)
	}
	if err := s.Create(ctx, priv); err != nil {
		t.Fatalf("Create priv: %v", err)
	}
	all, err := s.ListAll(ctx)
	if err != nil {
		t.Fatalf("ListAll: %v", err)
	}
	seen := map[string]bool{}
	for _, c := range all {
		seen[c.ID] = true
	}
	if !seen[pub.ID] || !seen[priv.ID] {
		t.Errorf("ListAll missed channel(s): seen=%v", seen)
	}
}

func TestAttachmentStore_ListAll(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewAttachmentStore(db)
	ctx := context.Background()

	a1 := makeAttachment("att-listall-1", "hash-la1", "one.png")
	a2 := makeAttachment("att-listall-2", "hash-la2", "two.pdf")
	if err := s.Create(ctx, a1); err != nil {
		t.Fatalf("Create a1: %v", err)
	}
	if err := s.Create(ctx, a2); err != nil {
		t.Fatalf("Create a2: %v", err)
	}
	// a1 keeps a ref; a2 stays orphaned (empty MessageIDs) — the shape the
	// relink migration scans for.
	if err := s.AddRef(ctx, a1.ID, "m-owner"); err != nil {
		t.Fatalf("AddRef: %v", err)
	}

	all, err := s.ListAll(ctx)
	if err != nil {
		t.Fatalf("ListAll: %v", err)
	}
	byID := map[string]*model.Attachment{}
	for _, a := range all {
		byID[a.ID] = a
	}
	if byID[a1.ID] == nil || byID[a2.ID] == nil {
		t.Fatalf("ListAll missed attachment(s): got %v", byID)
	}
	if len(byID[a1.ID].MessageIDs) != 1 {
		t.Errorf("a1 MessageIDs = %v, want one ref", byID[a1.ID].MessageIDs)
	}
	if len(byID[a2.ID].MessageIDs) != 0 {
		t.Errorf("a2 should be orphaned, got MessageIDs = %v", byID[a2.ID].MessageIDs)
	}
}

func TestConversationStore_ListAll(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewConversationStore(db)
	ctx := context.Background()
	conv := &model.Conversation{
		ID:             "conv-listall-1",
		Type:           model.ConversationTypeDM,
		ParticipantIDs: []string{"u-1", "u-2"},
		CreatedAt:      time.Now(),
	}
	members := []*model.UserConversation{
		{UserID: "u-1", ConversationID: conv.ID, JoinedAt: time.Now()},
		{UserID: "u-2", ConversationID: conv.ID, JoinedAt: time.Now()},
	}
	if err := s.Create(ctx, conv, members); err != nil {
		t.Fatalf("Create: %v", err)
	}
	all, err := s.ListAll(ctx)
	if err != nil {
		t.Fatalf("ListAll: %v", err)
	}
	found := false
	for _, c := range all {
		if c.ID == conv.ID {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("ListAll missed conversation %q", conv.ID)
	}
}

func TestEmojiStore_List_Empty(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewEmojiStore(db)
	ctx := context.Background()

	all, err := s.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(all) != 0 {
		t.Errorf("expected 0 emojis on empty table, got %d", len(all))
	}
}

func TestEmojiStore_Delete(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewEmojiStore(db)
	ctx := context.Background()

	e := makeEmoji("emoji-del")
	if err := s.Create(ctx, e); err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := s.Delete(ctx, "emoji-del"); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	_, err := s.GetByName(ctx, "emoji-del")
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound after delete, got %v", err)
	}
}

func TestEmojiStore_Delete_Idempotent(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewEmojiStore(db)
	ctx := context.Background()

	if err := s.Delete(ctx, "no-such-emoji"); err != nil {
		t.Errorf("expected no error deleting nonexistent emoji, got %v", err)
	}
}

func TestEmojiStore_KeyHelpers(t *testing.T) {
	if got := emojiPK(); got != "EMOJI" {
		t.Errorf("emojiPK = %q, want %q", got, "EMOJI")
	}
	if got := emojiSK("foo"); got != "NAME#foo" {
		t.Errorf("emojiSK = %q, want %q", got, "NAME#foo")
	}
}

func TestEmojiStore_NonexistentTable(t *testing.T) {
	db := brokenDB(t)
	s := NewEmojiStore(db)
	ctx := context.Background()

	e := makeEmoji("emoji-bk")
	if err := s.Create(ctx, e); err == nil {
		t.Error("Create: expected error")
	}
	if _, err := s.GetByName(ctx, "emoji-bk"); err == nil {
		t.Error("GetByName: expected error")
	}
	if _, err := s.List(ctx); err == nil {
		t.Error("List: expected error")
	}
	if err := s.Delete(ctx, "emoji-bk"); err == nil {
		t.Error("Delete: expected error")
	}
}

// ============================================================================
// Settings Store Tests
// ============================================================================

func TestSettingsStore_GetSettings_NotFound(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewSettingsStore(db)
	ctx := context.Background()

	_, err := s.GetSettings(ctx)
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound on empty table, got %v", err)
	}
}

func TestSettingsStore_PutAndGet(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewSettingsStore(db)
	ctx := context.Background()

	ws := &model.WorkspaceSettings{
		MaxUploadBytes:    10 * 1024 * 1024,
		AllowedExtensions: []string{"png", "jpg", "pdf"},
	}
	if err := s.PutSettings(ctx, ws); err != nil {
		t.Fatalf("PutSettings: %v", err)
	}

	got, err := s.GetSettings(ctx)
	if err != nil {
		t.Fatalf("GetSettings: %v", err)
	}
	if got.MaxUploadBytes != ws.MaxUploadBytes {
		t.Errorf("MaxUploadBytes = %d, want %d", got.MaxUploadBytes, ws.MaxUploadBytes)
	}
	if len(got.AllowedExtensions) != 3 {
		t.Errorf("AllowedExtensions len = %d, want 3", len(got.AllowedExtensions))
	}
}

func TestSettingsStore_PutSettings_Overwrites(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewSettingsStore(db)
	ctx := context.Background()

	first := &model.WorkspaceSettings{MaxUploadBytes: 1, AllowedExtensions: []string{"png"}}
	if err := s.PutSettings(ctx, first); err != nil {
		t.Fatalf("PutSettings first: %v", err)
	}
	second := &model.WorkspaceSettings{MaxUploadBytes: 2, AllowedExtensions: []string{"jpg"}}
	if err := s.PutSettings(ctx, second); err != nil {
		t.Fatalf("PutSettings second: %v", err)
	}

	got, err := s.GetSettings(ctx)
	if err != nil {
		t.Fatalf("GetSettings: %v", err)
	}
	if got.MaxUploadBytes != 2 {
		t.Errorf("MaxUploadBytes = %d, want 2 (second write should win)", got.MaxUploadBytes)
	}
	if len(got.AllowedExtensions) != 1 || got.AllowedExtensions[0] != "jpg" {
		t.Errorf("AllowedExtensions = %v, want [jpg]", got.AllowedExtensions)
	}
}

func TestSettingsStore_PutSettings_Nil(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewSettingsStore(db)
	ctx := context.Background()

	err := s.PutSettings(ctx, nil)
	if err == nil {
		t.Error("expected error on nil settings")
	}
}

func TestSettingsStore_KeyHelpers(t *testing.T) {
	if got := settingsPK(); got != "SETTINGS" {
		t.Errorf("settingsPK = %q, want %q", got, "SETTINGS")
	}
	if got := settingsSK(); got != "WORKSPACE" {
		t.Errorf("settingsSK = %q, want %q", got, "WORKSPACE")
	}
}

func TestSettingsStore_NonexistentTable(t *testing.T) {
	db := brokenDB(t)
	s := NewSettingsStore(db)
	ctx := context.Background()

	if _, err := s.GetSettings(ctx); err == nil {
		t.Error("GetSettings: expected error")
	}
	ws := &model.WorkspaceSettings{MaxUploadBytes: 1}
	if err := s.PutSettings(ctx, ws); err == nil {
		t.Error("PutSettings: expected error")
	}
}

// ============================================================================
// Conversation Store: Activate
// ============================================================================

func TestConversationStore_Activate(t *testing.T) {
	db := setupDynamoDB(t)
	cs := NewConversationStore(db)
	ctx := context.Background()

	conv := &model.Conversation{
		ID:             "conv-act",
		Type:           model.ConversationTypeDM,
		ParticipantIDs: []string{"u-act-a", "u-act-b"},
		CreatedBy:      "u-act-a",
		CreatedAt:      time.Now().Truncate(time.Millisecond),
		UpdatedAt:      time.Now().Truncate(time.Millisecond),
	}
	members := []*model.UserConversation{
		{
			UserID:         "u-act-a",
			ConversationID: "conv-act",
			Type:           model.ConversationTypeDM,
			DisplayName:    "User B",
			JoinedAt:       time.Now().Truncate(time.Millisecond),
		},
		{
			UserID:         "u-act-b",
			ConversationID: "conv-act",
			Type:           model.ConversationTypeDM,
			DisplayName:    "User A",
			JoinedAt:       time.Now().Truncate(time.Millisecond),
		},
	}
	if err := cs.Create(ctx, conv, members); err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := cs.Activate(ctx, "conv-act", []string{"u-act-a", "u-act-b"}); err != nil {
		t.Fatalf("Activate: %v", err)
	}

	got, err := cs.GetByID(ctx, "conv-act")
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if !got.Activated {
		t.Error("expected Conversation.Activated=true after Activate")
	}

	userConvs, err := cs.ListUserConversations(ctx, "u-act-b")
	if err != nil {
		t.Fatalf("ListUserConversations: %v", err)
	}
	if len(userConvs) != 1 {
		t.Fatalf("expected 1 user conversation, got %d", len(userConvs))
	}
	if !userConvs[0].Activated {
		t.Error("expected UserConversation.Activated=true after Activate")
	}
}

func TestConversationStore_Touch(t *testing.T) {
	db := setupDynamoDB(t)
	cs := NewConversationStore(db)
	ctx := context.Background()

	initial := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	touchedAt := time.Now().Truncate(time.Millisecond)
	conv := &model.Conversation{
		ID:             "conv-touch",
		Type:           model.ConversationTypeDM,
		ParticipantIDs: []string{"u-touch-a", "u-touch-b"},
		CreatedBy:      "u-touch-a",
		CreatedAt:      initial,
		UpdatedAt:      initial,
	}
	members := []*model.UserConversation{
		{UserID: "u-touch-a", ConversationID: "conv-touch", Type: model.ConversationTypeDM, DisplayName: "User B", JoinedAt: initial, UpdatedAt: initial},
		{UserID: "u-touch-b", ConversationID: "conv-touch", Type: model.ConversationTypeDM, DisplayName: "User A", JoinedAt: initial, UpdatedAt: initial},
	}
	if err := cs.Create(ctx, conv, members); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := cs.Touch(ctx, conv.ID, conv.ParticipantIDs, touchedAt); err != nil {
		t.Fatalf("Touch: %v", err)
	}
	got, err := cs.GetByID(ctx, conv.ID)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if !got.UpdatedAt.Equal(touchedAt) {
		t.Fatalf("conversation UpdatedAt = %s, want %s", got.UpdatedAt, touchedAt)
	}
	userConvs, err := cs.ListUserConversations(ctx, "u-touch-a")
	if err != nil {
		t.Fatalf("ListUserConversations: %v", err)
	}
	if len(userConvs) != 1 || !userConvs[0].UpdatedAt.Equal(touchedAt) {
		t.Fatalf("user conversation UpdatedAt = %+v, want %s", userConvs, touchedAt)
	}
	if err := cs.Touch(ctx, "conv-missing", []string{"u-touch-a"}, touchedAt); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing Touch err = %v, want ErrNotFound", err)
	}
}

func TestConversationStore_Activate_NonexistentTable(t *testing.T) {
	db := brokenDB(t)
	cs := NewConversationStore(db)
	ctx := context.Background()

	err := cs.Activate(ctx, "conv-x", []string{"u-a", "u-b"})
	if err == nil {
		t.Error("expected error on missing table")
	}
}

// ============================================================================
// Membership Store: SetUserChannelMute
// ============================================================================

func TestMembershipStore_SetUserChannelMute(t *testing.T) {
	db := setupDynamoDB(t)
	ms := NewMembershipStore(db)
	cs := NewChannelStore(db)
	ctx := context.Background()

	ch := makeChannel("ch-mute", "mute", "mute-slug", model.ChannelTypePublic)
	if err := cs.Create(ctx, ch); err != nil {
		t.Fatalf("Create channel: %v", err)
	}

	member := &model.ChannelMembership{
		ChannelID: "ch-mute",
		UserID:    "u-mute",
		Role:      model.ChannelRoleMember,
		JoinedAt:  time.Now().Truncate(time.Millisecond),
	}
	userChan := &model.UserChannel{
		UserID:    "u-mute",
		ChannelID: "ch-mute",
		Role:      model.ChannelRoleMember,
		JoinedAt:  time.Now().Truncate(time.Millisecond),
	}
	if err := ms.AddChannelMember(ctx, ch, member, userChan); err != nil {
		t.Fatalf("AddChannelMember: %v", err)
	}

	// Mute.
	if err := ms.SetUserChannelMute(ctx, "ch-mute", "u-mute", true); err != nil {
		t.Fatalf("SetUserChannelMute true: %v", err)
	}
	chans, err := ms.ListUserChannels(ctx, "u-mute")
	if err != nil {
		t.Fatalf("ListUserChannels: %v", err)
	}
	if len(chans) != 1 {
		t.Fatalf("expected 1 user channel, got %d", len(chans))
	}
	if !chans[0].Muted {
		t.Error("expected Muted=true after mute")
	}

	// Unmute.
	if err := ms.SetUserChannelMute(ctx, "ch-mute", "u-mute", false); err != nil {
		t.Fatalf("SetUserChannelMute false: %v", err)
	}
	chans, err = ms.ListUserChannels(ctx, "u-mute")
	if err != nil {
		t.Fatalf("ListUserChannels: %v", err)
	}
	if chans[0].Muted {
		t.Error("expected Muted=false after unmute")
	}
}

func TestMembershipStore_MutedUserIDs(t *testing.T) {
	db := setupDynamoDB(t)
	ms := NewMembershipStore(db)
	cs := NewChannelStore(db)
	ctx := context.Background()

	ch := makeChannel("ch-mm", "mm", "mm-slug", model.ChannelTypePublic)
	if err := cs.Create(ctx, ch); err != nil {
		t.Fatalf("Create channel: %v", err)
	}
	for _, uid := range []string{"u-mm-a", "u-mm-b"} {
		member := &model.ChannelMembership{ChannelID: "ch-mm", UserID: uid, Role: model.ChannelRoleMember, JoinedAt: time.Now()}
		userChan := &model.UserChannel{UserID: uid, ChannelID: "ch-mm", Role: model.ChannelRoleMember, JoinedAt: time.Now()}
		if err := ms.AddChannelMember(ctx, ch, member, userChan); err != nil {
			t.Fatalf("AddChannelMember %s: %v", uid, err)
		}
	}
	// Only u-mm-a mutes the channel.
	if err := ms.SetUserChannelMute(ctx, "ch-mm", "u-mm-a", true); err != nil {
		t.Fatalf("SetUserChannelMute: %v", err)
	}

	muted, err := ms.MutedUserIDs(ctx, "ch-mm", []string{"u-mm-a", "u-mm-b", "u-mm-absent"})
	if err != nil {
		t.Fatalf("MutedUserIDs: %v", err)
	}
	if !muted["u-mm-a"] {
		t.Error("expected u-mm-a muted")
	}
	if muted["u-mm-b"] {
		t.Error("u-mm-b did not mute the channel")
	}
	if muted["u-mm-absent"] {
		t.Error("a user with no membership row is never muted")
	}

	// Error path: a failing BatchGetItem surfaces the error.
	fs := NewMembershipStore(withFault(db, func(f *faultClient) { f.failBatchGetItem = true }))
	if _, err := fs.MutedUserIDs(ctx, "ch-mm", []string{"u-mm-a"}); !errors.Is(err, errInjected) {
		t.Fatalf("MutedUserIDs fault: want errInjected, got %v", err)
	}
}

func TestMembershipStore_SetUserChannelMute_NotFound(t *testing.T) {
	db := setupDynamoDB(t)
	ms := NewMembershipStore(db)
	ctx := context.Background()

	err := ms.SetUserChannelMute(ctx, "ch-ghost", "u-ghost", true)
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestMembershipStore_SetUserChannelMute_NonexistentTable(t *testing.T) {
	db := brokenDB(t)
	ms := NewMembershipStore(db)
	ctx := context.Background()

	err := ms.SetUserChannelMute(ctx, "ch-x", "u-x", true)
	if err == nil {
		t.Error("expected error on missing table")
	}
}

// ============================================================================
// Membership Store: SetUserChannelFavorite + SetUserChannelCategory
// ============================================================================

// TestMembershipStore_SetUserChannelFavorite covers the favorite-pin
// toggle for the sidebar "Favorites" section. Per-user — favoriting a
// channel does not change the channel-side membership row.
func TestMembershipStore_SetUserChannelFavorite(t *testing.T) {
	db := setupDynamoDB(t)
	ms := NewMembershipStore(db)
	cs := NewChannelStore(db)
	ctx := context.Background()

	ch := makeChannel("ch-fav", "fav", "fav-slug", model.ChannelTypePublic)
	if err := cs.Create(ctx, ch); err != nil {
		t.Fatalf("Create channel: %v", err)
	}
	now := time.Now().Truncate(time.Millisecond)
	member := &model.ChannelMembership{ChannelID: "ch-fav", UserID: "u-fav", Role: model.ChannelRoleMember, JoinedAt: now}
	userChan := &model.UserChannel{UserID: "u-fav", ChannelID: "ch-fav", Role: model.ChannelRoleMember, JoinedAt: now}
	if err := ms.AddChannelMember(ctx, ch, member, userChan); err != nil {
		t.Fatalf("AddChannelMember: %v", err)
	}

	if err := ms.SetUserChannelFavorite(ctx, "ch-fav", "u-fav", true); err != nil {
		t.Fatalf("SetUserChannelFavorite true: %v", err)
	}
	chans, err := ms.ListUserChannels(ctx, "u-fav")
	if err != nil {
		t.Fatalf("ListUserChannels: %v", err)
	}
	if len(chans) != 1 || !chans[0].Favorite {
		t.Errorf("expected Favorite=true after pin, got %+v", chans)
	}

	if err := ms.SetUserChannelFavorite(ctx, "ch-fav", "u-fav", false); err != nil {
		t.Fatalf("SetUserChannelFavorite false: %v", err)
	}
	chans, _ = ms.ListUserChannels(ctx, "u-fav")
	if chans[0].Favorite {
		t.Error("expected Favorite=false after unpin")
	}
}

// TestMembershipStore_SetUserChannelCategory covers assigning the channel
// to a sidebar category and clearing it back to the default group.
func TestMembershipStore_SetUserChannelCategory(t *testing.T) {
	db := setupDynamoDB(t)
	ms := NewMembershipStore(db)
	cs := NewChannelStore(db)
	ctx := context.Background()

	ch := makeChannel("ch-cat", "cat", "cat-slug", model.ChannelTypePublic)
	if err := cs.Create(ctx, ch); err != nil {
		t.Fatalf("Create channel: %v", err)
	}
	now := time.Now().Truncate(time.Millisecond)
	member := &model.ChannelMembership{ChannelID: "ch-cat", UserID: "u-cat", Role: model.ChannelRoleMember, JoinedAt: now}
	userChan := &model.UserChannel{UserID: "u-cat", ChannelID: "ch-cat", Role: model.ChannelRoleMember, JoinedAt: now}
	if err := ms.AddChannelMember(ctx, ch, member, userChan); err != nil {
		t.Fatalf("AddChannelMember: %v", err)
	}

	pos := 1200
	if err := ms.SetUserChannelCategory(ctx, "ch-cat", "u-cat", "cat-id-1", &pos); err != nil {
		t.Fatalf("SetUserChannelCategory: %v", err)
	}
	chans, _ := ms.ListUserChannels(ctx, "u-cat")
	if len(chans) != 1 || chans[0].CategoryID != "cat-id-1" {
		t.Errorf("expected CategoryID=cat-id-1, got %+v", chans)
	}
	if chans[0].SidebarPosition != pos {
		t.Errorf("expected SidebarPosition=%d, got %+v", pos, chans)
	}

	// Clearing back to the empty string is the "remove from category" path.
	if err := ms.SetUserChannelCategory(ctx, "ch-cat", "u-cat", "", nil); err != nil {
		t.Fatalf("SetUserChannelCategory clear: %v", err)
	}
	chans, _ = ms.ListUserChannels(ctx, "u-cat")
	if chans[0].CategoryID != "" {
		t.Errorf("expected empty CategoryID after clear, got %q", chans[0].CategoryID)
	}
}

// TestMembershipStore_SetUserChannelFavorite_NotFound exercises the
// attribute_exists guard that turns missing rows into ErrNotFound.
func TestMembershipStore_SetUserChannelFavorite_NotFound(t *testing.T) {
	db := setupDynamoDB(t)
	ms := NewMembershipStore(db)
	ctx := context.Background()

	if err := ms.SetUserChannelFavorite(ctx, "ch-ghost", "u-ghost", true); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
	if err := ms.SetUserChannelCategory(ctx, "ch-ghost", "u-ghost", "cat", nil); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

// TestMembershipStore_SetUserChannelFavorite_NonexistentTable covers the
// non-condition error path so the wrap-and-return branch is hit.
func TestMembershipStore_SetUserChannelFavorite_NonexistentTable(t *testing.T) {
	db := brokenDB(t)
	ms := NewMembershipStore(db)
	ctx := context.Background()

	if err := ms.SetUserChannelFavorite(ctx, "ch-x", "u-x", true); err == nil {
		t.Error("expected error on missing table")
	}
	if err := ms.SetUserChannelCategory(ctx, "ch-x", "u-x", "c", nil); err == nil {
		t.Error("expected error on missing table")
	}
}

// ============================================================================
// Conversation Store: SetUserConversationFavorite + SetUserConversationCategory
// ============================================================================

// makeConv constructs a DM conversation with two participants for the
// favorite/category tests below.
func makeConv(id, a, b string) (*model.Conversation, []*model.UserConversation) {
	now := time.Now().Truncate(time.Millisecond)
	conv := &model.Conversation{
		ID:             id,
		Type:           model.ConversationTypeDM,
		ParticipantIDs: []string{a, b},
		CreatedBy:      a,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	members := []*model.UserConversation{
		{UserID: a, ConversationID: id, Type: model.ConversationTypeDM, JoinedAt: now},
		{UserID: b, ConversationID: id, Type: model.ConversationTypeDM, JoinedAt: now},
	}
	return conv, members
}

func TestConversationStore_SetUserConversationFavorite(t *testing.T) {
	db := setupDynamoDB(t)
	cs := NewConversationStore(db)
	ctx := context.Background()

	conv, members := makeConv("conv-fav", "u-cf-a", "u-cf-b")
	if err := cs.Create(ctx, conv, members); err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := cs.SetUserConversationFavorite(ctx, "conv-fav", "u-cf-a", true); err != nil {
		t.Fatalf("SetUserConversationFavorite true: %v", err)
	}
	got, err := cs.ListUserConversations(ctx, "u-cf-a")
	if err != nil {
		t.Fatalf("ListUserConversations: %v", err)
	}
	if len(got) != 1 || !got[0].Favorite {
		t.Errorf("expected Favorite=true, got %+v", got)
	}
	// The other participant should be unaffected.
	gotB, _ := cs.ListUserConversations(ctx, "u-cf-b")
	if len(gotB) != 1 || gotB[0].Favorite {
		t.Errorf("other participant's Favorite must remain false: %+v", gotB)
	}

	if err := cs.SetUserConversationFavorite(ctx, "conv-fav", "u-cf-a", false); err != nil {
		t.Fatalf("SetUserConversationFavorite false: %v", err)
	}
	got, _ = cs.ListUserConversations(ctx, "u-cf-a")
	if got[0].Favorite {
		t.Error("expected Favorite=false after unpin")
	}
}

func TestConversationStore_SetUserConversationCategory(t *testing.T) {
	db := setupDynamoDB(t)
	cs := NewConversationStore(db)
	ctx := context.Background()

	conv, members := makeConv("conv-cat", "u-cc-a", "u-cc-b")
	if err := cs.Create(ctx, conv, members); err != nil {
		t.Fatalf("Create: %v", err)
	}

	pos := 2400
	if err := cs.SetUserConversationCategory(ctx, "conv-cat", "u-cc-a", "cat-conv-1", &pos); err != nil {
		t.Fatalf("SetUserConversationCategory: %v", err)
	}
	got, err := cs.ListUserConversations(ctx, "u-cc-a")
	if err != nil {
		t.Fatalf("ListUserConversations: %v", err)
	}
	if len(got) != 1 || got[0].CategoryID != "cat-conv-1" {
		t.Errorf("expected CategoryID=cat-conv-1, got %+v", got)
	}
	if got[0].SidebarPosition != pos {
		t.Errorf("expected SidebarPosition=%d, got %+v", pos, got)
	}

	if err := cs.SetUserConversationCategory(ctx, "conv-cat", "u-cc-a", "", nil); err != nil {
		t.Fatalf("SetUserConversationCategory clear: %v", err)
	}
	got, _ = cs.ListUserConversations(ctx, "u-cc-a")
	if got[0].CategoryID != "" {
		t.Errorf("expected empty CategoryID after clear, got %q", got[0].CategoryID)
	}
}

func TestConversationStore_SetUserConversationFavorite_NotFound(t *testing.T) {
	db := setupDynamoDB(t)
	cs := NewConversationStore(db)
	ctx := context.Background()

	if err := cs.SetUserConversationFavorite(ctx, "conv-ghost", "u-ghost", true); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
	if err := cs.SetUserConversationCategory(ctx, "conv-ghost", "u-ghost", "x", nil); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestConversationStore_SetUserConversationFavorite_NonexistentTable(t *testing.T) {
	db := brokenDB(t)
	cs := NewConversationStore(db)
	ctx := context.Background()

	if err := cs.SetUserConversationFavorite(ctx, "conv-x", "u-x", true); err == nil {
		t.Error("expected error on missing table")
	}
	if err := cs.SetUserConversationCategory(ctx, "conv-x", "u-x", "c", nil); err == nil {
		t.Error("expected error on missing table")
	}
}

func TestThreadFollowStore_SetGetAndList(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewThreadFollowStore(db)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)

	follow := &model.ThreadFollow{
		UserID: "u-1", ParentID: "ch-1", ParentType: "channel", ThreadRootID: "root-1", Following: true, UpdatedAt: now,
	}
	if err := s.Set(ctx, follow); err != nil {
		t.Fatalf("Set: %v", err)
	}
	unfollow := &model.ThreadFollow{
		UserID: "u-2", ParentID: "ch-1", ParentType: "channel", ThreadRootID: "root-1", Following: false, UpdatedAt: now.Add(time.Second),
	}
	if err := s.Set(ctx, unfollow); err != nil {
		t.Fatalf("Set unfollow: %v", err)
	}

	got, err := s.Get(ctx, "u-1", "ch-1", "root-1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !got.Following || got.ParentType != "channel" {
		t.Fatalf("unexpected follow: %+v", got)
	}

	userRows, err := s.ListUser(ctx, "u-1")
	if err != nil {
		t.Fatalf("ListUser: %v", err)
	}
	if len(userRows) != 1 || userRows[0].ThreadRootID != "root-1" {
		t.Fatalf("ListUser = %+v, want one root-1 row", userRows)
	}

	threadRows, err := s.ListThread(ctx, "ch-1", "root-1")
	if err != nil {
		t.Fatalf("ListThread: %v", err)
	}
	if len(threadRows) != 2 {
		t.Fatalf("ListThread count = %d, want 2", len(threadRows))
	}
	byUser := map[string]bool{}
	for _, row := range threadRows {
		byUser[row.UserID] = row.Following
	}
	if byUser["u-1"] != true || byUser["u-2"] != false {
		t.Fatalf("ListThread rows = %+v", threadRows)
	}
}

func TestThreadFollowStore_GetNotFound(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewThreadFollowStore(db)
	_, err := s.Get(context.Background(), "u-missing", "ch-1", "root-1")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get missing error = %v, want ErrNotFound", err)
	}
}

func TestUserStateStore_SetListDelete(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewUserStateStore(db)
	ctx := context.Background()
	seenAt := time.Now().UTC().Truncate(time.Millisecond)

	if err := s.Set(ctx, &model.UserStateItem{
		UserID: "u-1", Kind: model.UserStateChannelNotification, TargetID: "ch-1", UpdatedAt: seenAt,
	}); err != nil {
		t.Fatalf("Set channel notification: %v", err)
	}
	if err := s.Set(ctx, &model.UserStateItem{
		UserID: "u-1", Kind: model.UserStateThreadSeen, TargetID: "root-1", ParentID: "ch-1", ParentType: "channel", ThreadRootID: "root-1", SeenAt: &seenAt, UpdatedAt: seenAt,
	}); err != nil {
		t.Fatalf("Set thread seen: %v", err)
	}

	rows, err := s.List(ctx, "u-1")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("List count = %d, want 2", len(rows))
	}
	if err := s.Delete(ctx, "u-1", model.UserStateChannelNotification, "ch-1"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	rows, err = s.List(ctx, "u-1")
	if err != nil {
		t.Fatalf("List after delete: %v", err)
	}
	if len(rows) != 1 || rows[0].Kind != model.UserStateThreadSeen {
		t.Fatalf("rows after delete = %+v", rows)
	}
	if got := userStateKindFromSK("STATE#thread_seen#root-1"); got != model.UserStateThreadSeen {
		t.Fatalf("userStateKindFromSK = %q", got)
	}
	if got := userStateKindFromSK("bad"); got != "" {
		t.Fatalf("userStateKindFromSK bad = %q", got)
	}
}

func TestUserStateStore_NonexistentTableErrors(t *testing.T) {
	s := NewUserStateStore(brokenDB(t))
	ctx := context.Background()
	if err := s.Set(ctx, &model.UserStateItem{UserID: "u", Kind: model.UserStateHiddenConversation, TargetID: "conv"}); err == nil {
		t.Fatal("expected Set error")
	}
	if err := s.Delete(ctx, "u", model.UserStateHiddenConversation, "conv"); err == nil {
		t.Fatal("expected Delete error")
	}
	if _, err := s.List(ctx, "u"); err == nil {
		t.Fatal("expected List error")
	}
}

func TestThreadFollowStore_EmptyListsAndNonexistentTable(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewThreadFollowStore(db)
	ctx := context.Background()

	userRows, err := s.ListUser(ctx, "u-empty")
	if err != nil {
		t.Fatalf("ListUser empty: %v", err)
	}
	if len(userRows) != 0 {
		t.Fatalf("ListUser empty len = %d, want 0", len(userRows))
	}
	threadRows, err := s.ListThread(ctx, "ch-empty", "root-empty")
	if err != nil {
		t.Fatalf("ListThread empty: %v", err)
	}
	if len(threadRows) != 0 {
		t.Fatalf("ListThread empty len = %d, want 0", len(threadRows))
	}

	broken := NewThreadFollowStore(&DB{Client: db.Client, Table: "missing-thread-follow-table"})
	if err := broken.Set(ctx, &model.ThreadFollow{
		UserID: "u-1", ParentID: "ch-1", ParentType: "channel", ThreadRootID: "root-1", Following: true, UpdatedAt: time.Now(),
	}); err == nil {
		t.Fatal("Set on nonexistent table: expected error")
	}
	if _, err := broken.Get(ctx, "u-1", "ch-1", "root-1"); err == nil {
		t.Fatal("Get on nonexistent table: expected error")
	}
	if _, err := broken.ListUser(ctx, "u-1"); err == nil {
		t.Fatal("ListUser on nonexistent table: expected error")
	}
	if _, err := broken.ListThread(ctx, "ch-1", "root-1"); err == nil {
		t.Fatal("ListThread on nonexistent table: expected error")
	}
}

func TestThreadFollowStore_SetMany(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewThreadFollowStore(db)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)

	// Empty input is a no-op (no DDB call) — we should not error.
	if err := s.SetMany(ctx, nil); err != nil {
		t.Fatalf("SetMany(nil): %v", err)
	}

	follows := []*model.ThreadFollow{
		{UserID: "u-a", ParentID: "ch-1", ParentType: "channel", ThreadRootID: "root-1", Following: true, UpdatedAt: now},
		{UserID: "u-b", ParentID: "ch-1", ParentType: "channel", ThreadRootID: "root-1", Following: true, UpdatedAt: now},
		{UserID: "u-c", ParentID: "ch-1", ParentType: "channel", ThreadRootID: "root-1", Following: true, UpdatedAt: now},
	}
	if err := s.SetMany(ctx, follows); err != nil {
		t.Fatalf("SetMany: %v", err)
	}

	rows, err := s.ListThread(ctx, "ch-1", "root-1")
	if err != nil {
		t.Fatalf("ListThread: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("ListThread count = %d, want 3", len(rows))
	}
	seen := map[string]bool{}
	for _, r := range rows {
		seen[r.UserID] = r.Following
	}
	for _, id := range []string{"u-a", "u-b", "u-c"} {
		if !seen[id] {
			t.Errorf("expected %s to be persisted as following", id)
		}
	}
}

// Verify SetMany splits inputs larger than the 25-op DynamoDB
// BatchWriteItem cap into multiple chunks transparently.
func TestThreadFollowStore_SetMany_ChunksLargerThanBatchLimit(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewThreadFollowStore(db)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)

	const total = 30
	follows := make([]*model.ThreadFollow, 0, total)
	for i := 0; i < total; i++ {
		follows = append(follows, &model.ThreadFollow{
			UserID:       fmt.Sprintf("u-large-%02d", i),
			ParentID:     "ch-large",
			ParentType:   "channel",
			ThreadRootID: "root-large",
			Following:    true,
			UpdatedAt:    now,
		})
	}
	if err := s.SetMany(ctx, follows); err != nil {
		t.Fatalf("SetMany: %v", err)
	}

	rows, err := s.ListThread(ctx, "ch-large", "root-large")
	if err != nil {
		t.Fatalf("ListThread: %v", err)
	}
	if len(rows) != total {
		t.Errorf("persisted %d rows, want %d", len(rows), total)
	}
}

func TestParentIndexStore_PinIndexRoundTrip(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewParentIndexStore(db)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)

	if err := s.SetPinIndex(ctx, "ch-pin", "m-1", "u-bob", now); err != nil {
		t.Fatalf("SetPinIndex 1: %v", err)
	}
	if err := s.SetPinIndex(ctx, "ch-pin", "m-2", "u-bob", now.Add(time.Second)); err != nil {
		t.Fatalf("SetPinIndex 2: %v", err)
	}

	rows, err := s.ListPinIndex(ctx, "ch-pin")
	if err != nil {
		t.Fatalf("ListPinIndex: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(rows))
	}

	if err := s.DeletePinIndex(ctx, "ch-pin", "m-1"); err != nil {
		t.Fatalf("DeletePinIndex: %v", err)
	}
	rows, _ = s.ListPinIndex(ctx, "ch-pin")
	if len(rows) != 1 || rows[0].MessageID != "m-2" {
		t.Errorf("after delete: got %+v, want only m-2", rows)
	}
}

func TestParentIndexStore_FileIndexUpsertOnReshare(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewParentIndexStore(db)
	ctx := context.Background()
	earlier := time.Now().UTC().Truncate(time.Millisecond)
	later := earlier.Add(time.Minute)

	// Two messages share the same attachment (deduped by SHA upstream).
	// The second share must overwrite the first, so the row reflects
	// the most-recent message.
	if err := s.SetFileIndex(ctx, "ch-files", "att-x", "m-1", "u-alice", earlier); err != nil {
		t.Fatalf("SetFileIndex 1: %v", err)
	}
	if err := s.SetFileIndex(ctx, "ch-files", "att-x", "m-2", "u-bob", later); err != nil {
		t.Fatalf("SetFileIndex 2: %v", err)
	}

	rows, err := s.ListFileIndex(ctx, "ch-files")
	if err != nil {
		t.Fatalf("ListFileIndex: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1 (deduped on attachmentID)", len(rows))
	}
	if rows[0].MessageID != "m-2" {
		t.Errorf("expected newer share to win, got %+v", rows[0])
	}
	if rows[0].AuthorID != "u-bob" {
		t.Errorf("expected author of latest share, got %+v", rows[0])
	}
}

func TestParentIndexStore_FileIndexEmptyAttachmentRejected(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewParentIndexStore(db)
	if err := s.SetFileIndex(context.Background(), "ch-files", "", "m-1", "u-alice", time.Now()); err == nil {
		t.Fatal("expected error on empty attachmentID")
	}
}

func TestParentIndexStore_DeleteFileIndexRemovesRow(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewParentIndexStore(db)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)

	if err := s.SetFileIndex(ctx, "ch-del", "att-1", "m-1", "u-alice", now); err != nil {
		t.Fatalf("SetFileIndex: %v", err)
	}
	if err := s.SetFileIndex(ctx, "ch-del", "att-2", "m-1", "u-alice", now); err != nil {
		t.Fatalf("SetFileIndex att-2: %v", err)
	}
	if err := s.DeleteFileIndex(ctx, "ch-del", "att-1"); err != nil {
		t.Fatalf("DeleteFileIndex: %v", err)
	}
	rows, err := s.ListFileIndex(ctx, "ch-del")
	if err != nil {
		t.Fatalf("ListFileIndex: %v", err)
	}
	if len(rows) != 1 || rows[0].AttachmentID != "att-2" {
		t.Errorf("after delete: got %+v, want only att-2", rows)
	}
	// Deleting a nonexistent row must be a silent no-op.
	if err := s.DeleteFileIndex(ctx, "ch-del", "att-missing"); err != nil {
		t.Errorf("DeleteFileIndex nonexistent: %v", err)
	}
}

// Edit that adds new attachments must populate the FILE# index;
// edits that remove attachments must drop those FILE# rows. This
// covers the index branches in MessageService.Edit at the store
// layer (the service-level branches are already covered by the
// in-memory mock tests).
func TestParentIndexStore_EditAttachmentChangesAreRouted(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewParentIndexStore(db)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)

	// Initial share: m-x owns att-old.
	if err := s.SetFileIndex(ctx, "ch-edit", "att-old", "m-x", "u-bob", now); err != nil {
		t.Fatalf("SetFileIndex initial: %v", err)
	}
	// Edit replaces att-old → att-new.
	if err := s.SetFileIndex(ctx, "ch-edit", "att-new", "m-x", "u-bob", now); err != nil {
		t.Fatalf("SetFileIndex new: %v", err)
	}
	if err := s.DeleteFileIndex(ctx, "ch-edit", "att-old"); err != nil {
		t.Fatalf("DeleteFileIndex old: %v", err)
	}

	rows, err := s.ListFileIndex(ctx, "ch-edit")
	if err != nil {
		t.Fatalf("ListFileIndex: %v", err)
	}
	if len(rows) != 1 || rows[0].AttachmentID != "att-new" {
		t.Errorf("after edit: got %+v, want only att-new", rows)
	}
}

// Error-path coverage for ParentIndexStoreImpl: every method should
// return a wrapped error when the underlying table doesn't exist.
// Mirrors the TestThreadFollowStore_EmptyListsAndNonexistentTable
// pattern used elsewhere in this file.
func TestParentIndexStore_ErrorsOnNonexistentTable(t *testing.T) {
	db := setupDynamoDB(t)
	broken := NewParentIndexStore(&DB{Client: db.Client, Table: "missing-parent-index-table"})
	ctx := context.Background()
	now := time.Now()

	if err := broken.SetPinIndex(ctx, "ch", "m-1", "u", now); err == nil {
		t.Error("SetPinIndex on missing table: expected error")
	}
	if err := broken.DeletePinIndex(ctx, "ch", "m-1"); err == nil {
		t.Error("DeletePinIndex on missing table: expected error")
	}
	if _, err := broken.ListPinIndex(ctx, "ch"); err == nil {
		t.Error("ListPinIndex on missing table: expected error")
	}
	if err := broken.SetFileIndex(ctx, "ch", "att", "m-1", "u", now); err == nil {
		t.Error("SetFileIndex on missing table: expected error")
	}
	if err := broken.DeleteFileIndex(ctx, "ch", "att"); err == nil {
		t.Error("DeleteFileIndex on missing table: expected error")
	}
	if _, err := broken.ListFileIndex(ctx, "ch"); err == nil {
		t.Error("ListFileIndex on missing table: expected error")
	}

	// Empty-list reads against a real table should not error.
	live := NewParentIndexStore(db)
	if rows, err := live.ListPinIndex(ctx, "ch-empty"); err != nil || len(rows) != 0 {
		t.Errorf("ListPinIndex empty parent: rows=%+v err=%v", rows, err)
	}
	if rows, err := live.ListFileIndex(ctx, "ch-empty"); err != nil || len(rows) != 0 {
		t.Errorf("ListFileIndex empty parent: rows=%+v err=%v", rows, err)
	}
}
