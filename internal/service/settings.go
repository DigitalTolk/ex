package service

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// SettingsStore is the persistence interface SettingsService depends on.
type SettingsStore interface {
	GetSettings(ctx context.Context) (*model.WorkspaceSettings, error)
	PutSettings(ctx context.Context, s *model.WorkspaceSettings) error
}

// SettingsService exposes workspace-wide configuration. Reads are hot —
// every attachment upload looks up the limits — so the service caches the
// effective settings in memory. Writes invalidate the cache.
type SettingsService struct {
	store SettingsStore
	mu    sync.RWMutex
	cache *model.WorkspaceSettings
}

// NewSettingsService builds a SettingsService.
func NewSettingsService(s SettingsStore) *SettingsService {
	return &SettingsService{store: s}
}

// Effective returns the current settings with any zero-valued fields
// filled from defaults. Always safe to call before the first PUT — a
// fresh workspace gets the built-in defaults.
func (s *SettingsService) Effective(ctx context.Context) *model.WorkspaceSettings {
	s.mu.RLock()
	if s.cache != nil {
		c := *s.cache
		s.mu.RUnlock()
		return s.applyDefaults(&c)
	}
	s.mu.RUnlock()

	ws, err := s.store.GetSettings(ctx)
	if err != nil || ws == nil {
		ws = &model.WorkspaceSettings{}
	}
	s.mu.Lock()
	s.cache = ws
	s.mu.Unlock()
	c := *ws
	return s.applyDefaults(&c)
}

// Update writes new settings and refreshes the cache. Empty inputs reset
// to defaults (the Effective() reader fills them back in).
func (s *SettingsService) Update(ctx context.Context, ws *model.WorkspaceSettings) (*model.WorkspaceSettings, error) {
	if ws == nil {
		return nil, errors.New("settings: nil input")
	}
	// Normalize the extension list: trim, lowercase, strip leading dots.
	cleaned := make([]string, 0, len(ws.AllowedExtensions))
	seen := map[string]bool{}
	for _, e := range ws.AllowedExtensions {
		ext := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(e, ".")))
		if ext == "" || seen[ext] {
			continue
		}
		seen[ext] = true
		cleaned = append(cleaned, ext)
	}
	ws.AllowedExtensions = cleaned
	if ws.MaxUploadBytes < 0 {
		ws.MaxUploadBytes = 0
	}
	ws.GiphyAPIKey = strings.TrimSpace(ws.GiphyAPIKey)

	if err := s.store.PutSettings(ctx, ws); err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.cache = ws
	s.mu.Unlock()
	c := *ws
	return s.applyDefaults(&c), nil
}

func (s *SettingsService) applyDefaults(ws *model.WorkspaceSettings) *model.WorkspaceSettings {
	if ws.MaxUploadBytes <= 0 {
		ws.MaxUploadBytes = model.DefaultMaxUploadBytes
	}
	if len(ws.AllowedExtensions) == 0 {
		ws.AllowedExtensions = model.DefaultAllowedExtensions
	}
	return ws
}

// AllowsExtension reports whether the given filename's extension is
// permitted by the current settings. The check is case-insensitive.
func (s *SettingsService) AllowsExtension(ctx context.Context, filename string) bool {
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(filename), "."))
	if ext == "" {
		return false
	}
	for _, allowed := range s.Effective(ctx).AllowedExtensions {
		if allowed == ext {
			return true
		}
	}
	return false
}

// AllowsSize reports whether `size` is at or below the configured ceiling.
func (s *SettingsService) AllowsSize(ctx context.Context, size int64) bool {
	ws := s.Effective(ctx)
	return size > 0 && size <= ws.MaxUploadBytes
}

// Compile-time assertion that the impl satisfies the store interface.
var _ SettingsStore = (*store.SettingsStoreImpl)(nil)
