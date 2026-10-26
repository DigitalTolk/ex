package agents

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/safe"
)

// The connector registry's SOURCE is the standalone connector-provider: it
// hosts each connector's docs (watched from a service repo, or authored in the
// provider's own repo) plus the admin-owned auth, and ex PULLS that catalog in
// — never the reverse. This file is that pull: list the provider's connectors,
// fetch each one's files + auth, and run the same Ingest an admin upload would.
// Replaces the old sync-to-ex.py — all Go, gated by an admin caller.

// providerRegistration mirrors the connector-provider's served auth block.
type providerRegistration struct {
	Title          string `json:"title"`
	Description    string `json:"description"`
	BaseURL        string `json:"baseURL"`
	AuthKind       string `json:"authKind"`
	TokenURL       string `json:"tokenURL"`
	ClientID       string `json:"clientID"`
	VerifyURL      string `json:"verifyURL"`
	StartURL       string `json:"startURL"`
	CapturePattern string `json:"capturePattern"`
	AuthHeader     string `json:"authHeader"`
	CredentialHint string `json:"credentialHint"`
	CredentialURL  string `json:"credentialURL"`
}

// providerManifest is one connector's manifest as the provider serves it. Slug
// and revision are deliberately absent: the sync takes both from the listing
// row it is iterating, so decoding them here only invited the two to disagree.
type providerManifest struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Files       []struct {
		Name string `json:"name"`
	} `json:"files"`
	Registration *providerRegistration `json:"registration"`
}

// SetProvider wires the connector-provider ex pulls from. No-op values (empty
// URL) leave the feature off.
func (s *ConnectorService) SetProvider(baseURL, apiKey string) {
	s.providerURL = strings.TrimRight(baseURL, "/")
	s.providerKey = apiKey
}

// ProviderConfigured reports whether a connector-provider is wired.
func (s *ConnectorService) ProviderConfigured() bool { return s.providerURL != "" }

// providerSyncTimeout bounds one background provider pass.
const providerSyncTimeout = 60 * time.Second

// RunProviderSync keeps the registry in step with the provider until ctx is
// cancelled: a forced pull at boot (registration changes such as baseURL or
// auth do not bump the provider revision, so a restart is when they
// propagate), then a revision-gated pass every interval — an unchanged catalog
// costs one small listing fetch. Passes run sequentially on the caller's
// goroutine, so they never overlap, and each one is panic-isolated: the loop
// lives on a detached goroutine where a single bad pass would otherwise take
// the whole process down.
func (s *ConnectorService) RunProviderSync(ctx context.Context, interval time.Duration) {
	s.providerSyncOnce(ctx, true)
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.providerSyncOnce(ctx, false)
		}
	}
}

// providerSyncOnce runs one bounded pass and logs its outcome.
func (s *ConnectorService) providerSyncOnce(ctx context.Context, force bool) {
	defer safe.Recover()
	ctx, cancel := context.WithTimeout(ctx, providerSyncTimeout)
	defer cancel()
	res, err := s.SyncFromProvider(ctx, "system", force)
	switch {
	case err != nil:
		slog.WarnContext(ctx, "connector-provider sync failed", "error", err)
	case force || len(res.Synced) > 0:
		slog.InfoContext(ctx, "connector-provider sync", "synced", res.Synced, "unchanged", len(res.Unchanged), "skipped", len(res.Skipped))
	}
}

// providerGet fetches one path from the provider, bearer-authed.
func (s *ConnectorService) providerGet(ctx context.Context, path string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.providerURL+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+s.providerKey)
	res, err := s.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("connector provider: %w: %w", ErrServiceUnreachable, err)
	}
	defer func() { _ = res.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(res.Body, model.ConnectorFileMaxBytes+8192))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("connector provider %s: HTTP %d: %w", path, res.StatusCode, ErrServiceUnreachable)
	}
	return body, nil
}

// SyncResult reports what one provider sync did.
type SyncResult struct {
	Synced    []string          `json:"synced"`
	Unchanged []string          `json:"unchanged,omitempty"` // revision matched; not re-pulled
	Skipped   map[string]string `json:"skipped,omitempty"`   // slug → reason
}

// SyncFromProvider pulls every PUBLISHED connector from the provider and
// ingests it (docs + admin auth) into the registry. A connector with no
// published revision, or no registration (admin hasn't said how to connect
// it), is skipped with a reason rather than failing the whole sync — one bad
// source never blocks the rest.
//
// Unless force is set, a connector whose stored revision already matches the
// provider's is left alone — the periodic sync then costs one listing fetch
// when nothing changed. force re-ingests everything: registration changes
// (baseURL, auth) live in the provider's config, not the bundle, so they
// don't bump the revision — the admin sync endpoint and the boot sync force
// so those still propagate.
func (s *ConnectorService) SyncFromProvider(ctx context.Context, callerID string, force bool) (*SyncResult, error) {
	if !s.ProviderConfigured() {
		return nil, ErrNoConnectorProvider
	}
	listBody, err := s.providerGet(ctx, "/v1/connectors")
	if err != nil {
		return nil, err
	}
	var list struct {
		Connectors []struct {
			Slug     string `json:"slug"`
			Revision string `json:"revision"`
		} `json:"connectors"`
	}
	if err := json.Unmarshal(listBody, &list); err != nil {
		return nil, fmt.Errorf("connector provider list: %w: %w", ErrServiceUnreachable, err)
	}

	// One listing of what we already hold beats a per-slug read; ListConnectors
	// returns metadata only (no file contents).
	stored := map[string]string{}
	if !force {
		existing, err := s.store.ListConnectors(ctx)
		if err != nil {
			return nil, fmt.Errorf("connector sync: list stored: %w", err)
		}
		for _, c := range existing {
			stored[c.Slug] = c.Revision
		}
	}

	out := &SyncResult{Skipped: map[string]string{}}
	for _, row := range list.Connectors {
		if row.Revision == "" {
			out.Skipped[row.Slug] = "no published revision"
			continue
		}
		if !force {
			if rev, ok := stored[row.Slug]; ok && rev == row.Revision {
				out.Unchanged = append(out.Unchanged, row.Slug)
				continue
			}
		}
		mBody, err := s.providerGet(ctx, "/v1/connectors/"+row.Slug)
		if err != nil {
			out.Skipped[row.Slug] = err.Error()
			continue
		}
		var m providerManifest
		if err := json.Unmarshal(mBody, &m); err != nil {
			out.Skipped[row.Slug] = "manifest parse: " + err.Error()
			continue
		}
		if m.Registration == nil || m.Registration.BaseURL == "" {
			out.Skipped[row.Slug] = "no registration (admin hasn't set how to connect)"
			continue
		}
		files := make([]model.ConnectorFile, 0, len(m.Files))
		fetchErr := ""
		for _, f := range m.Files {
			c, err := s.providerGet(ctx, "/v1/connectors/"+row.Slug+"/files/"+f.Name)
			if err != nil {
				fetchErr = f.Name + ": " + err.Error()
				break
			}
			files = append(files, model.ConnectorFile{Slug: row.Slug, Name: f.Name, Content: string(c)})
		}
		if fetchErr != "" {
			out.Skipped[row.Slug] = "file fetch " + fetchErr
			continue
		}
		reg := m.Registration
		title := firstNonEmpty(reg.Title, m.Title, row.Slug)
		desc := firstNonEmpty(reg.Description, m.Description)
		if _, err := s.Ingest(ctx, callerID, IngestInput{
			Slug: row.Slug, Title: title, Description: desc,
			BaseURL: reg.BaseURL, AuthKind: reg.AuthKind,
			TokenURL: reg.TokenURL, ClientID: reg.ClientID, VerifyURL: reg.VerifyURL,
			StartURL: reg.StartURL, CapturePattern: reg.CapturePattern,
			AuthHeader:     reg.AuthHeader,
			CredentialHint: reg.CredentialHint, CredentialURL: reg.CredentialURL,
			Revision: row.Revision,
			Files:    files,
		}); err != nil {
			out.Skipped[row.Slug] = "ingest: " + err.Error()
			continue
		}
		out.Synced = append(out.Synced, row.Slug)
	}
	return out, nil
}
