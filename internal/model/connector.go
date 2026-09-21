package model

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// Connectors give agents API access to external services. A connector is a
// docs bundle (index.yml + per-service endpoint YAMLs + a grep catalog)
// authored to the connector standard, plus just enough auth metadata for Ex
// to collect a per-user credential at install time. Admin-managed; users
// install and connect their own account.
type Connector struct {
	Slug        string `json:"slug" dynamodbav:"slug"`
	Title       string `json:"title" dynamodbav:"title"`
	Description string `json:"description" dynamodbav:"description"`
	BaseURL     string `json:"baseURL" dynamodbav:"baseURL"`

	// AuthKind: how a user connects.
	//   "paste"    — paste a bearer token (the only option).
	//   "password" — sign in with email/password (DT auth password grant),
	//                with paste-a-token always available as a fallback.
	AuthKind string `json:"authKind" dynamodbav:"authKind"`
	// TokenURL + ClientID drive the password grant (AuthKind "password").
	TokenURL string `json:"tokenURL,omitempty" dynamodbav:"tokenURL,omitempty"`
	ClientID string `json:"clientID,omitempty" dynamodbav:"clientID,omitempty"`
	// VerifyURL is an authenticated GET used to validate a credential at
	// install time ("connected as {name}").
	VerifyURL string `json:"verifyURL,omitempty" dynamodbav:"verifyURL,omitempty"`
	// AuthHeader is HOW a credential rides a request: a header template with
	// {token} in it — "X-Api-Key: {token}" for Metabase API keys, or
	// "X-Metabase-Session: {token}". Empty means the default
	// "Authorization: Bearer {token}". Admin-owned (it comes with the
	// registration, never from KB content) and it changes only the header
	// shape, never the destination — the host stays pinned to BaseURL.
	AuthHeader string `json:"authHeader,omitempty" dynamodbav:"authHeader,omitempty"`

	// StartURL is the SSO entry point opened by an sso_window connect; the
	// service redirects through its own login (silent when the user holds a
	// live Microsoft session) and lands on a URL matching CapturePattern
	// (e.g. "/callback?token={token}"), from which the shell captures the
	// service-minted bearer.
	StartURL       string `json:"startURL,omitempty" dynamodbav:"startURL,omitempty"`
	CapturePattern string `json:"capturePattern,omitempty" dynamodbav:"capturePattern,omitempty"`

	// Revision is the provider's content hash for the ingested bundle. The
	// periodic provider sync skips any connector whose provider revision
	// still equals this, so an unchanged catalog costs one listing fetch.
	// Empty for connectors ingested by direct admin upload — those never
	// match a provider revision and are re-pulled on the next sync.
	Revision string `json:"revision,omitempty" dynamodbav:"revision,omitempty"`

	// FileNames is the docs-bundle manifest; contents live in separate rows.
	FileNames []string `json:"fileNames" dynamodbav:"fileNames"`

	// Services is the parsed services: manifest from the bundle's index.yml —
	// the hierarchy layer between the connector and its endpoint docs (which
	// service file owns which domain). Validated at ingest: every entry must
	// resolve to a shipped file and every service file must be listed.
	Services []ConnectorServiceInfo `json:"services,omitempty" dynamodbav:"services,omitempty"`

	CreatedBy string    `json:"createdBy" dynamodbav:"createdBy"`
	CreatedAt time.Time `json:"createdAt" dynamodbav:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt" dynamodbav:"updatedAt"`
}

// EnvPrefix is the env-var prefix agents use for this connector's
// credentials: cliffhub → CLIFFHUB_TOKEN / CLIFFHUB_APP_URL.
func (c *Connector) EnvPrefix() string {
	up := strings.ToUpper(c.Slug)
	return envUnsafe.ReplaceAllString(up, "_")
}

var envUnsafe = regexp.MustCompile(`[^A-Z0-9]`)

// ConnectorFile is one docs file in a connector's bundle.
type ConnectorFile struct {
	Slug    string `json:"slug" dynamodbav:"slug"`
	Name    string `json:"name" dynamodbav:"name"`
	Content string `json:"content" dynamodbav:"content"`
}

// ConnectorServiceInfo is one entry of a connector's service manifest
// (index.yml services:) — name, owning file, and what the domain covers.
type ConnectorServiceInfo struct {
	Name        string `json:"name" dynamodbav:"name"`
	File        string `json:"file" dynamodbav:"file"`
	Endpoints   int    `json:"endpoints,omitempty" dynamodbav:"endpoints,omitempty"`
	Description string `json:"description,omitempty" dynamodbav:"description,omitempty"`
	// RoutePrefixes are the distinct route_id prefixes found in this
	// service's endpoint docs (e.g. tasks-and-stories.yaml → ["work"]).
	// Manifest names and route prefixes often differ — scoped catalog greps
	// must use these, not the service name.
	RoutePrefixes []string `json:"routePrefixes,omitempty" dynamodbav:"routePrefixes,omitempty"`
}

// ConnectorInstall is one user's connection to a connector. The token is the
// user's own credential for that service (stored server-side for v1; the
// runner injects it into agent runs as $<PREFIX>_TOKEN).
type ConnectorInstall struct {
	UserID        string `json:"userID" dynamodbav:"userID"`
	ConnectorSlug string `json:"connectorSlug" dynamodbav:"connectorSlug"`
	Token         string `json:"-" dynamodbav:"token"`
	// Status: "connected" (verify passed) or "unverified" (verify endpoint
	// unreachable from the server — token accepted, will be proven at use).
	Status      string `json:"status" dynamodbav:"status"`
	ConnectedAs string `json:"connectedAs,omitempty" dynamodbav:"connectedAs,omitempty"`
	// Identity is the raw verify-endpoint response captured at connect time —
	// the caller's own profile on that service (ids, name, email). Synced to
	// runs as _identity.json so agents resolve "who am I" locally instead of
	// burning an auth/me call every run. Never in API JSON (runner path only).
	Identity string `json:"-" dynamodbav:"identity,omitempty"`
	// AgentUse: may an AGENT attach this connector to a run itself (via the
	// use_connector tool) when the user didn't /pick it?
	//   "ask" (default, empty = ask) — one approval card per run
	//   "always" — auto-attach, no ask
	//   "never"  — only explicit /picks work
	AgentUse    string    `json:"agentUse,omitempty" dynamodbav:"agentUse,omitempty"`
	InstalledAt time.Time `json:"installedAt" dynamodbav:"installedAt"`
	UpdatedAt   time.Time `json:"updatedAt" dynamodbav:"updatedAt"`
}

// Connector agent-use policies.
const (
	ConnectorAgentUseAsk    = "ask"
	ConnectorAgentUseAlways = "always"
	ConnectorAgentUseNever  = "never"
)

// Connector bounds.
const (
	ConnectorSlugMaxLen        = 64
	ConnectorTitleMaxLen       = 128
	ConnectorDescriptionMaxLen = 1024
	ConnectorFileMaxBytes      = 350 * 1024 // stay under the DynamoDB item cap
	ConnectorMaxFiles          = 64
	ConnectorFileNameMaxLen    = 128
	ConnectorTokenMaxLen       = 4096
)

// Connector auth kinds.
const (
	ConnectorAuthPaste    = "paste"
	ConnectorAuthPassword = "password"
	// ConnectorAuthSSOWindow: connecting opens the service's own SSO entry
	// point (StartURL) in a shell window — the user signs in with their
	// Microsoft account — and the shell captures the service-minted bearer
	// from the redirect matching CapturePattern (falling back to sniffing the
	// Authorization header on the service's own API calls). Install then
	// proceeds exactly like paste, with the captured token. Web clients
	// without a capture-capable shell fall back to pasting.
	ConnectorAuthSSOWindow = "sso_window"
	// ConnectorAuthNone: the service needs no credential (anonymous access) —
	// install is a bare "connect", calls carry no Authorization header.
	ConnectorAuthNone = "none"
)

// Connector install statuses.
const (
	ConnectorStatusConnected  = "connected"
	ConnectorStatusUnverified = "unverified"
)

// DefaultAuthHeader is the credential header used when a connector sets none.
const DefaultAuthHeader = "Authorization: Bearer {token}"

// RenderAuthHeader turns a connector's AuthHeader template into the header
// (name, value) that carries token. Accepted shapes: "Name: prefix {token}",
// "Name: {token}", "Name: Prefix" (token appended after a space) and a bare
// "Name" (token as the whole value). Empty template → DefaultAuthHeader.
func RenderAuthHeader(template, token string) (name, value string) {
	t := strings.TrimSpace(template)
	if t == "" {
		t = DefaultAuthHeader
	}
	name, rest, hasColon := strings.Cut(t, ":")
	name = strings.TrimSpace(name)
	rest = strings.TrimSpace(rest)
	switch {
	case !hasColon || rest == "":
		return name, token
	case strings.Contains(rest, "{token}"):
		return name, strings.ReplaceAll(rest, "{token}", token)
	default:
		return name, rest + " " + token
	}
}

// CredentialHeader renders this connector's credential header for token.
func (c *Connector) CredentialHeader(token string) (name, value string) {
	return RenderAuthHeader(c.AuthHeader, token)
}

var authHeaderNameRe = regexp.MustCompile(`^[A-Za-z0-9!#$%&'*+.^_\x60|~-]+$`)

// ValidateAuthHeader accepts an empty template or one whose header name is a
// legal HTTP field name and whose value part carries no line breaks — the
// two ways a template could smuggle a second header into every request.
func ValidateAuthHeader(template string) error {
	t := strings.TrimSpace(template)
	if t == "" {
		return nil
	}
	if strings.ContainsAny(t, "\r\n") {
		return errors.New("authHeader must be a single line")
	}
	name, _, _ := strings.Cut(t, ":")
	if !authHeaderNameRe.MatchString(strings.TrimSpace(name)) {
		return fmt.Errorf("authHeader %q: invalid header name", template)
	}
	return nil
}
