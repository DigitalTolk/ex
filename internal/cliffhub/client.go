// Package cliffhub talks to CliffHub's /api/ex surface: its systems are the
// source of truth for ex's projects. Reads are a single list call gated by an
// ETag; writes act for a named person (X-Ex-Actor), whom CliffHub records as
// the author of the change.
package cliffhub

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"sort"
	"strings"
	"time"
)

// System is one CliffHub system as ex reads it. The list endpoint and the
// write responses share these keys.
type System struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	ProjectType string `json:"project_type"`
	// Instructions are the system's agent instructions.
	Instructions string `json:"agent_instructions"`
	// AgentEmails (the list) and AgentEmployees (write responses) name the
	// people allowed to use dev agents on the system.
	AgentEmails    []string        `json:"agent_emails"`
	AgentEmployees []AgentEmployee `json:"agent_employees"`
	IsActive       bool            `json:"is_active"`
	URLs           []URL           `json:"urls"`
	RepoLinks      []RepoLink      `json:"repo_links"`
	DesignNotes    string          `json:"design_notes"`
	UILibrary      string          `json:"ui_library"`
	DesignLinks    []Link          `json:"design_links"`
	// ThemeCSS and ThemeFilename: the list carries them; write responses
	// carry them only when CliffHub returned the single-system shape.
	ThemeCSS      string   `json:"theme_css"`
	ThemeFilename string   `json:"theme_filename"`
	Screens       []Screen `json:"screens"`
}

// AgentEmployee is one person allowed to use dev agents on a system.
type AgentEmployee struct {
	Email string `json:"email"`
}

// Screen is one reference screenshot of a system's real page. The image is
// fetched separately (ScreenImage); ImageSHA256 says whether it changed.
type Screen struct {
	ID          string `json:"id"`
	Page        string `json:"page"`
	Description string `json:"description"`
	Viewport    string `json:"viewport"`
	State       string `json:"state"`
	SeenBy      string `json:"seen_by"`
	Route       string `json:"route"`
	ImageMime   string `json:"image_mime"`
	ImageSHA256 string `json:"image_sha256"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

// ScreenInput is a screen's fields for a create or update.
type ScreenInput struct {
	Page        string `json:"page"`
	Description string `json:"description"`
	Viewport    string `json:"viewport"`
	State       string `json:"state"`
	SeenBy      string `json:"seen_by"`
	Route       string `json:"route"`
}

func (in ScreenInput) fields() map[string]string {
	return map[string]string{
		"page": in.Page, "description": in.Description, "viewport": in.Viewport,
		"state": in.State, "seen_by": in.SeenBy, "route": in.Route,
	}
}

// URL is one of a system's environment links ("prod", "staging", …).
type URL struct {
	TypeKey string `json:"type_key"`
	URL     string `json:"url"`
}

// RepoLink is one repository of a system.
type RepoLink struct {
	Label         string `json:"label"`
	URL           string `json:"url"`
	Role          string `json:"role,omitempty"`
	DefaultBranch string `json:"default_branch,omitempty"`
}

// Link is a labelled reference link (Figma, style guide, …).
type Link struct {
	Label string `json:"label"`
	URL   string `json:"url"`
}

// SystemInput is a create or a partial update: only the fields that are set
// are sent, and CliffHub leaves every other field as it is. A list replaces
// the system's list, so callers send the current list with their additions.
type SystemInput struct {
	Name          *string     `json:"name,omitempty"`
	Description   *string     `json:"description,omitempty"`
	ProjectType   *string     `json:"project_type,omitempty"`
	Instructions  *string     `json:"agent_instructions,omitempty"`
	URLs          *[]URL      `json:"urls,omitempty"`
	RepoLinks     *[]RepoLink `json:"repo_links,omitempty"`
	DesignNotes   *string     `json:"design_notes,omitempty"`
	UILibrary     *string     `json:"ui_library,omitempty"`
	DesignLinks   *[]Link     `json:"design_links,omitempty"`
	ThemeCSS      *string     `json:"theme_css,omitempty"`
	ThemeFilename *string     `json:"theme_filename,omitempty"`
}

// Error is a CliffHub refusal, carrying its status and message.
type Error struct {
	Status  int
	Code    string // CliffHub's error_code, when it gave one
	Message string
}

// UnknownActor reports whether CliffHub refused because it has no employee
// with the acting person's email.
func UnknownActor(err error) bool {
	var ce *Error
	return errors.As(err, &ce) && ce.Code == "unknown_actor"
}

func (e *Error) Error() string {
	return fmt.Sprintf("cliffhub: %d %s", e.Status, e.Message)
}

// ErrNotConfigured is returned by every call of a client with no base URL.
var ErrNotConfigured = errors.New("cliffhub: not configured")

// maxBody caps what is read from CliffHub: a system list is small.
const maxBody = 8 << 20

// Client calls one CliffHub.
type Client struct {
	baseURL string
	apiKey  string
	http    *http.Client
}

// New returns a client for the CliffHub API at baseURL (its origin, without
// /api). An empty baseURL gives a client whose calls all fail with
// ErrNotConfigured.
func New(baseURL, apiKey string) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		http:    &http.Client{Timeout: 20 * time.Second},
	}
}

// Configured reports whether the client has somewhere to call.
func (c *Client) Configured() bool { return c != nil && c.baseURL != "" }

// ListSystems fetches every system, archived ones included. With the ETag of
// the previous list it answers notModified (and no systems) when nothing
// changed.
func (c *Client) ListSystems(ctx context.Context, etag string) (systems []System, newETag string, notModified bool, err error) {
	header := http.Header{}
	if etag != "" {
		header.Set("If-None-Match", etag)
	}
	resp, body, err := c.do(ctx, http.MethodGet, "/api/ex/systems", "", nil, header)
	if err != nil {
		return nil, "", false, err
	}
	if resp.StatusCode == http.StatusNotModified {
		return nil, etag, true, nil
	}
	var out struct {
		Data []System `json:"data"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, "", false, fmt.Errorf("cliffhub: decode systems: %w", err)
	}
	return out.Data, resp.Header.Get("ETag"), false, nil
}

// CreateSystem creates a system as actorEmail, who becomes its owner.
func (c *Client) CreateSystem(ctx context.Context, actorEmail string, in SystemInput) (*System, error) {
	return c.write(ctx, http.MethodPost, "/api/ex/systems", actorEmail, in)
}

// UpdateSystem replaces a system's ex fields as actorEmail.
func (c *Client) UpdateSystem(ctx context.Context, actorEmail, id string, in SystemInput) (*System, error) {
	return c.write(ctx, http.MethodPatch, "/api/ex/systems/"+id, actorEmail, in)
}

// ScreenImage downloads a screen's image.
func (c *Client) ScreenImage(ctx context.Context, systemID, screenID string) ([]byte, error) {
	_, body, err := c.do(ctx, http.MethodGet, "/api/ex/systems/"+systemID+"/screens/"+screenID+"/image", "", nil, nil)
	return body, err
}

// CreateScreen adds a screen with its image, as actorEmail.
func (c *Client) CreateScreen(ctx context.Context, actorEmail, systemID string, in ScreenInput, image []byte) (*Screen, error) {
	return c.screenWrite(ctx, http.MethodPost, "/api/ex/systems/"+systemID+"/screens", actorEmail, in, image)
}

// UpdateScreen replaces a screen's fields, and its image when one is given.
func (c *Client) UpdateScreen(ctx context.Context, actorEmail, systemID, screenID string, in ScreenInput, image []byte) (*Screen, error) {
	return c.screenWrite(ctx, http.MethodPatch, "/api/ex/systems/"+systemID+"/screens/"+screenID, actorEmail, in, image)
}

// DeleteScreen removes a screen, as actorEmail. One CliffHub no longer has
// counts as removed.
func (c *Client) DeleteScreen(ctx context.Context, actorEmail, systemID, screenID string) error {
	_, _, err := c.do(ctx, http.MethodDelete, "/api/ex/systems/"+systemID+"/screens/"+screenID, actorEmail, nil, nil)
	var ce *Error
	if errors.As(err, &ce) && ce.Status == http.StatusNotFound {
		return nil
	}
	return err
}

// screenWrite sends a screen as multipart: its fields, plus the image when
// there is one.
func (c *Client) screenWrite(ctx context.Context, method, path, actorEmail string, in ScreenInput, image []byte) (*Screen, error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range in.fields() {
		_ = mw.WriteField(k, v)
	}
	if image != nil {
		fw, _ := mw.CreateFormFile("image", "screen")
		_, _ = fw.Write(image)
	}
	_ = mw.Close()
	header := http.Header{"Content-Type": {mw.FormDataContentType()}}
	_, body, err := c.do(ctx, method, path, actorEmail, buf.Bytes(), header)
	if err != nil {
		return nil, err
	}
	var sc Screen
	if err := json.Unmarshal(body, &sc); err != nil {
		return nil, fmt.Errorf("cliffhub: decode screen: %w", err)
	}
	return &sc, nil
}

func (c *Client) write(ctx context.Context, method, path, actorEmail string, in SystemInput) (*System, error) {
	payload, err := json.Marshal(in)
	if err != nil {
		return nil, fmt.Errorf("cliffhub: encode system: %w", err)
	}
	_, body, err := c.do(ctx, method, path, actorEmail, payload, nil)
	if err != nil {
		return nil, err
	}
	var sys System
	if err := json.Unmarshal(body, &sys); err != nil {
		return nil, fmt.Errorf("cliffhub: decode system: %w", err)
	}
	return &sys, nil
}

// do sends one request and returns the response and its body. Any status but
// 2xx and 304 is an *Error.
func (c *Client) do(ctx context.Context, method, path, actorEmail string, payload []byte, header http.Header) (*http.Response, []byte, error) {
	if !c.Configured() {
		return nil, nil, ErrNotConfigured
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bytes.NewReader(payload))
	if err != nil {
		return nil, nil, fmt.Errorf("cliffhub: request: %w", err)
	}
	for k, v := range header {
		req.Header[k] = v
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-API-Key", c.apiKey)
	if payload != nil && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if actorEmail != "" {
		req.Header.Set("X-Ex-Actor", actorEmail)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("cliffhub: %s %s: %w", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return nil, nil, fmt.Errorf("cliffhub: read %s: %w", path, err)
	}
	if resp.StatusCode == http.StatusNotModified || (resp.StatusCode >= 200 && resp.StatusCode < 300) {
		return resp, body, nil
	}
	return nil, nil, &Error{Status: resp.StatusCode, Code: errorCode(body), Message: errorMessage(body)}
}

// errorCode is the error_code of an error body ("" when none).
func errorCode(body []byte) string {
	var e struct {
		Code string `json:"error_code"`
	}
	_ = json.Unmarshal(body, &e)
	return e.Code
}

// errorMessage pulls CliffHub's human message out of an error body: the
// first field error of a 422 (by field name, so it is stable) when there is
// one, else its message.
func errorMessage(body []byte) string {
	var e struct {
		Message string              `json:"message"`
		Errors  map[string][]string `json:"errors"`
	}
	if json.Unmarshal(body, &e) != nil {
		return strings.TrimSpace(string(body))
	}
	fields := make([]string, 0, len(e.Errors))
	for f := range e.Errors {
		fields = append(fields, f)
	}
	sort.Strings(fields)
	for _, f := range fields {
		if msgs := e.Errors[f]; len(msgs) > 0 {
			return msgs[0]
		}
	}
	return e.Message
}
