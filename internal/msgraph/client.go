// Package msgraph is a minimal app-only (client-credentials) Microsoft Graph
// client. It covers exactly the slices of Graph the app uses: directory
// profile reads (phone + manager, synced onto Ex profiles at SSO login) and
// creating Teams online meetings on behalf of a user (the /mstmeetings slash
// command). Because the workspace already authenticates through the same
// Azure AD app registration, no per-user account linking or token storage is
// needed — the app authenticates itself and acts via Graph application
// permissions (User.Read.All; OnlineMeetings.ReadWrite.All via an application
// access policy for meeting creation).
package msgraph

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"context"
)

const (
	defaultBaseURL        = "https://graph.microsoft.com/v1.0"
	defaultTokenURLFormat = "https://login.microsoftonline.com/%s/oauth2/v2.0/token"
	defaultScope          = "https://graph.microsoft.com/.default"

	// tokenExpiryMargin renews the cached app token this long before Graph
	// says it expires, so an in-flight request never rides a just-expired one.
	tokenExpiryMargin = time.Minute

	// responseLimit bounds how much of a Graph response body is read. Profile
	// and meeting payloads are a few KB; anything larger is malformed.
	responseLimit = 1 << 20
)

// ErrNotFound marks a 404 from Graph — the directory object doesn't exist
// (user not in the tenant, or no manager assigned). Callers treat it as an
// empty result, not a failure.
var ErrNotFound = errors.New("msgraph: not found")

// Config carries the Azure AD app registration the client authenticates as.
// TokenURL/BaseURL/HTTPClient are injectable for tests (httptest servers).
type Config struct {
	TenantID     string
	ClientID     string
	ClientSecret string
	TokenURL     string
	BaseURL      string
	HTTPClient   *http.Client
}

// Client is an app-only Microsoft Graph client with a cached bearer token.
type Client struct {
	clientID     string
	clientSecret string
	tokenURL     string
	baseURL      string
	client       *http.Client

	mu          sync.Mutex
	accessToken string
	tokenExpiry time.Time
}

// New builds a Client, or (nil, nil) when the integration is not configured
// (any credential missing) — the same "absent config disables the feature"
// contract the OneSignal sender follows.
func New(cfg Config) (*Client, error) {
	if strings.TrimSpace(cfg.TenantID) == "" ||
		strings.TrimSpace(cfg.ClientID) == "" ||
		strings.TrimSpace(cfg.ClientSecret) == "" {
		return nil, nil
	}
	tokenURL := strings.TrimSpace(cfg.TokenURL)
	if tokenURL == "" {
		tokenURL = fmt.Sprintf(defaultTokenURLFormat, url.PathEscape(strings.TrimSpace(cfg.TenantID)))
	}
	if _, err := url.ParseRequestURI(tokenURL); err != nil {
		return nil, fmt.Errorf("msgraph: invalid token URL: %w", err)
	}
	baseURL := strings.TrimSpace(cfg.BaseURL)
	if baseURL == "" {
		baseURL = defaultBaseURL
	}
	if _, err := url.ParseRequestURI(baseURL); err != nil {
		return nil, fmt.Errorf("msgraph: invalid base URL: %w", err)
	}
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return &Client{
		clientID:     strings.TrimSpace(cfg.ClientID),
		clientSecret: strings.TrimSpace(cfg.ClientSecret),
		tokenURL:     tokenURL,
		baseURL:      strings.TrimRight(baseURL, "/"),
		client:       client,
	}, nil
}

// UserProfile is the directory slice the app reads for a user.
type UserProfile struct {
	ID                string   `json:"id"`
	DisplayName       string   `json:"displayName"`
	Mail              string   `json:"mail"`
	UserPrincipalName string   `json:"userPrincipalName"`
	MobilePhone       string   `json:"mobilePhone"`
	BusinessPhones    []string `json:"businessPhones"`
}

// Phone returns the best single display number: mobile first, then the first
// business line.
func (p *UserProfile) Phone() string {
	if p.MobilePhone != "" {
		return p.MobilePhone
	}
	if len(p.BusinessPhones) > 0 {
		return p.BusinessPhones[0]
	}
	return ""
}

// EmailAddress returns the mailbox address, falling back to the UPN (which is
// mail-shaped and routable in the overwhelming majority of tenants).
func (p *UserProfile) EmailAddress() string {
	if p.Mail != "" {
		return p.Mail
	}
	return p.UserPrincipalName
}

const profileSelect = "?$select=id,displayName,mail,userPrincipalName,mobilePhone,businessPhones"

// GetUserProfile fetches a user's directory profile. key is an AAD object ID
// or a userPrincipalName. ErrNotFound when the user isn't in the directory.
func (c *Client) GetUserProfile(ctx context.Context, key string) (*UserProfile, error) {
	var p UserProfile
	if err := c.doJSON(ctx, http.MethodGet, "/users/"+url.PathEscape(key)+profileSelect, nil, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

// GetUserManager fetches a user's manager from the directory hierarchy.
// ErrNotFound when the user has no manager assigned (or doesn't exist).
func (c *Client) GetUserManager(ctx context.Context, key string) (*UserProfile, error) {
	var p UserProfile
	if err := c.doJSON(ctx, http.MethodGet, "/users/"+url.PathEscape(key)+"/manager"+profileSelect, nil, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

// OnlineMeetingRequest describes the Teams meeting to create.
type OnlineMeetingRequest struct {
	Subject      string
	StartAt      time.Time
	EndAt        time.Time
	AttendeeUPNs []string
}

// OnlineMeeting is the created meeting slice the app needs.
type OnlineMeeting struct {
	ID      string `json:"id"`
	JoinURL string `json:"joinWebUrl"`
	Subject string `json:"subject"`
}

type meetingParticipantPayload struct {
	UPN  string `json:"upn"`
	Role string `json:"role"`
}

type onlineMeetingPayload struct {
	StartDateTime string `json:"startDateTime"`
	EndDateTime   string `json:"endDateTime"`
	Subject       string `json:"subject"`
	Participants  struct {
		Attendees []meetingParticipantPayload `json:"attendees"`
	} `json:"participants"`
}

// CreateOnlineMeeting creates a Teams online meeting organized by the given
// user (AAD object ID or UPN). Attendees are pre-registered so tenant members
// bypass the lobby; unknown UPNs are ignored by Graph.
func (c *Client) CreateOnlineMeeting(ctx context.Context, organizerKey string, req OnlineMeetingRequest) (*OnlineMeeting, error) {
	payload := onlineMeetingPayload{
		StartDateTime: req.StartAt.UTC().Format(time.RFC3339),
		EndDateTime:   req.EndAt.UTC().Format(time.RFC3339),
		Subject:       req.Subject,
	}
	payload.Participants.Attendees = make([]meetingParticipantPayload, 0, len(req.AttendeeUPNs))
	for _, upn := range req.AttendeeUPNs {
		if strings.TrimSpace(upn) == "" {
			continue
		}
		payload.Participants.Attendees = append(payload.Participants.Attendees, meetingParticipantPayload{UPN: upn, Role: "attendee"})
	}

	var meeting OnlineMeeting
	if err := c.doJSON(ctx, http.MethodPost, "/users/"+url.PathEscape(organizerKey)+"/onlineMeetings", payload, &meeting); err != nil {
		return nil, err
	}
	if meeting.JoinURL == "" {
		return nil, errors.New("msgraph: meeting created without a join URL")
	}
	return &meeting, nil
}

// token returns a valid app-only bearer token, fetching a fresh one from the
// tenant token endpoint when the cached one is missing or near expiry. The
// mutex single-flights concurrent refreshes.
func (c *Client) token(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.accessToken != "" && time.Now().Before(c.tokenExpiry) {
		return c.accessToken, nil
	}

	form := url.Values{
		"client_id":     {c.clientID},
		"client_secret": {c.clientSecret},
		"scope":         {defaultScope},
		"grant_type":    {"client_credentials"},
	}
	req := mustRequest(http.NewRequestWithContext(ctx, http.MethodPost, c.tokenURL, strings.NewReader(form.Encode())))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	res, err := c.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("msgraph: token request: %w", err)
	}
	defer drainClose(res.Body)
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("msgraph: token request failed with status %d", res.StatusCode)
	}

	var tr struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, responseLimit)).Decode(&tr); err != nil {
		return "", fmt.Errorf("msgraph: parse token response: %w", err)
	}
	if tr.AccessToken == "" {
		return "", errors.New("msgraph: token response contained no access token")
	}

	ttl := max(time.Duration(tr.ExpiresIn)*time.Second-tokenExpiryMargin, 0)
	c.accessToken = tr.AccessToken
	c.tokenExpiry = time.Now().Add(ttl)
	return c.accessToken, nil
}

// doJSON authenticates, performs one Graph call, and decodes the JSON
// response into dest. 404 maps to ErrNotFound; other non-2xx to a status
// error (bodies are never echoed into errors — they can carry directory PII).
func (c *Client) doJSON(ctx context.Context, method, path string, payload, dest any) error {
	tok, err := c.token(ctx)
	if err != nil {
		return err
	}

	var body io.Reader
	if payload != nil {
		body = bytes.NewReader(mustJSON(json.Marshal(payload)))
	}
	req := mustRequest(http.NewRequestWithContext(ctx, method, c.baseURL+path, body))
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Accept", "application/json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	res, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("msgraph: request: %w", err)
	}
	defer drainClose(res.Body)
	if res.StatusCode == http.StatusNotFound {
		return ErrNotFound
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("msgraph: request failed with status %d", res.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, responseLimit)).Decode(dest); err != nil {
		return fmt.Errorf("msgraph: parse response: %w", err)
	}
	return nil
}

func drainClose(body io.ReadCloser) {
	_, _ = io.Copy(io.Discard, io.LimitReader(body, responseLimit))
	_ = body.Close()
}

// Panic-on-impossible helpers (the template.Must idiom, matching
// internal/service/must.go): New validates both URLs and payload structs are
// plain strings/slices, so these error branches are dead at every call site.

func mustRequest(req *http.Request, err error) *http.Request {
	if err != nil {
		panic(fmt.Sprintf("msgraph: building request for a validated URL failed: %v", err))
	}
	return req
}

func mustJSON(b []byte, err error) []byte {
	if err != nil {
		panic(fmt.Sprintf("msgraph: static struct failed to marshal to JSON: %v", err))
	}
	return b
}
