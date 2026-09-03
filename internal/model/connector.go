package model

import (
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
	UserID        string    `json:"userID" dynamodbav:"userID"`
	ConnectorSlug string    `json:"connectorSlug" dynamodbav:"connectorSlug"`
	Token         string    `json:"-" dynamodbav:"token"`
	// Status: "connected" (verify passed) or "unverified" (verify endpoint
	// unreachable from the server — token accepted, will be proven at use).
	Status      string    `json:"status" dynamodbav:"status"`
	ConnectedAs string    `json:"connectedAs,omitempty" dynamodbav:"connectedAs,omitempty"`
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
	ConnectorTokenMaxLen       = 4096
)

// Connector auth kinds.
const (
	ConnectorAuthPaste    = "paste"
	ConnectorAuthPassword = "password"
	// ConnectorAuthNone: the service needs no credential (anonymous access) —
	// install is a bare "connect", calls carry no Authorization header.
	ConnectorAuthNone = "none"
)

// Connector install statuses.
const (
	ConnectorStatusConnected  = "connected"
	ConnectorStatusUnverified = "unverified"
)
