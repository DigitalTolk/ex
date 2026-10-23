package service

import (
	"context"
	"errors"
	"io"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// switchableAccess answers CanAccessMessageAttachment from a flag the test
// flips, counting the checks.
type switchableAccess struct {
	denied  atomic.Bool
	failing atomic.Bool
	checks  atomic.Int32
}

func (s *switchableAccess) CanAccessMessageAttachment(context.Context, string, string, string, string, string) error {
	s.checks.Add(1)
	if s.failing.Load() {
		return errors.New("dynamo down")
	}
	if s.denied.Load() {
		return ErrForbidden
	}
	return nil
}

// mediaParts splits a media URL into its token and grant.
func mediaParts(t *testing.T, raw string) (token, grant string) {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil || !strings.HasPrefix(u.Path, "/api/v1/media/") {
		t.Fatalf("not a media URL: %q", raw)
	}
	parts := strings.Split(strings.TrimPrefix(u.Path, "/api/v1/media/"), "/")
	return parts[0], u.Query().Get("g")
}

func openMedia(svc *AttachmentService, token, grant string) error {
	m, err := svc.OpenMedia(context.Background(), token, grant, "")
	if err == nil {
		_, _ = io.Copy(io.Discard, m.Body)
		_ = m.Body.Close()
	}
	return err
}

func grantFixture(t *testing.T) (*AttachmentService, *switchableAccess, *model.Attachment) {
	t.Helper()
	storeM := newMockAttachmentStore()
	a := &model.Attachment{
		ID: "shared", SHA256: "h", S3Key: "attachments/shared", Filename: "plan.pdf",
		ContentType: "application/pdf", Size: 4, CreatedBy: "owner", MessageIDs: []string{"m1"},
	}
	storeM.byID[a.ID] = a
	signer := &fakeAttachmentSigner{objects: map[string][]byte{a.S3Key: []byte("%PDF")}}
	svc := NewAttachmentService(storeM, signer, newMockPublisher())
	svc.SetMediaURLCache(newFakeMediaCache())
	access := &switchableAccess{}
	svc.SetAccessChecker(access)
	return svc, access, a
}

// A media URL handed to a channel member used to stay a bearer capability for
// 30 days, even after they left the channel. It is now bound to the user it
// was issued to and to where their access was proved, and the media route
// re-checks that access (cached briefly) on every load.
func TestMediaURL_StopsWorkingWhenAccessIsRevoked(t *testing.T) {
	svc, access, a := grantFixture(t)

	got, err := svc.GetForUser(context.Background(), "u2", a.ID, "ch1", ParentChannel, "m1")
	if err != nil {
		t.Fatal(err)
	}
	token, grant := mediaParts(t, got.URL)
	if grant == "" {
		t.Fatalf("media URL %q carries no grant", got.URL)
	}
	if err := openMedia(svc, token, grant); err != nil {
		t.Fatalf("a member's media URL failed: %v", err)
	}

	access.denied.Store(true) // u2 left the channel
	svc.mediaAccess.Purge()   // ...and the cached check (mediaAccessTTL) ran out
	if err := openMedia(svc, token, grant); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("after losing access: %v, want ErrNotFound", err)
	}
}

// The URL cannot be stripped of its grant, nor the grant moved to another
// user, file or context.
func TestMediaURL_GrantIsUnforgeable(t *testing.T) {
	svc, _, a := grantFixture(t)
	got, err := svc.GetForUser(context.Background(), "u2", a.ID, "ch1", ParentChannel, "m1")
	if err != nil {
		t.Fatal(err)
	}
	token, grant := mediaParts(t, got.URL)
	payload, sig, _ := strings.Cut(grant, ".")
	other := MediaGrant{UserID: "u3", ParentID: "ch1", ParentType: ParentChannel, MessageID: "m1"}
	for name, g := range map[string]string{
		"no grant":         "",
		"no signature":     payload,
		"garbled":          "!!!." + sig,
		"another user":     encodeGrantPayload(other) + "." + sig,
		"bad payload json": "bm90LWpzb24." + sig,
	} {
		if err := openMedia(svc, token, g); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("%s: err = %v, want ErrNotFound", name, err)
		}
	}
	// The grant-less opener never opens a scoped token.
	if _, err := OpenStableMedia(context.Background(), svc.mediaCache, svc.signer, token, ""); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("OpenStableMedia on a scoped token: %v, want ErrNotFound", err)
	}
	// Even correctly signed, a payload must be a grant naming a user.
	for name, p := range map[string]string{
		"undecodable":   "!!!",
		"not json":      "bm90LWpzb24",
		"no user named": encodeGrantPayload(MediaGrant{ParentID: "ch1"}),
	} {
		if err := openMedia(svc, token, p+"."+svc.grantMAC(token, p)); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("signed %s payload: err = %v, want ErrNotFound", name, err)
		}
	}
	// A grant signed by another server key is worthless here.
	elsewhere := NewAttachmentService(newMockAttachmentStore(), &fakeAttachmentSigner{}, newMockPublisher())
	elsewhere.SetMediaGrantKey([]byte("other secret"))
	if err := openMedia(svc, token, elsewhere.signGrant(token, MediaGrant{UserID: "u2", ParentID: "ch1", ParentType: ParentChannel, MessageID: "m1"})); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("foreign key: err = %v, want ErrNotFound", err)
	}
}

// Media loads stay fast: one access check per user/file/context per cache
// window, not one per request.
func TestMediaURL_AccessChecksAreCached(t *testing.T) {
	svc, access, a := grantFixture(t)
	got, err := svc.GetForUser(context.Background(), "u2", a.ID, "ch1", ParentChannel, "m1")
	if err != nil {
		t.Fatal(err)
	}
	token, grant := mediaParts(t, got.URL)
	before := access.checks.Load()
	for range 5 {
		if err := openMedia(svc, token, grant); err != nil {
			t.Fatal(err)
		}
	}
	if n := access.checks.Load() - before; n != 1 {
		t.Fatalf("%d access checks for 5 loads, want 1", n)
	}
	// A transient failure is not a verdict: it is not cached either.
	svc.mediaAccess.Purge()
	access.failing.Store(true)
	if err := openMedia(svc, token, grant); err == nil || errors.Is(err, store.ErrNotFound) {
		t.Fatalf("transient check failure: %v, want a non-404 error", err)
	}
	access.failing.Store(false)
	if err := openMedia(svc, token, grant); err != nil {
		t.Fatalf("after the outage: %v", err)
	}
}

// flakyAttachmentStore fails GetByID while fail is set.
type flakyAttachmentStore struct {
	*mockAttachmentStore
	fail atomic.Bool
}

func (f *flakyAttachmentStore) GetByID(ctx context.Context, id string) (*model.Attachment, error) {
	if f.fail.Load() {
		return nil, errors.New("dynamo down")
	}
	return f.mockAttachmentStore.GetByID(ctx, id)
}

// A failed attachment read during the access check is a transient error,
// not a denial.
func TestMediaURL_TransientAttachmentReadIsNotADenial(t *testing.T) {
	_, access, a := grantFixture(t)
	storeM := &flakyAttachmentStore{mockAttachmentStore: newMockAttachmentStore()}
	storeM.byID[a.ID] = a
	svc := NewAttachmentService(storeM, &fakeAttachmentSigner{objects: map[string][]byte{a.S3Key: []byte("%PDF")}}, newMockPublisher())
	svc.SetMediaURLCache(newFakeMediaCache())
	svc.SetAccessChecker(access)
	got, err := svc.GetForUser(context.Background(), "u2", a.ID, "ch1", ParentChannel, "m1")
	if err != nil {
		t.Fatal(err)
	}
	token, grant := mediaParts(t, got.URL)
	storeM.fail.Store(true)
	if err := openMedia(svc, token, grant); err == nil || errors.Is(err, store.ErrNotFound) {
		t.Fatalf("transient read: %v, want a non-404 error", err)
	}
}

// failingSetCache refuses writes: no stable URL can be minted.
type failingSetCache struct{ *fakeMediaCache }

func (failingSetCache) Set(context.Context, string, interface{}, time.Duration) error {
	return errors.New("redis down")
}

// Without a stable media URL the read still answers, with the presigned
// fallback.
func TestMediaURL_FallsBackWhenTheCacheRefusesWrites(t *testing.T) {
	svc, _, a := grantFixture(t)
	svc.SetMediaURLCache(failingSetCache{newFakeMediaCache()})
	got, err := svc.GetForUser(context.Background(), "u2", a.ID, "ch1", ParentChannel, "m1")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(got.URL, "https://signed.test/") {
		t.Fatalf("URL = %q, want the presigned fallback", got.URL)
	}
}

// A grant for an attachment that has since been deleted opens nothing.
func TestMediaURL_DeletedAttachment(t *testing.T) {
	svc, _, a := grantFixture(t)
	got, err := svc.GetForUser(context.Background(), "u2", a.ID, "ch1", ParentChannel, "m1")
	if err != nil {
		t.Fatal(err)
	}
	token, grant := mediaParts(t, got.URL)
	delete(svc.attachments.(*mockAttachmentStore).byID, a.ID)
	if err := openMedia(svc, token, grant); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("deleted attachment: %v, want ErrNotFound", err)
	}
}

// Thumbnails handed to a user are bound the same way; URLs the server hands
// out without a user (link previews, agent runs, upload processing) stay
// plain capabilities.
func TestMediaURL_ScopesThumbnailsAndLeavesUnscopedPathsAlone(t *testing.T) {
	svc, _, a := grantFixture(t)
	a.ThumbnailS3Key, a.SquareThumbnailS3Key = "attachments/shared/t", "attachments/shared/s"
	got, err := svc.GetForUser(context.Background(), "u2", a.ID, "ch1", ParentChannel, "m1")
	if err != nil {
		t.Fatal(err)
	}
	for _, u := range []string{got.ThumbnailURL, got.SquareThumbnailURL} {
		if _, grant := mediaParts(t, u); grant == "" {
			t.Errorf("thumbnail URL %q carries no grant", u)
		}
	}
	plain, err := svc.Get(context.Background(), a.ID)
	if err != nil {
		t.Fatal(err)
	}
	token, grant := mediaParts(t, plain.URL)
	if grant != "" {
		t.Fatalf("an unscoped URL carries a grant: %q", plain.URL)
	}
	if err := openMedia(svc, token, ""); err != nil {
		t.Fatalf("unscoped media URL: %v", err)
	}
}
