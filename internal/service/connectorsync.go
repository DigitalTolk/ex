package service

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/DigitalTolk/ex/internal/model"
)

// The connector registry's SOURCE is the standalone connector-provider: it
// hosts each connector's docs (watched from a service repo, or authored in the
// provider's own repo) plus the admin-owned auth, and ex PULLS that catalog in
// — never the reverse. This file is that pull: list the provider's connectors,
// fetch each one's files + auth, and run the same Ingest an admin upload would.
// Replaces the old sync-to-ex.py — all Go, gated by an admin caller.

// providerRegistration mirrors the connector-provider's served auth block.
type providerRegistration struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	BaseURL     string `json:"baseURL"`
	AuthKind    string `json:"authKind"`
	TokenURL    string `json:"tokenURL"`
	ClientID    string `json:"clientID"`
	VerifyURL   string `json:"verifyURL"`
}

type providerManifest struct {
	Slug         string `json:"slug"`
	Revision     string `json:"revision"`
	Title        string `json:"title"`
	Description  string `json:"description"`
	Files        []struct {
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

// providerGet fetches one path from the provider, bearer-authed.
func (s *ConnectorService) providerGet(ctx context.Context, path string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.providerURL+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+s.providerKey)
	res, err := s.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("connector provider unreachable: %w", err)
	}
	defer func() { _ = res.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(res.Body, model.ConnectorFileMaxBytes+8192))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("connector provider %s: HTTP %d", path, res.StatusCode)
	}
	return body, nil
}

// SyncResult reports what one provider sync did.
type SyncResult struct {
	Synced  []string          `json:"synced"`
	Skipped map[string]string `json:"skipped,omitempty"` // slug → reason
}

// SyncFromProvider pulls every PUBLISHED connector from the provider and
// ingests it (docs + admin auth) into the registry. A connector with no
// published revision, or no registration (admin hasn't said how to connect
// it), is skipped with a reason rather than failing the whole sync — one bad
// source never blocks the rest.
func (s *ConnectorService) SyncFromProvider(ctx context.Context, callerID string) (*SyncResult, error) {
	if !s.ProviderConfigured() {
		return nil, fmt.Errorf("%w: no connector provider configured", ErrConnectorInvalid)
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
		return nil, fmt.Errorf("connector provider list: %w", err)
	}

	out := &SyncResult{Skipped: map[string]string{}}
	for _, row := range list.Connectors {
		if row.Revision == "" {
			out.Skipped[row.Slug] = "no published revision"
			continue
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
			Files: files,
		}); err != nil {
			out.Skipped[row.Slug] = "ingest: " + err.Error()
			continue
		}
		out.Synced = append(out.Synced, row.Slug)
	}
	return out, nil
}
