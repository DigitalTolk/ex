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

	if err := ms.SetUserChannelCategory(ctx, "ch-cat", "u-cat", "cat-id-1"); err != nil {
		t.Fatalf("SetUserChannelCategory: %v", err)
	}
	chans, _ := ms.ListUserChannels(ctx, "u-cat")
	if len(chans) != 1 || chans[0].CategoryID != "cat-id-1" {
		t.Errorf("expected CategoryID=cat-id-1, got %+v", chans)
	}

	// Clearing back to the empty string is the "remove from category" path.
	if err := ms.SetUserChannelCategory(ctx, "ch-cat", "u-cat", ""); err != nil {
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
	if err := ms.SetUserChannelCategory(ctx, "ch-ghost", "u-ghost", "cat"); !errors.Is(err, ErrNotFound) {
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
	if err := ms.SetUserChannelCategory(ctx, "ch-x", "u-x", "c"); err == nil {
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

	if err := cs.SetUserConversationCategory(ctx, "conv-cat", "u-cc-a", "cat-conv-1"); err != nil {
		t.Fatalf("SetUserConversationCategory: %v", err)
	}
	got, err := cs.ListUserConversations(ctx, "u-cc-a")
	if err != nil {
		t.Fatalf("ListUserConversations: %v", err)
	}
	if len(got) != 1 || got[0].CategoryID != "cat-conv-1" {
		t.Errorf("expected CategoryID=cat-conv-1, got %+v", got)
	}

	if err := cs.SetUserConversationCategory(ctx, "conv-cat", "u-cc-a", ""); err != nil {
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
	if err := cs.SetUserConversationCategory(ctx, "conv-ghost", "u-ghost", "x"); !errors.Is(err, ErrNotFound) {
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
	if err := cs.SetUserConversationCategory(ctx, "conv-x", "u-x", "c"); err == nil {
		t.Error("expected error on missing table")
	}
}
