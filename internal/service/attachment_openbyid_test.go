package service

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// OpenByID streams without an access check — the caller (a run reading its
// project's screenshot) authorized the read itself.
func TestAttachmentService_OpenByID(t *testing.T) {
	ctx := context.Background()
	st := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{objects: map[string][]byte{"attachments/s1": []byte("png")}}
	svc := NewAttachmentService(st, signer, nil)
	st.byID["s1"] = &model.Attachment{ID: "s1", S3Key: "attachments/s1", CreatedBy: "u-bob", MessageIDs: []string{model.ScreenAttachmentRef("sc1")}, Size: 3}
	st.byID["gone"] = &model.Attachment{ID: "gone", S3Key: "attachments/gone"}
	st.byID["nokey"] = &model.Attachment{ID: "nokey"}

	body, a, err := svc.OpenByID(ctx, "s1")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	got, _ := io.ReadAll(body)
	_ = body.Close()
	if string(got) != "png" || a.ID != "s1" {
		t.Fatalf("read %q / %+v", got, a)
	}
	if _, _, err := svc.OpenByID(ctx, "missing"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	if _, _, err := svc.OpenByID(ctx, "nokey"); err == nil || !strings.Contains(err.Error(), "storage not configured") {
		t.Fatalf("no object key: %v", err)
	}
	if _, _, err := svc.OpenByID(ctx, "gone"); err == nil || !strings.Contains(err.Error(), "open object") {
		t.Fatalf("object missing: %v", err)
	}
}
