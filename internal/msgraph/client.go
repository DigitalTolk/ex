// Package msgraph is a minimal Microsoft Graph client. The app-only
// (client-credentials) Client covers exactly the slices of Graph the app uses
// as itself: directory
// profile reads (phone + manager, synced onto Ex profiles at SSO login) and
// creating Teams online meetings on behalf of a user (the /mstmeetings slash
// command). Because the workspace already authenticates through the same
// Azure AD app registration, no per-user account linking or token storage is
// needed — the app authenticates itself and acts via Graph application
// permissions (User.Read.All; OnlineMeetings.ReadWrite.All via an application
// access policy for meeting creation). Delegated (delegated.go) acts as a
// signed-in user instead, for what must never run with the app's rights:
// sharing SharePoint files.
package msgraph

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/clientcredentials"
)

const (
	defaultBaseURL        = "https://graph.microsoft.com/v1.0"
	defaultTokenURLFormat = "https://login.microsoftonline.com/%s/oauth2/v2.0/token"
	defaultScope          = "https://graph.microsoft.com/.default"

	// tokenExpiryMargin renews the cached app token this long before the
	// token endpoint says it expires, so an in-flight request never rides a
	// just-expired one.
	tokenExpiryMargin = time.Minute

	// responseLimit bounds how much of a Graph response body is read. Profile
	// and meeting payloads are a few KB; anything larger is malformed.
	responseLimit = 1 << 20
)

// ErrNotFound marks a 404 from Graph — the directory object doesn't exist
// (user not in the tenant, or no manager assigned). Callers treat it as an
// empty result, not a failure.
var ErrNotFound = errors.New("msgraph: not found")

// ErrSignInRequired marks a delegated call the user's own token can no longer
// make: Graph refused it (401), or the token endpoint would not renew it
// (consent revoked, password changed, refresh token expired). Only signing in
// again fixes it.
var ErrSignInRequired = errors.New("msgraph: sign-in required")

// ErrForbidden marks a 403: the user may not do this, e.g. share an item they
// can only read.
var ErrForbidden = errors.New("msgraph: forbidden")

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
	creds   *clientcredentials.Config
	baseURL string
	client  *http.Client
	// tokens is the client-credentials grant behind golang.org/x/oauth2's
	// caching ReuseTokenSource: it fetches once, serves the cached token
	// until tokenExpiryMargin before expiry, and serialises refreshes.
	tokens oauth2.TokenSource
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
	creds := &clientcredentials.Config{
		ClientID:     strings.TrimSpace(cfg.ClientID),
		ClientSecret: strings.TrimSpace(cfg.ClientSecret),
		TokenURL:     tokenURL,
		Scopes:       []string{defaultScope},
		// Entra ID's documented client-credentials request carries the
		// credentials in the form body.
		AuthStyle: oauth2.AuthStyleInParams,
	}
	// The token source outlives any one request, so it gets a background
	// context carrying the client's http.Client (its timeout bounds each
	// token fetch) rather than a caller's request context.
	tokenCtx := context.WithValue(context.Background(), oauth2.HTTPClient, client)
	return &Client{
		creds:   creds,
		baseURL: strings.TrimRight(baseURL, "/"),
		client:  client,
		tokens:  oauth2.ReuseTokenSourceWithExpiry(nil, creds.TokenSource(tokenCtx), tokenExpiryMargin),
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

// FindUserByEmail resolves a user by their mail attribute via an OData
// filter. The plain /users/{key} path treats an email as a userPrincipalName,
// which 404s in tenants where mail != UPN — this is the fallback that keeps
// email-keyed resolution working there. ErrNotFound when no user carries the
// address.
func (c *Client) FindUserByEmail(ctx context.Context, email string) (*UserProfile, error) {
	// OData string literals escape single quotes by doubling them.
	filter := "mail eq '" + strings.ReplaceAll(email, "'", "''") + "'"
	var res struct {
		Value []UserProfile `json:"value"`
	}
	path := "/users" + profileSelect + "&$top=1&$filter=" + url.QueryEscape(filter)
	if err := c.doJSON(ctx, http.MethodGet, path, nil, &res); err != nil {
		return nil, err
	}
	if len(res.Value) == 0 {
		return nil, ErrNotFound
	}
	return &res.Value[0], nil
}

// ResolveUserByEmail resolves an email to a directory profile. The app's
// source of truth is the OIDC email claim, which for Entra ID is the mail
// attribute — so the mail filter runs FIRST. Matching against UPNs first
// risks the wrong person in tenants where logins and mailboxes use different
// local parts (e.g. UPN firstname.lastname@ vs mail firstname@ — one user's
// mail can equal ANOTHER user's UPN). The UPN-keyed lookup remains as the
// fallback for accounts whose mail attribute is unset (their email claim was
// the UPN). Oid-keyed callers should use GetUserProfile directly.
func (c *Client) ResolveUserByEmail(ctx context.Context, email string) (*UserProfile, error) {
	p, err := c.FindUserByEmail(ctx, email)
	if err == nil {
		return p, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return nil, err
	}
	return c.GetUserProfile(ctx, email)
}

// UserAccount is one directory account's sign-in standing.
type UserAccount struct {
	ID string `json:"id"`
	// AccountEnabled is false for an account disabled in Entra (it can no
	// longer sign in). Graph returns it only when selected; nil means it
	// wasn't reported, which never counts as disabled.
	AccountEnabled *bool `json:"accountEnabled"`
}

// Enabled reports whether the account can sign in. An unreported flag
// counts as enabled: missing data is never grounds to lock someone out.
func (a UserAccount) Enabled() bool {
	return a.AccountEnabled == nil || *a.AccountEnabled
}

// ListUserAccounts returns every user account in the tenant with its enabled
// flag, following Graph's paging to the end: one call per 999 accounts, so a
// whole-tenant check stays cheap enough to run every few minutes. A page
// link pointing anywhere but this client's Graph base URL is refused rather
// than sent the bearer token.
func (c *Client) ListUserAccounts(ctx context.Context) ([]UserAccount, error) {
	var accounts []UserAccount
	path := "/users?$select=id,accountEnabled&$top=999"
	for path != "" {
		var page struct {
			Value    []UserAccount `json:"value"`
			NextLink string        `json:"@odata.nextLink"`
		}
		if err := c.doJSON(ctx, http.MethodGet, path, nil, &page); err != nil {
			return nil, err
		}
		accounts = append(accounts, page.Value...)
		path = ""
		if page.NextLink != "" {
			rest, ok := strings.CutPrefix(page.NextLink, c.baseURL+"/")
			if !ok {
				return nil, errors.New("msgraph: next page link is outside the Graph base URL")
			}
			path = "/" + rest
		}
	}
	return accounts, nil
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

// MeetingAttendee identifies one invitee. ObjectID (the AAD object id) is
// what actually lands the person on the meeting roster for app-only created
// meetings — a bare UPN frequently fails to resolve there and leaves the
// participant list empty. UPN rides along as the display/resolution fallback.
type MeetingAttendee struct {
	UPN      string
	ObjectID string
}

// OnlineMeetingRequest describes the Teams meeting to create.
type OnlineMeetingRequest struct {
	Subject   string
	StartAt   time.Time
	EndAt     time.Time
	Attendees []MeetingAttendee
}

// OnlineMeeting is the created meeting slice the app needs.
type OnlineMeeting struct {
	ID      string `json:"id"`
	JoinURL string `json:"joinWebUrl"`
	Subject string `json:"subject"`
}

type meetingParticipantIdentity struct {
	User struct {
		ID string `json:"id"`
	} `json:"user"`
}

type meetingParticipantPayload struct {
	UPN      string                      `json:"upn,omitempty"`
	Role     string                      `json:"role"`
	Identity *meetingParticipantIdentity `json:"identity,omitempty"`
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
	payload.Participants.Attendees = make([]meetingParticipantPayload, 0, len(req.Attendees))
	for _, a := range req.Attendees {
		if strings.TrimSpace(a.UPN) == "" && strings.TrimSpace(a.ObjectID) == "" {
			continue
		}
		p := meetingParticipantPayload{UPN: a.UPN, Role: "attendee"}
		if a.ObjectID != "" {
			p.Identity = &meetingParticipantIdentity{}
			p.Identity.User.ID = a.ObjectID
		}
		payload.Participants.Attendees = append(payload.Participants.Attendees, p)
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

// token returns a valid app-only bearer token from the caching token source.
// A token-endpoint rejection is reduced to its status and OAuth error code:
// oauth2.RetrieveError's own message embeds the raw response body (trace and
// correlation ids, tenant detail), which must not reach logs.
func (c *Client) token() (string, error) {
	tok, err := c.tokens.Token()
	if err != nil {
		if re, ok := errors.AsType[*oauth2.RetrieveError](err); ok {
			if re.ErrorCode != "" {
				return "", fmt.Errorf("msgraph: token request failed with status %d (code %s)", re.Response.StatusCode, re.ErrorCode)
			}
			return "", fmt.Errorf("msgraph: token request failed with status %d", re.Response.StatusCode)
		}
		return "", fmt.Errorf("msgraph: token request: %w", err)
	}
	return tok.AccessToken, nil
}

// doJSON authenticates, performs one Graph call, and decodes the JSON
// response into dest.
func (c *Client) doJSON(ctx context.Context, method, path string, payload, dest any) error {
	tok, err := c.token()
	if err != nil {
		return err
	}
	return call(ctx, c.client, c.baseURL+path, tok, method, payload, dest)
}

// StatusError is a non-2xx Graph response other than 404. It carries Graph's
// machine-readable error code but never its message: bodies are not echoed
// into errors, since they can carry directory PII.
type StatusError struct {
	Status int
	Code   string
}

func (e *StatusError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("msgraph: request failed with status %d (code %s)", e.Status, e.Code)
	}
	return fmt.Sprintf("msgraph: request failed with status %d", e.Status)
}

// Is lets callers test a refusal by kind: a 401 is ErrSignInRequired (the
// token was refused), a 403 ErrForbidden.
func (e *StatusError) Is(target error) bool {
	switch target {
	case ErrSignInRequired:
		return e.Status == http.StatusUnauthorized
	case ErrForbidden:
		return e.Status == http.StatusForbidden
	}
	return false
}

// call performs one authenticated Graph request and decodes the JSON
// response into dest (nil for a response without a body). 404 maps to
// ErrNotFound, any other non-2xx to a *StatusError.
func call(ctx context.Context, client *http.Client, rawURL, token, method string, payload, dest any) error {
	var body io.Reader
	if payload != nil {
		body = bytes.NewReader(mustJSON(json.Marshal(payload)))
	}
	req := mustRequest(http.NewRequestWithContext(ctx, method, rawURL, body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("msgraph: request: %w", err)
	}
	defer drainClose(res.Body)
	if res.StatusCode == http.StatusNotFound {
		return ErrNotFound
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		// Surface Graph's machine-readable error code so ops can tell a
		// consent problem from a malformed request.
		var ge struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		_ = json.NewDecoder(io.LimitReader(res.Body, responseLimit)).Decode(&ge)
		return &StatusError{Status: res.StatusCode, Code: ge.Error.Code}
	}
	if dest == nil {
		return nil
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
