package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

type mockAttachmentStore struct {
	byID   map[string]*model.Attachment
	byHash map[string]*model.Attachment
	// refs[attID] is the set of message IDs referencing the attachment.
	refs map[string]map[string]bool
}

func newMockAttachmentStore() *mockAttachmentStore {
	return &mockAttachmentStore{
		byID:   map[string]*model.Attachment{},
		byHash: map[string]*model.Attachment{},
		refs:   map[string]map[string]bool{},
	}
}

func (m *mockAttachmentStore) Create(_ context.Context, a *model.Attachment) error {
	if _, ok := m.byID[a.ID]; ok {
		return store.ErrAlreadyExists
	}
	m.byID[a.ID] = a
	m.byHash[a.SHA256] = a
	return nil
}
func (m *mockAttachmentStore) GetByID(_ context.Context, id string) (*model.Attachment, error) {
	if a, ok := m.byID[id]; ok {
		return a, nil
	}
	return nil, store.ErrNotFound
}
func (m *mockAttachmentStore) GetByHash(_ context.Context, sha256 string) (*model.Attachment, error) {
	if a, ok := m.byHash[sha256]; ok {
		return a, nil
	}
	return nil, store.ErrNotFound
}
func (m *mockAttachmentStore) AddRef(_ context.Context, attachmentID, messageID string) error {
	if _, ok := m.byID[attachmentID]; !ok {
		return errors.New("not found")
	}
	if m.refs[attachmentID] == nil {
		m.refs[attachmentID] = map[string]bool{}
	}
	m.refs[attachmentID][messageID] = true
	a := m.byID[attachmentID]
	a.MessageIDs = keys(m.refs[attachmentID])
	return nil
}
func (m *mockAttachmentStore) RemoveRef(_ context.Context, attachmentID, messageID string) (*model.Attachment, error) {
	a, ok := m.byID[attachmentID]
	if !ok {
		return nil, errors.New("not found")
	}
	if m.refs[attachmentID] != nil {
		delete(m.refs[attachmentID], messageID)
	}
	a.MessageIDs = keys(m.refs[attachmentID])
	return a, nil
}
func (m *mockAttachmentStore) Delete(_ context.Context, id string) error {
	if a, ok := m.byID[id]; ok {
		delete(m.byHash, a.SHA256)
	}
	delete(m.byID, id)
	delete(m.refs, id)
	return nil
}

func keys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

type fakeAttachmentSigner struct {
	deleted []string
	delErr  error
}

func (s *fakeAttachmentSigner) PresignedGetURL(_ context.Context, key string, _ time.Duration) (string, error) {
	return "https://signed.test/" + key, nil
}
func (s *fakeAttachmentSigner) PresignedDownloadURL(_ context.Context, key, filename string, _ time.Duration) (string, error) {
	return "https://signed.test/" + key + "?download=" + filename, nil
}
func (s *fakeAttachmentSigner) PresignedPutURL(_ context.Context, key string, _ string, _ time.Duration) (string, error) {
	return "https://upload.test/" + key, nil
}
func (s *fakeAttachmentSigner) DeleteObject(_ context.Context, key string) error {
	s.deleted = append(s.deleted, key)
	return s.delErr
}

func TestAttachmentService_CreateUploadURL_NewUpload(t *testing.T) {
	storeM := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{}
	svc := NewAttachmentService(storeM, signer, newMockPublisher())

	res, err := svc.CreateUploadURL(context.Background(), "u1", "pic.png", "image/png", "abc123", 100)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if res.AlreadyExists {
		t.Error("expected new upload, got already exists")
	}
	if res.UploadURL == "" {
		t.Error("expected upload URL")
	}
	if res.Attachment.ID == "" {
		t.Error("expected attachment ID")
	}
}

type fakeUploadLimits struct {
	allowExt  bool
	allowSize bool
}

func (f *fakeUploadLimits) AllowsExtension(_ context.Context, _ string) bool { return f.allowExt }
func (f *fakeUploadLimits) AllowsSize(_ context.Context, _ int64) bool       { return f.allowSize }

func TestAttachmentService_CreateUploadURL_RejectsDisallowedExtension(t *testing.T) {
	storeM := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{}
	svc := NewAttachmentService(storeM, signer, newMockPublisher())
	svc.SetUploadLimits(&fakeUploadLimits{allowExt: false, allowSize: true})

	if _, err := svc.CreateUploadURL(context.Background(), "u1", "exec.exe", "application/octet-stream", "abc", 100); err == nil {
		t.Fatal("expected disallowed extension to be rejected")
	}
}

func TestAttachmentService_CreateUploadURL_RejectsOversize(t *testing.T) {
	storeM := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{}
	svc := NewAttachmentService(storeM, signer, newMockPublisher())
	svc.SetUploadLimits(&fakeUploadLimits{allowExt: true, allowSize: false})

	if _, err := svc.CreateUploadURL(context.Background(), "u1", "big.png", "image/png", "abc", 999_999_999); err == nil {
		t.Fatal("expected oversize upload to be rejected")
	}
}

func TestAttachmentService_CreateUploadURL_DedupeByHash(t *testing.T) {
	storeM := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{}
	svc := NewAttachmentService(storeM, signer, newMockPublisher())

	// First upload
	first, err := svc.CreateUploadURL(context.Background(), "u1", "pic.png", "image/png", "abc", 10)
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// Same hash from another user — should dedupe
	second, err := svc.CreateUploadURL(context.Background(), "u2", "other.png", "image/png", "abc", 10)
	if err != nil {
		t.Fatalf("dedupe: %v", err)
	}
	if !second.AlreadyExists {
		t.Error("expected dedup hit")
	}
	if second.Attachment.ID != first.Attachment.ID {
		t.Errorf("expected same ID, got %q want %q", second.Attachment.ID, first.Attachment.ID)
	}
	if second.UploadURL != "" {
		t.Error("dedup hit should not return upload URL")
	}
}

func TestAttachmentService_AddRemoveRef_GCsOnLastDeref(t *testing.T) {
	storeM := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{}
	pub := newMockPublisher()
	svc := NewAttachmentService(storeM, signer, pub)

	res, _ := svc.CreateUploadURL(context.Background(), "u1", "f.bin", "application/octet-stream", "h", 1)
	id := res.Attachment.ID

	if err := svc.AddRef(context.Background(), id, "m1"); err != nil {
		t.Fatalf("add ref: %v", err)
	}
	if err := svc.AddRef(context.Background(), id, "m2"); err != nil {
		t.Fatalf("add ref 2: %v", err)
	}

	// Removing one ref leaves the other — must not GC.
	if err := svc.RemoveRef(context.Background(), id, "m1"); err != nil {
		t.Fatalf("remove ref: %v", err)
	}
	if _, exists := storeM.byID[id]; !exists {
		t.Error("attachment dropped while still referenced")
	}
	if len(signer.deleted) != 0 {
		t.Errorf("S3 object deleted prematurely: %v", signer.deleted)
	}

	// Removing the last ref must GC + publish event.
	if err := svc.RemoveRef(context.Background(), id, "m2"); err != nil {
		t.Fatalf("remove ref 2: %v", err)
	}
	if _, exists := storeM.byID[id]; exists {
		t.Error("attachment row not GC'd after last deref")
	}
	if len(signer.deleted) != 1 {
		t.Errorf("S3 object not deleted: %v", signer.deleted)
	}
	gotEvent := false
	for _, p := range pub.published {
		if p.event.Type == events.EventAttachmentDeleted {
			gotEvent = true
		}
	}
	if !gotEvent {
		t.Error("expected attachment.deleted event")
	}
}

func TestAttachmentService_DeleteDraft_OnlyOwner(t *testing.T) {
	storeM := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{}
	svc := NewAttachmentService(storeM, signer, newMockPublisher())

	res, _ := svc.CreateUploadURL(context.Background(), "owner", "f.bin", "image/png", "h1", 1)
	id := res.Attachment.ID

	if err := svc.DeleteDraft(context.Background(), "intruder", id); err == nil {
		t.Fatal("expected unauthorized error")
	}
	if err := svc.DeleteDraft(context.Background(), "owner", id); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, ok := storeM.byID[id]; ok {
		t.Error("attachment not deleted")
	}
}

func TestAttachmentService_DeleteDraft_RefusesIfReferenced(t *testing.T) {
	storeM := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{}
	svc := NewAttachmentService(storeM, signer, newMockPublisher())

	res, _ := svc.CreateUploadURL(context.Background(), "owner", "f.bin", "image/png", "h2", 1)
	id := res.Attachment.ID
	_ = svc.AddRef(context.Background(), id, "m1")

	if err := svc.DeleteDraft(context.Background(), "owner", id); err == nil {
		t.Fatal("expected referenced error")
	}
	if _, ok := storeM.byID[id]; !ok {
		t.Error("attachment was deleted despite refs")
	}
}

func TestAttachmentService_Get_ResolvesSignedURL(t *testing.T) {
	storeM := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{}
	svc := NewAttachmentService(storeM, signer, newMockPublisher())

	res, _ := svc.CreateUploadURL(context.Background(), "u1", "f.bin", "image/png", "h3", 1)
	got, err := svc.Get(context.Background(), res.Attachment.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.URL == "" {
		t.Error("expected signed URL on returned attachment")
	}
	if got.DownloadURL == "" {
		t.Error("expected forced-download URL on returned attachment")
	}
	if got.URL == got.DownloadURL {
		t.Error("download URL should differ from inline URL (different Content-Disposition)")
	}
}

// TestMessageService_Send_RegistersAttachmentRefs verifies that sending a
// message with attachments increments their refcount.
func TestMessageService_Send_RegistersAttachmentRefs(t *testing.T) {
	channelMembers := newMockMembershipStore()
	channelMembers.memberships["c1#u1"] = &model.ChannelMembership{ChannelID: "c1", UserID: "u1", Role: model.ChannelRoleMember}
	messages := newMockMessageStore()
	atts := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{}
	pub := newMockPublisher()

	svc := NewMessageService(messages, channelMembers, newMockConversationStore(), pub, newMockBroker())
	attSvc := NewAttachmentService(atts, signer, pub)
	svc.SetAttachmentManager(attSvc)

	res, _ := attSvc.CreateUploadURL(context.Background(), "u1", "p.png", "image/png", "h", 1)
	att := res.Attachment

	msg, err := svc.Send(context.Background(), "u1", "c1", ParentChannel, "hi", "", att.ID)
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if len(msg.AttachmentIDs) != 1 {
		t.Errorf("msg attachmentIDs=%v", msg.AttachmentIDs)
	}
	if !atts.refs[att.ID][msg.ID] {
		t.Errorf("expected ref for msg %s on att %s, refs=%v", msg.ID, att.ID, atts.refs)
	}
}

// TestMessageService_Delete_DerefsAttachments verifies that deleting a
// message releases its attachment refs and GCs single-ref uploads.
func TestMessageService_Delete_DerefsAttachments(t *testing.T) {
	channelMembers := newMockMembershipStore()
	channelMembers.memberships["c1#u1"] = &model.ChannelMembership{ChannelID: "c1", UserID: "u1", Role: model.ChannelRoleMember}
	messages := newMockMessageStore()
	atts := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{}
	pub := newMockPublisher()

	svc := NewMessageService(messages, channelMembers, newMockConversationStore(), pub, newMockBroker())
	attSvc := NewAttachmentService(atts, signer, pub)
	svc.SetAttachmentManager(attSvc)

	res, _ := attSvc.CreateUploadURL(context.Background(), "u1", "p.png", "image/png", "h", 1)
	att := res.Attachment
	msg, err := svc.Send(context.Background(), "u1", "c1", ParentChannel, "hi", "", att.ID)
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	if err := svc.Delete(context.Background(), "u1", "c1", ParentChannel, msg.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, exists := atts.byID[att.ID]; exists {
		t.Error("attachment should be GC'd after sole-ref message deleted")
	}
	if len(signer.deleted) != 1 {
		t.Errorf("S3 object not deleted, got %v", signer.deleted)
	}
}
