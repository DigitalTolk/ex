package service

import (
	"context"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

type fakeSettingsStore struct {
	stored *model.WorkspaceSettings
	getErr error
	putErr error
}

func (f *fakeSettingsStore) GetSettings(_ context.Context) (*model.WorkspaceSettings, error) {
	if f.getErr != nil {
		return nil, f.getErr
	}
	if f.stored == nil {
		return nil, store.ErrNotFound
	}
	c := *f.stored
	return &c, nil
}

func (f *fakeSettingsStore) PutSettings(_ context.Context, ws *model.WorkspaceSettings) error {
	if f.putErr != nil {
		return f.putErr
	}
	c := *ws
	f.stored = &c
	return nil
}

func TestSettingsService_Effective_DefaultsWhenUnset(t *testing.T) {
	svc := NewSettingsService(&fakeSettingsStore{})
	ws := svc.Effective(context.Background())
	if ws.MaxUploadBytes != model.DefaultMaxUploadBytes {
		t.Errorf("MaxUploadBytes = %d, want default %d", ws.MaxUploadBytes, model.DefaultMaxUploadBytes)
	}
	if len(ws.AllowedExtensions) == 0 {
		t.Error("expected default extension list when unset")
	}
}

func TestSettingsService_Update_PersistsAndNormalizes(t *testing.T) {
	store := &fakeSettingsStore{}
	svc := NewSettingsService(store)

	got, err := svc.Update(context.Background(), &model.WorkspaceSettings{
		MaxUploadBytes:    10 * 1024 * 1024,
		AllowedExtensions: []string{"PNG", ".jpg", "  pdf ", "PNG", ""},
	})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	want := []string{"png", "jpg", "pdf"}
	if len(got.AllowedExtensions) != len(want) {
		t.Errorf("AllowedExtensions = %v, want %v", got.AllowedExtensions, want)
	}
	for i, e := range want {
		if got.AllowedExtensions[i] != e {
			t.Errorf("AllowedExtensions[%d] = %q, want %q", i, got.AllowedExtensions[i], e)
		}
	}
	if got.MaxUploadBytes != 10*1024*1024 {
		t.Errorf("MaxUploadBytes = %d, want 10MiB", got.MaxUploadBytes)
	}
}

func TestSettingsService_AllowsExtensionAndSize(t *testing.T) {
	store := &fakeSettingsStore{
		stored: &model.WorkspaceSettings{
			MaxUploadBytes:    1024,
			AllowedExtensions: []string{"png"},
		},
	}
	svc := NewSettingsService(store)
	ctx := context.Background()

	if !svc.AllowsExtension(ctx, "cat.png") {
		t.Error("expected png to be allowed")
	}
	if svc.AllowsExtension(ctx, "cat.exe") {
		t.Error("expected exe to be rejected")
	}
	if svc.AllowsExtension(ctx, "noext") {
		t.Error("expected file with no extension to be rejected")
	}

	if !svc.AllowsSize(ctx, 1024) {
		t.Error("size at limit should be allowed")
	}
	if svc.AllowsSize(ctx, 1025) {
		t.Error("size over limit should be rejected")
	}
	if svc.AllowsSize(ctx, 0) {
		t.Error("zero size should be rejected")
	}
}

func TestSettingsService_Update_ClearsCacheSoNextReadSeesNewValues(t *testing.T) {
	store := &fakeSettingsStore{
		stored: &model.WorkspaceSettings{MaxUploadBytes: 1024, AllowedExtensions: []string{"png"}},
	}
	svc := NewSettingsService(store)
	ctx := context.Background()
	_ = svc.Effective(ctx) // prime cache

	if _, err := svc.Update(ctx, &model.WorkspaceSettings{MaxUploadBytes: 2048, AllowedExtensions: []string{"jpg"}}); err != nil {
		t.Fatalf("Update: %v", err)
	}
	got := svc.Effective(ctx)
	if got.MaxUploadBytes != 2048 {
		t.Errorf("MaxUploadBytes = %d, want 2048", got.MaxUploadBytes)
	}
	if len(got.AllowedExtensions) != 1 || got.AllowedExtensions[0] != "jpg" {
		t.Errorf("expected only jpg after update; got %v", got.AllowedExtensions)
	}
}
