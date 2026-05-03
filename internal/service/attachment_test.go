package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/cache"
	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

type mockAttachmentStore struct {
	byID   map[string]*model.Attachment
	byHash map[string]*model.Attachment
	// refs[attID] is the set of message IDs referencing the attachment.
	refs       map[string]map[string]bool
	createErr  error
	getHashErr error
}

func newMockAttachmentStore() *mockAttachmentStore {
	return &mockAttachmentStore{
		byID:   map[string]*model.Attachment{},
		byHash: map[string]*model.Attachment{},
		refs:   map[string]map[string]bool{},
	}
}

func (m *mockAttachmentStore) Create(_ context.Context, a *model.Attachment) error {
	if m.createErr != nil {
		return m.createErr
	}
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
	if m.getHashErr != nil {
		return nil, m.getHashErr
	}
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
func (m *mockAttachmentStore) SetDimensions(_ context.Context, id string, width, height int) error {
	a, ok := m.byID[id]
	if !ok {
		return store.ErrNotFound
	}
	a.Width = width
	a.Height = height
	return nil
}

func keys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

var (
	testSHA256A = strings.Repeat("a", sha256.Size*2)
	testSHA256B = strings.Repeat("b", sha256.Size*2)
	testSHA256C = strings.Repeat("c", sha256.Size*2)
)

type fakeAttachmentSigner struct {
	deleted []string
	delErr  error
	putErr  error
	// presignCalls counts every PresignedGetURL call. The URL it
	// returns embeds the call number so two URLs for the same key
	// are *different strings* — exactly the production behaviour
	// (presigned URLs include a signing timestamp). Tests that want
	// to verify URL caching assert that the cached URL equals the
	// FIRST signature, not a freshly-minted one.
	presignCalls         int
	presignDownloadCalls int
	// objects is the in-memory bucket used by the dimensions-backfill
	// path: GetObjectRange returns whatever bytes are stored here for
	// the requested key. Tests that don't exercise backfill leave
	// this nil and GetObjectRange errors out.
	objects           map[string][]byte
	objectContentType string
}

type fakeMediaCache struct {
	items map[string]any
}

func newFakeMediaCache() *fakeMediaCache {
	return &fakeMediaCache{items: map[string]any{}}
}

func (c *fakeMediaCache) Get(_ context.Context, key string, dest interface{}) error {
	v, ok := c.items[key]
	if !ok {
		return cache.ErrCacheMiss
	}
	data, _ := json.Marshal(v)
	return json.Unmarshal(data, dest)
}

func (c *fakeMediaCache) Set(_ context.Context, key string, val interface{}, _ time.Duration) error {
	c.items[key] = val
	return nil
}

func (s *fakeAttachmentSigner) PresignedGetURL(_ context.Context, key string, _ time.Duration) (string, error) {
	s.presignCalls++
	return fmt.Sprintf("https://signed.test/%s?sig=%d", key, s.presignCalls), nil
}
func (s *fakeAttachmentSigner) PresignedDownloadURL(_ context.Context, key, filename string, _ time.Duration) (string, error) {
	s.presignDownloadCalls++
	return fmt.Sprintf("https://signed.test/%s?download=%s&sig=%d", key, filename, s.presignDownloadCalls), nil
}
func (s *fakeAttachmentSigner) PresignedPutURL(_ context.Context, key string, _ string, _ time.Duration) (string, error) {
	if s.putErr != nil {
		return "", s.putErr
	}
	return "https://upload.test/" + key, nil
}
func (s *fakeAttachmentSigner) DeleteObject(_ context.Context, key string) error {
	s.deleted = append(s.deleted, key)
	return s.delErr
}
func (s *fakeAttachmentSigner) GetObjectRange(_ context.Context, key string, _ int64) ([]byte, error) {
	if s.objects == nil {
		return nil, fmt.Errorf("no object %s", key)
	}
	body, ok := s.objects[key]
	if !ok {
		return nil, fmt.Errorf("no object %s", key)
	}
	return body, nil
}
func (s *fakeAttachmentSigner) GetObject(_ context.Context, key string) (io.ReadCloser, string, int64, time.Time, error) {
	if s.objects == nil {
		return nil, "", 0, time.Time{}, fmt.Errorf("no object %s", key)
	}
	body, ok := s.objects[key]
	if !ok {
		return nil, "", 0, time.Time{}, fmt.Errorf("no object %s", key)
	}
	contentType := s.objectContentType
	if contentType == "" {
		contentType = "image/png"
	}
	return io.NopCloser(bytes.NewReader(body)), contentType, int64(len(body)), time.Date(2026, 5, 2, 10, 0, 0, 0, time.UTC), nil
}

func TestAttachmentService_CreateUploadURL_PersistsClientReportedDimensions(t *testing.T) {
	storeM := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{}
	svc := NewAttachmentService(storeM, signer, newMockPublisher())

	res, err := svc.CreateUploadURL(context.Background(), CreateUploadParams{
		UserID: "u1", Filename: "pic.png", ContentType: "image/png", SHA256: testSHA256A, Size: 100,
		Width: 1280, Height: 720,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if res.Attachment.Width != 1280 || res.Attachment.Height != 720 {
		t.Errorf("dimensions = %dx%d, want 1280x720", res.Attachment.Width, res.Attachment.Height)
	}
	stored := storeM.byID[res.Attachment.ID]
	if stored.Width != 1280 || stored.Height != 720 {
		t.Errorf("stored dimensions = %dx%d, want 1280x720", stored.Width, stored.Height)
	}
}

func TestAttachmentService_Get_BackfillsDimensionsForLegacyImage(t *testing.T) {
	// Pre-feature attachments have Width/Height = 0; on the next
	// Get we should fetch enough of the S3 object to decode the
	// dimensions and persist them. Subsequent Gets see the stored
	// values without re-reading S3.
	storeM := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{objects: map[string][]byte{}}
	signer.objects["attachments/legacy"] = makePNG(640, 480)

	att := &model.Attachment{
		ID:          "legacy",
		SHA256:      "h",
		Size:        int64(len(signer.objects["attachments/legacy"])),
		ContentType: "image/png",
		Filename:    "old.png",
		S3Key:       "attachments/legacy",
		CreatedBy:   "u1",
		CreatedAt:   time.Now(),
		// no Width/Height — this is the legacy case.
	}
	if err := storeM.Create(context.Background(), att); err != nil {
		t.Fatalf("seed: %v", err)
	}

	svc := NewAttachmentService(storeM, signer, newMockPublisher())
	if _, err := svc.Get(context.Background(), "legacy"); err != nil {
		t.Fatalf("get: %v", err)
	}
	// Backfill is async — bounded wait. The test signer answers
	// synchronously and the goroutine does at most one S3 read +
	// one store write, so this resolves in a few ms.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		stored := storeM.byID["legacy"]
		if stored.Width != 0 && stored.Height != 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	stored := storeM.byID["legacy"]
	if stored.Width != 640 || stored.Height != 480 {
		t.Errorf("backfilled dimensions = %dx%d, want 640x480", stored.Width, stored.Height)
	}
}

// makePNG produces a valid in-memory PNG of the given dimensions.
// Used by the backfill test to seed a legacy attachment's S3 body.
func makePNG(w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

func TestAttachmentService_CreateUploadURL_NewUpload(t *testing.T) {
	storeM := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{}
	svc := NewAttachmentService(storeM, signer, newMockPublisher())

	res, err := svc.CreateUploadURL(context.Background(), CreateUploadParams{UserID: "u1", Filename: "pic.png", ContentType: "image/png", SHA256: testSHA256A, Size: 100})
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

	if _, err := svc.CreateUploadURL(context.Background(), CreateUploadParams{UserID: "u1", Filename: "exec.exe", ContentType: "application/octet-stream", SHA256: testSHA256A, Size: 100}); err == nil {
		t.Fatal("expected disallowed extension to be rejected")
	}
}

func TestAttachmentService_CreateUploadURL_RejectsOversize(t *testing.T) {
	storeM := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{}
	svc := NewAttachmentService(storeM, signer, newMockPublisher())
	svc.SetUploadLimits(&fakeUploadLimits{allowExt: true, allowSize: false})

	if _, err := svc.CreateUploadURL(context.Background(), CreateUploadParams{UserID: "u1", Filename: "big.png", ContentType: "image/png", SHA256: testSHA256A, Size: 999_999_999}); err == nil {
		t.Fatal("expected oversize upload to be rejected")
	}
}

func TestAttachmentService_CreateUploadURL_RejectsInvalidMetadata(t *testing.T) {
	storeM := newMockAttachmentStore()
	svc := NewAttachmentService(storeM, &fakeAttachmentSigner{}, nil)

	if _, err := svc.CreateUploadURL(context.Background(), CreateUploadParams{UserID: "u1", Filename: "pic.png", ContentType: "image/png", SHA256: "not-a-sha", Size: 100}); err == nil {
		t.Fatal("expected invalid sha256 to be rejected")
	}
	if _, err := svc.CreateUploadURL(context.Background(), CreateUploadParams{UserID: "u1", Filename: "pic.png", ContentType: "image/png", SHA256: testSHA256A, Size: 100, Width: -1}); err == nil {
		t.Fatal("expected invalid dimensions to be rejected")
	}
}

func TestAttachmentService_CreateUploadURL_PropagatesStorageErrors(t *testing.T) {
	ctx := context.Background()
	params := CreateUploadParams{UserID: "u1", Filename: "pic.png", ContentType: "image/png", SHA256: testSHA256A, Size: 100}

	tests := []struct {
		name   string
		store  *mockAttachmentStore
		signer *fakeAttachmentSigner
	}{
		{
			name: "hash lookup",
			store: func() *mockAttachmentStore {
				s := newMockAttachmentStore()
				s.getHashErr = errors.New("lookup failed")
				return s
			}(),
			signer: &fakeAttachmentSigner{},
		},
		{
			name: "create",
			store: func() *mockAttachmentStore {
				s := newMockAttachmentStore()
				s.createErr = errors.New("create failed")
				return s
			}(),
			signer: &fakeAttachmentSigner{},
		},
		{
			name:   "presign",
			store:  newMockAttachmentStore(),
			signer: &fakeAttachmentSigner{putErr: errors.New("presign failed")},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := NewAttachmentService(tt.store, tt.signer, nil)
			if _, err := svc.CreateUploadURL(ctx, params); err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestAttachmentService_CreateUploadURL_DedupeByHash(t *testing.T) {
	storeM := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{}
	svc := NewAttachmentService(storeM, signer, newMockPublisher())

	// First upload
	first, err := svc.CreateUploadURL(context.Background(), CreateUploadParams{UserID: "u1", Filename: "pic.png", ContentType: "image/png", SHA256: testSHA256A, Size: 10})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// Same hash from another user — should dedupe
	second, err := svc.CreateUploadURL(context.Background(), CreateUploadParams{UserID: "u2", Filename: "other.png", ContentType: "image/png", SHA256: testSHA256A, Size: 10})
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

func TestAttachmentService_ValidateForUse_VerifiesUploadedObject(t *testing.T) {
	storeM := newMockAttachmentStore()
	object := makePNG(2, 2)
	signer := &fakeAttachmentSigner{objects: map[string][]byte{}}
	svc := NewAttachmentService(storeM, signer, nil)

	res, err := svc.CreateUploadURL(context.Background(), CreateUploadParams{
		UserID: "u1", Filename: "p.png", ContentType: "image/png", SHA256: sha256Hex(object), Size: int64(len(object)),
	})
	if err != nil {
		t.Fatalf("CreateUploadURL: %v", err)
	}
	signer.objects[res.Attachment.S3Key] = object

	if err := svc.ValidateForUse(context.Background(), res.Attachment.ID); err != nil {
		t.Fatalf("ValidateForUse: %v", err)
	}
}

func TestAttachmentService_ValidateForUse_RejectsMissingOrTamperedObject(t *testing.T) {
	storeM := newMockAttachmentStore()
	object := makePNG(2, 2)
	signer := &fakeAttachmentSigner{objects: map[string][]byte{}}
	svc := NewAttachmentService(storeM, signer, nil)

	res, err := svc.CreateUploadURL(context.Background(), CreateUploadParams{
		UserID: "u1", Filename: "p.png", ContentType: "image/png", SHA256: sha256Hex(object), Size: int64(len(object)),
	})
	if err != nil {
		t.Fatalf("CreateUploadURL: %v", err)
	}
	if err := svc.ValidateForUse(context.Background(), res.Attachment.ID); err == nil {
		t.Fatal("expected missing upload object to be rejected")
	}
	signer.objects[res.Attachment.S3Key] = []byte("not a png")
	if err := svc.ValidateForUse(context.Background(), res.Attachment.ID); err == nil {
		t.Fatal("expected tampered upload object to be rejected")
	}
}

func TestAttachmentService_ValidateForUse_RejectsClientDimensionMismatch(t *testing.T) {
	storeM := newMockAttachmentStore()
	object := makePNG(2, 2)
	signer := &fakeAttachmentSigner{objects: map[string][]byte{}}
	svc := NewAttachmentService(storeM, signer, nil)

	res, err := svc.CreateUploadURL(context.Background(), CreateUploadParams{
		UserID: "u1", Filename: "p.png", ContentType: "image/png", SHA256: sha256Hex(object), Size: int64(len(object)), Width: 999, Height: 2,
	})
	if err != nil {
		t.Fatalf("CreateUploadURL: %v", err)
	}
	signer.objects[res.Attachment.S3Key] = object

	if err := svc.ValidateForUse(context.Background(), res.Attachment.ID); err == nil {
		t.Fatal("expected mismatched client dimensions to be rejected")
	}
}

func TestAttachmentService_ValidateForUse_AllowsSafeSVG(t *testing.T) {
	storeM := newMockAttachmentStore()
	object := []byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg>`)
	signer := &fakeAttachmentSigner{objects: map[string][]byte{}, objectContentType: "image/svg+xml"}
	svc := NewAttachmentService(storeM, signer, nil)

	res, err := svc.CreateUploadURL(context.Background(), CreateUploadParams{
		UserID: "u1", Filename: "safe.svg", ContentType: "image/svg+xml", SHA256: sha256Hex(object), Size: int64(len(object)),
	})
	if err != nil {
		t.Fatalf("CreateUploadURL: %v", err)
	}
	signer.objects[res.Attachment.S3Key] = object

	if err := svc.ValidateForUse(context.Background(), res.Attachment.ID); err != nil {
		t.Fatalf("ValidateForUse: %v", err)
	}
}

func TestAttachmentService_ValidateForUse_RejectsUnsafeSVG(t *testing.T) {
	storeM := newMockAttachmentStore()
	object := []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)
	signer := &fakeAttachmentSigner{objects: map[string][]byte{}, objectContentType: "image/svg+xml"}
	svc := NewAttachmentService(storeM, signer, nil)

	res, err := svc.CreateUploadURL(context.Background(), CreateUploadParams{
		UserID: "u1", Filename: "unsafe.svg", ContentType: "image/svg+xml", SHA256: sha256Hex(object), Size: int64(len(object)),
	})
	if err != nil {
		t.Fatalf("CreateUploadURL: %v", err)
	}
	signer.objects[res.Attachment.S3Key] = object

	if err := svc.ValidateForUse(context.Background(), res.Attachment.ID); err == nil {
		t.Fatal("expected unsafe svg to be rejected")
	}
}

func TestAttachmentService_ValidateForUse_RejectsInvalidRowsAndObjects(t *testing.T) {
	ctx := context.Background()
	object := makePNG(1, 1)

	tests := []struct {
		name   string
		row    *model.Attachment
		signer *fakeAttachmentSigner
	}{
		{
			name:   "missing storage key",
			row:    &model.Attachment{ID: "a1", SHA256: sha256Hex(object), Size: int64(len(object)), ContentType: "image/png"},
			signer: &fakeAttachmentSigner{objects: map[string][]byte{}},
		},
		{
			name:   "invalid size",
			row:    &model.Attachment{ID: "a2", S3Key: "attachments/a2", SHA256: sha256Hex(object), ContentType: "image/png"},
			signer: &fakeAttachmentSigner{objects: map[string][]byte{"attachments/a2": object}},
		},
		{
			name:   "object size mismatch",
			row:    &model.Attachment{ID: "a3", S3Key: "attachments/a3", SHA256: sha256Hex(object), Size: int64(len(object) + 1), ContentType: "image/png"},
			signer: &fakeAttachmentSigner{objects: map[string][]byte{"attachments/a3": object}},
		},
		{
			name:   "sha mismatch",
			row:    &model.Attachment{ID: "a4", S3Key: "attachments/a4", SHA256: testSHA256A, Size: int64(len(object)), ContentType: "image/png"},
			signer: &fakeAttachmentSigner{objects: map[string][]byte{"attachments/a4": object}},
		},
		{
			name:   "content type mismatch",
			row:    &model.Attachment{ID: "a5", S3Key: "attachments/a5", SHA256: sha256Hex(object), Size: int64(len(object)), ContentType: "image/jpeg"},
			signer: &fakeAttachmentSigner{objects: map[string][]byte{"attachments/a5": object}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			storeM := newMockAttachmentStore()
			storeM.byID[tt.row.ID] = tt.row
			svc := NewAttachmentService(storeM, tt.signer, nil)
			if err := svc.ValidateForUse(ctx, tt.row.ID); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}

	storeM := newMockAttachmentStore()
	storeM.byID["a6"] = &model.Attachment{ID: "a6", S3Key: "attachments/a6", SHA256: sha256Hex(object), Size: int64(len(object)), ContentType: "image/png"}
	if err := NewAttachmentService(storeM, nil, nil).ValidateForUse(ctx, "a6"); err == nil {
		t.Fatal("expected missing signer to be rejected")
	}
}

func TestAttachmentService_AddRemoveRef_GCsOnLastDeref(t *testing.T) {
	storeM := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{}
	pub := newMockPublisher()
	svc := NewAttachmentService(storeM, signer, pub)

	res, _ := svc.CreateUploadURL(context.Background(), CreateUploadParams{UserID: "u1", Filename: "f.bin", ContentType: "application/octet-stream", SHA256: testSHA256A, Size: 1})
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

	res, _ := svc.CreateUploadURL(context.Background(), CreateUploadParams{UserID: "owner", Filename: "f.bin", ContentType: "image/png", SHA256: testSHA256A, Size: 1})
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

	res, _ := svc.CreateUploadURL(context.Background(), CreateUploadParams{UserID: "owner", Filename: "f.bin", ContentType: "image/png", SHA256: testSHA256B, Size: 1})
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

	res, _ := svc.CreateUploadURL(context.Background(), CreateUploadParams{UserID: "u1", Filename: "f.bin", ContentType: "image/png", SHA256: testSHA256C, Size: 1})
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

func TestAttachmentService_Get_UsesStableMediaURLWhenCacheConfigured(t *testing.T) {
	storeM := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{}
	svc := NewAttachmentService(storeM, signer, newMockPublisher())
	svc.SetMediaURLCache(newFakeMediaCache())
	a := &model.Attachment{
		ID:          "a-media",
		SHA256:      "sha-media",
		S3Key:       "attachments/a-media",
		Filename:    "cat pic.png",
		ContentType: "image/png",
		Size:        42,
		CreatedBy:   "u1",
	}
	if err := storeM.Create(context.Background(), a); err != nil {
		t.Fatalf("Create: %v", err)
	}

	got1, err := svc.Get(context.Background(), a.ID)
	if err != nil {
		t.Fatalf("Get first: %v", err)
	}
	got2, err := svc.Get(context.Background(), a.ID)
	if err != nil {
		t.Fatalf("Get second: %v", err)
	}
	if got1.URL == "" || got1.URL != got2.URL {
		t.Fatalf("stable media URL mismatch: first=%q second=%q", got1.URL, got2.URL)
	}
	if !strings.HasPrefix(got1.URL, "/api/v1/media/") {
		t.Fatalf("URL = %q, want app media URL", got1.URL)
	}
	if got1.DownloadURL == "" || !strings.HasPrefix(got1.DownloadURL, "https://signed.test/") {
		t.Fatalf("DownloadURL = %q, want direct signed S3 URL", got1.DownloadURL)
	}
	if signer.presignCalls != 0 || signer.presignDownloadCalls != 1 {
		t.Fatalf("unexpected presign calls: get=%d download=%d", signer.presignCalls, signer.presignDownloadCalls)
	}
}

func TestAttachmentService_OpenMedia_StreamsCachedToken(t *testing.T) {
	storeM := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{objects: map[string][]byte{
		"attachments/a-media-open": []byte("PNG"),
	}}
	mediaCache := newFakeMediaCache()
	svc := NewAttachmentService(storeM, signer, newMockPublisher())
	svc.SetMediaURLCache(mediaCache)
	a := &model.Attachment{
		ID:          "a-media-open",
		SHA256:      "sha-media-open",
		S3Key:       "attachments/a-media-open",
		Filename:    "cat.png",
		ContentType: "image/png",
		Size:        3,
		CreatedBy:   "u1",
	}
	if err := storeM.Create(context.Background(), a); err != nil {
		t.Fatalf("Create: %v", err)
	}
	got, err := svc.Get(context.Background(), a.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	parts := strings.Split(got.URL, "/")
	token := parts[len(parts)-2]

	media, err := svc.OpenMedia(context.Background(), token)
	if err != nil {
		t.Fatalf("OpenMedia: %v", err)
	}
	defer func() { _ = media.Body.Close() }()
	body, _ := io.ReadAll(media.Body)
	if string(body) != "PNG" {
		t.Fatalf("body = %q, want PNG", string(body))
	}
	if media.ContentType != "image/png" || media.Filename != "cat.png" || media.Size != 3 {
		t.Fatalf("media metadata mismatch: %+v", media)
	}
	if _, err := svc.OpenMedia(context.Background(), "missing"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing token err = %v, want ErrNotFound", err)
	}
}

// TestAttachmentService_Get_CachesPresignedURL is the regression test for
// the "images reload too often" bug. Without per-S3-key URL caching,
// two consecutive Get() calls returned different signed URLs (each
// embedded a fresh signing timestamp), so the browser image cache
// missed on every render and re-downloaded the bytes. Assert that two
// Get() calls within the cache window yield the SAME URL — and that
// the underlying signer was only called once.
func TestAttachmentService_Get_CachesPresignedURL(t *testing.T) {
	storeM := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{}
	svc := NewAttachmentService(storeM, signer, newMockPublisher())

	res, _ := svc.CreateUploadURL(context.Background(), CreateUploadParams{UserID: "u1", Filename: "f.png", ContentType: "image/png", SHA256: testSHA256A, Size: 1})
	id := res.Attachment.ID

	first, err := svc.Get(context.Background(), id)
	if err != nil {
		t.Fatalf("first get: %v", err)
	}
	second, err := svc.Get(context.Background(), id)
	if err != nil {
		t.Fatalf("second get: %v", err)
	}

	if first.URL != second.URL {
		t.Errorf("URL not cached across consecutive Get() calls:\n  first:  %q\n  second: %q", first.URL, second.URL)
	}
	if first.DownloadURL != second.DownloadURL {
		t.Errorf("DownloadURL not cached across consecutive Get() calls:\n  first:  %q\n  second: %q", first.DownloadURL, second.DownloadURL)
	}
	if signer.presignCalls != 1 {
		t.Errorf("PresignedGetURL called %d times across two Get()s; expected 1 (cached)", signer.presignCalls)
	}
	if signer.presignDownloadCalls != 1 {
		t.Errorf("PresignedDownloadURL called %d times; expected 1 (cached)", signer.presignDownloadCalls)
	}
}

// TestAttachmentService_GC_InvalidatesURLCache covers the corner case
// where an attachment is deleted (last ref dropped or draft removed)
// and its S3 key would otherwise stay cached. After GC, the cache
// must drop the entry so a subsequent re-upload of the same key (or
// a new attachment that recycles it) doesn't render with a stale URL.
func TestAttachmentService_GC_InvalidatesURLCache(t *testing.T) {
	storeM := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{}
	svc := NewAttachmentService(storeM, signer, newMockPublisher())

	res, _ := svc.CreateUploadURL(context.Background(), CreateUploadParams{UserID: "u1", Filename: "f.png", ContentType: "image/png", SHA256: testSHA256B, Size: 1})
	id := res.Attachment.ID
	key := res.Attachment.S3Key

	// Prime the cache.
	if _, err := svc.Get(context.Background(), id); err != nil {
		t.Fatalf("get: %v", err)
	}
	if signer.presignCalls != 1 {
		t.Fatalf("expected 1 sign call after first get, got %d", signer.presignCalls)
	}

	// Delete the draft — must invalidate the cached URL for that key.
	if err := svc.DeleteDraft(context.Background(), "u1", id); err != nil {
		t.Fatalf("delete draft: %v", err)
	}

	// Forge a fresh sign for the same key. If the cache was correctly
	// invalidated, the underlying signer is consulted again.
	if _, err := svc.urlCache.getOrSign(context.Background(), presignedKey{op: "get", key: key},
		func(ctx context.Context) (string, error) {
			return signer.PresignedGetURL(ctx, key, AttachmentURLTTL)
		}); err != nil {
		t.Fatalf("re-sign: %v", err)
	}
	if signer.presignCalls != 2 {
		t.Errorf("cache invalidation failed: signer called %d times after GC, expected 2", signer.presignCalls)
	}
}

// TestMessageService_Send_RegistersAttachmentRefs verifies that sending a
// message with attachments increments their refcount.
func TestMessageService_Send_RegistersAttachmentRefs(t *testing.T) {
	channelMembers := newMockMembershipStore()
	channelMembers.memberships["c1#u1"] = &model.ChannelMembership{ChannelID: "c1", UserID: "u1", Role: model.ChannelRoleMember}
	messages := newMockMessageStore()
	atts := newMockAttachmentStore()
	object := makePNG(1, 1)
	signer := &fakeAttachmentSigner{objects: map[string][]byte{}}
	pub := newMockPublisher()

	svc := NewMessageService(messages, channelMembers, newMockConversationStore(), pub, newMockBroker())
	attSvc := NewAttachmentService(atts, signer, pub)
	svc.SetAttachmentManager(attSvc)

	res, _ := attSvc.CreateUploadURL(context.Background(), CreateUploadParams{UserID: "u1", Filename: "p.png", ContentType: "image/png", SHA256: sha256Hex(object), Size: int64(len(object))})
	att := res.Attachment
	signer.objects[att.S3Key] = object

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
	object := makePNG(1, 1)
	signer := &fakeAttachmentSigner{objects: map[string][]byte{}}
	pub := newMockPublisher()

	svc := NewMessageService(messages, channelMembers, newMockConversationStore(), pub, newMockBroker())
	attSvc := NewAttachmentService(atts, signer, pub)
	svc.SetAttachmentManager(attSvc)

	res, _ := attSvc.CreateUploadURL(context.Background(), CreateUploadParams{UserID: "u1", Filename: "p.png", ContentType: "image/png", SHA256: sha256Hex(object), Size: int64(len(object))})
	att := res.Attachment
	signer.objects[att.S3Key] = object
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

// TestAttachmentService_GetMany covers the parallel batched fetch the
// message renderer uses to resolve the per-message attachment chip
// list. Empty / unknown / mixed inputs must all produce a stable,
// in-order result with missing IDs silently skipped.
func TestAttachmentService_GetMany(t *testing.T) {
	atts := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{}
	svc := NewAttachmentService(atts, signer, newMockPublisher())
	ctx := context.Background()

	// Seed three real attachments — GetMany resolves each via Get(),
	// which is what stamps the URL/DownloadURL fields.
	for _, id := range []string{"a1", "a2", "a3"} {
		atts.byID[id] = &model.Attachment{
			ID:          id,
			SHA256:      "h-" + id,
			Filename:    id + ".png",
			ContentType: "image/png",
			S3Key:       "k/" + id,
			CreatedAt:   time.Now(),
		}
	}

	t.Run("empty input returns nil", func(t *testing.T) {
		got, err := svc.GetMany(ctx, nil)
		if err != nil {
			t.Fatalf("GetMany: %v", err)
		}
		if got != nil {
			t.Errorf("expected nil for empty input, got %v", got)
		}
	})

	t.Run("missing IDs are skipped silently", func(t *testing.T) {
		got, err := svc.GetMany(ctx, []string{"a1", "missing", "a2", ""})
		if err != nil {
			t.Fatalf("GetMany: %v", err)
		}
		if len(got) != 2 {
			t.Fatalf("expected 2 hits (missing + empty skipped), got %d", len(got))
		}
		seen := map[string]bool{}
		for _, a := range got {
			seen[a.ID] = true
			if a.URL == "" {
				t.Errorf("attachment %s missing presigned URL", a.ID)
			}
			if a.DownloadURL == "" {
				t.Errorf("attachment %s missing download URL", a.ID)
			}
		}
		if !seen["a1"] || !seen["a2"] {
			t.Errorf("expected a1+a2, got %v", seen)
		}
	})

	t.Run("all hits returns full set", func(t *testing.T) {
		got, err := svc.GetMany(ctx, []string{"a1", "a2", "a3"})
		if err != nil {
			t.Fatalf("GetMany: %v", err)
		}
		if len(got) != 3 {
			t.Fatalf("expected 3, got %d", len(got))
		}
	})
}

func TestValidateSVG_EdgeCases(t *testing.T) {
	tests := []struct {
		name string
		data []byte
	}{
		{
			name: "malformed XML",
			data: []byte(`<svg><path></svg`),
		},
		{
			name: "wrong root",
			data: []byte(`<html><svg /></html>`),
		},
		{
			name: "event attribute",
			data: []byte(`<svg xmlns="http://www.w3.org/2000/svg"><path onclick="alert(1)" /></svg>`),
		},
		{
			name: "javascript href",
			data: []byte(`<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)" /></svg>`),
		},
		{
			name: "foreign object",
			data: []byte(`<svg xmlns="http://www.w3.org/2000/svg"><foreignObject /></svg>`),
		},
		{
			name: "empty document",
			data: []byte(`   `),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := validateSVG(tt.data); err == nil {
				t.Fatal("expected SVG validation error")
			}
		})
	}
}
