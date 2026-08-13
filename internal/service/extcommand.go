package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// Mattermost-compatible slash commands (docs/rfc-generic-bots-mcp.md §2).
//
// An admin registers a trigger word and a request URL; ex sends the invocation in
// MM's exact slash-command shape and applies MM's response shape. An existing MM
// slash-command integration therefore works unchanged.
//
// The important difference from an outgoing webhook is that a command has a LIVE
// HTTP CALLER — the person who typed it. That makes MM's `ephemeral` response
// type genuinely implementable (the text goes back in that response and is seen by
// nobody else), where an ephemeral bot-dispatch reply can only be dropped.

// External-command validation errors. Handlers map these to 4xx.
var (
	ErrInvalidTrigger     = errors.New("command: trigger must be 1-32 characters, lowercase, no whitespace or slash")
	ErrTriggerReserved    = errors.New("command: trigger is already used by a built-in command")
	ErrTriggerTaken       = errors.New("command: trigger is already registered")
	ErrInvalidRequestURL  = errors.New("command: request URL must be a public https endpoint")
	ErrCommandRunFailed   = errors.New("command: integration failed")
	ErrResponseURLExpired = errors.New("command: response URL has expired")
)

const (
	maxTriggerLen     = 32
	maxCommandTextLen = 4000
)

// CommandResponseStore holds the one-shot delayed-response tokens (MM's
// response_url). An interface so the delivery path is testable without Redis;
// satisfied by *store.CommandResponseStore.
type CommandResponseStore interface {
	Put(ctx context.Context, token string, p *store.PendingCommandResponse) error
	Get(ctx context.Context, token string) (*store.PendingCommandResponse, error)
	Delete(ctx context.Context, token string)
}

// ExternalCommandService owns admin-registered slash commands: their CRUD, their
// invocation, and the delayed-response tokens they hand out.
type ExternalCommandService struct {
	store     store.ExternalCommandStore
	messages  *MessageService
	responses CommandResponseStore
	resolver  BotContextResolver
	// baseURL is ex's public origin, used to build the response_url handed to
	// integrations. Without it, delayed responses are simply not offered.
	baseURL string
	// reserved holds the built-in command triggers, so an external command can
	// never shadow one (the built-in would always win at dispatch, leaving the
	// external command silently dead).
	reserved func() map[string]bool

	// listCache is a short read-through cache of the command list. The "/"
	// autocomplete fetches it on every composer mount, which would otherwise be a
	// directory read + BatchGet per mount; invocation does NOT use this cache, so a
	// new command is runnable immediately even while an older list is still served.
	listMu     sync.Mutex
	listCache  []*model.ExternalCommand
	listCached time.Time
}

// extCommandListTTL bounds how stale an autocomplete list may be.
const extCommandListTTL = 15 * time.Second

// ExternalCommandDeps is the dependency set of ExternalCommandService.
type ExternalCommandDeps struct {
	Store    store.ExternalCommandStore
	Messages *MessageService
	// Responses enables delayed responses (response_url). Nil disables them: the
	// field is then omitted from the request payload, which MM integrations treat
	// as "answer synchronously".
	Responses CommandResponseStore
	Resolver  BotContextResolver
	BaseURL   string
	// Reserved returns the built-in triggers at validation time (the built-in
	// registry is populated during wiring, so this is a func, not a snapshot).
	Reserved func() map[string]bool
}

func NewExternalCommandService(d ExternalCommandDeps) *ExternalCommandService {
	reserved := d.Reserved
	if reserved == nil {
		reserved = func() map[string]bool { return nil }
	}
	return &ExternalCommandService{
		store:     d.Store,
		messages:  d.Messages,
		responses: d.Responses,
		resolver:  d.Resolver,
		baseURL:   strings.TrimRight(d.BaseURL, "/"),
		reserved:  reserved,
	}
}

// NormalizeTrigger lowercases a trigger and strips a leading slash, then validates
// it. Exported because the admin handler normalizes before echoing the value back.
func NormalizeTrigger(raw string) (string, error) {
	t := strings.ToLower(strings.TrimSpace(raw))
	t = strings.TrimPrefix(t, "/")
	if t == "" || utf8.RuneCountInString(t) > maxTriggerLen {
		return "", ErrInvalidTrigger
	}
	if strings.ContainsAny(t, " \t\n\r/") {
		return "", ErrInvalidTrigger
	}
	return t, nil
}

// CreateCommand registers a new external slash command and returns it along with
// the shared token, which is revealed here and never again — the integration must
// capture it now. (Unlike a bot token this is not hashed at rest: ex has to *send*
// it on every invocation, so it is recoverable by design; it is simply never
// serialized to a client after creation.)
func (s *ExternalCommandService) CreateCommand(ctx context.Context, actorID string, in *model.ExternalCommand) (*model.ExternalCommand, error) {
	cmd, err := s.validate(in)
	if err != nil {
		return nil, err
	}
	if s.reserved()[cmd.Trigger] {
		return nil, ErrTriggerReserved
	}

	var b [24]byte
	// randRead is the package's fault-injection seam (see auth.go), so this arm
	// stays reachable from a test instead of being uncoverable dead code.
	if _, err := randRead(b[:]); err != nil {
		return nil, fmt.Errorf("command: token: %w", err)
	}
	now := time.Now()
	cmd.ID = store.NewID()
	cmd.Token = "excmd_" + base64.RawURLEncoding.EncodeToString(b[:])
	cmd.CreatedBy = actorID
	cmd.CreatedAt = now
	cmd.UpdatedAt = now

	if err := s.store.CreateCommand(ctx, cmd); err != nil {
		if errors.Is(err, store.ErrAlreadyExists) {
			return nil, ErrTriggerTaken
		}
		return nil, err
	}
	s.invalidateList()
	return cmd, nil
}

// UpdateCommand replaces the mutable fields of an existing command. The trigger is
// NOT mutable: it is a claimed unique key, and moving it would need the claim row
// to move atomically with the update. Callers rename by deleting and re-creating,
// which the admin UI does explicitly rather than hiding a delete inside an edit.
func (s *ExternalCommandService) UpdateCommand(ctx context.Context, id string, in *model.ExternalCommand) (*model.ExternalCommand, error) {
	existing, err := s.store.GetCommand(ctx, id)
	if err != nil {
		return nil, err
	}
	in.Trigger = existing.Trigger
	next, err := s.validate(in)
	if err != nil {
		return nil, err
	}
	// Identity, credential, and provenance stay with the original row.
	next.ID = existing.ID
	next.Token = existing.Token
	next.CreatedBy = existing.CreatedBy
	next.CreatedAt = existing.CreatedAt
	next.UpdatedAt = time.Now()
	if err := s.store.UpdateCommand(ctx, next); err != nil {
		return nil, err
	}
	s.invalidateList()
	return next, nil
}

func (s *ExternalCommandService) GetCommand(ctx context.Context, id string) (*model.ExternalCommand, error) {
	return s.store.GetCommand(ctx, id)
}

func (s *ExternalCommandService) DeleteCommand(ctx context.Context, id string) error {
	if err := s.store.DeleteCommand(ctx, id); err != nil {
		return err
	}
	s.invalidateList()
	return nil
}

// ListAll returns every registered command (admin view).
func (s *ExternalCommandService) ListAll(ctx context.Context) ([]*model.ExternalCommand, error) {
	return s.store.ListCommands(ctx)
}

// validate normalizes and checks the admin-supplied fields, returning a copy.
func (s *ExternalCommandService) validate(in *model.ExternalCommand) (*model.ExternalCommand, error) {
	if in == nil {
		return nil, ErrInvalidTrigger
	}
	trigger, err := NormalizeTrigger(in.Trigger)
	if err != nil {
		return nil, err
	}
	requestURL := strings.TrimSpace(in.RequestURL)
	// Same SSRF boundary as bot callbacks: public https only, re-checked at dial
	// time. A command URL is admin-supplied, but admins are not the SSRF threat
	// model here — a copy-pasted internal URL is.
	if err := validateCallbackURL(requestURL); err != nil {
		return nil, ErrInvalidRequestURL
	}
	if in.BotUserID != "" && !model.IsBotUserID(in.BotUserID) {
		return nil, fmt.Errorf("command: bot_user_id must be a bot account id")
	}
	out := *in
	out.Trigger = trigger
	out.RequestURL = requestURL
	out.Method = out.NormalizedMethod()
	out.Title = clampRunes(strings.TrimSpace(out.Title), 100)
	out.Description = clampRunes(strings.TrimSpace(out.Description), 500)
	out.AutocompleteHint = clampRunes(strings.TrimSpace(out.AutocompleteHint), 100)
	out.Username = clampRunes(strings.TrimSpace(out.Username), MaxUserDisplayNameLen)
	out.IconURL = strings.TrimSpace(out.IconURL)
	return &out, nil
}

func (s *ExternalCommandService) invalidateList() {
	s.listMu.Lock()
	s.listCache, s.listCached = nil, time.Time{}
	s.listMu.Unlock()
}

// cachedList serves the autocomplete list through the short TTL cache.
func (s *ExternalCommandService) cachedList(ctx context.Context) []*model.ExternalCommand {
	s.listMu.Lock()
	if s.listCache != nil && time.Since(s.listCached) < extCommandListTTL {
		out := s.listCache
		s.listMu.Unlock()
		return out
	}
	s.listMu.Unlock()

	cmds, err := s.store.ListCommands(ctx)
	if err != nil {
		slog.Warn("command: list for autocomplete failed", "error", err)
		return nil
	}
	s.listMu.Lock()
	s.listCache, s.listCached = cmds, time.Now()
	s.listMu.Unlock()
	return cmds
}

// ListCommands implements ExternalCommandRunner: the commands to offer in the "/"
// autocomplete.
func (s *ExternalCommandService) ListCommands(ctx context.Context) []CommandInfo {
	cmds := s.cachedList(ctx)
	out := make([]CommandInfo, 0, len(cmds))
	for _, c := range cmds {
		if c == nil {
			continue
		}
		desc := c.Description
		if desc == "" {
			desc = c.Title
		}
		if c.AutocompleteHint != "" {
			desc = strings.TrimSpace(c.AutocompleteHint + " — " + desc)
		}
		out = append(out, CommandInfo{Name: c.Trigger, Description: desc})
	}
	return out
}

// RunCommand implements ExternalCommandRunner: resolve the trigger and invoke it.
// Returns ErrUnknownCommand when no external command owns the trigger, so the
// registry can report a clean 404.
func (s *ExternalCommandService) RunCommand(ctx context.Context, trigger string, req CommandRequest) (CommandResult, error) {
	cmd, err := s.store.GetCommandByTrigger(ctx, trigger)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return CommandResult{}, fmt.Errorf("command %q: %w", trigger, ErrUnknownCommand)
		}
		return CommandResult{}, err
	}
	return s.invoke(ctx, cmd, req)
}

// commandResponseWire is MM's slash-command response payload.
type commandResponseWire struct {
	ResponseType string                    `json:"response_type"` // "ephemeral" (MM default) | "in_channel"
	Text         string                    `json:"text"`
	Username     string                    `json:"username"`
	IconURL      string                    `json:"icon_url"`
	GotoLocation string                    `json:"goto_location"`
	Attachments  []model.MessageAttachment `json:"attachments"`
}

// invoke calls the integration and applies its response.
func (s *ExternalCommandService) invoke(ctx context.Context, cmd *model.ExternalCommand, req CommandRequest) (CommandResult, error) {
	// Access is checked BEFORE the integration is told anything: the payload
	// carries the channel id, so calling out first would leak which chats exist to
	// a user probing with a channel id they can't see.
	if err := s.messages.CheckAccess(ctx, req.UserID, req.ParentID, req.ParentType); err != nil {
		return CommandResult{}, err
	}
	if utf8.RuneCountInString(req.Text) > maxCommandTextLen {
		return CommandResult{}, &CommandUserError{Message: "That command's text is too long."}
	}

	responseToken := s.mintResponseToken(ctx, cmd, req)
	res, err := s.callIntegration(ctx, cmd, req, responseToken)
	if err != nil {
		// The token is useless now and would otherwise sit in Redis until its TTL.
		if responseToken != "" && s.responses != nil {
			s.responses.Delete(ctx, responseToken)
		}
		return CommandResult{}, err
	}

	out := CommandResult{GotoLocation: safeGotoLocation(res.GotoLocation)}
	// MM defaults an unset response_type to ephemeral, so a command that answers
	// with bare text does NOT spam the channel. Matching that default matters:
	// getting it backwards would publish output an integration expected to be
	// private.
	if !strings.EqualFold(strings.TrimSpace(res.ResponseType), MMResponseTypeInChannel) {
		out.EphemeralText = clampRunes(res.Text, maxCommandTextLen)
		return out, nil
	}
	if strings.TrimSpace(res.Text) == "" && len(res.Attachments) == 0 {
		return out, nil
	}

	msg, err := s.postCommandResponse(ctx, cmd, req, "", res)
	if err != nil {
		return CommandResult{}, err
	}
	out.Message = msg
	// A delayed response now threads under the message this one created, so a
	// progress-then-result integration reads as one exchange.
	if responseToken != "" && msg != nil {
		s.rethreadResponseToken(ctx, responseToken, msg.ID)
	}
	return out, nil
}

// postCommandResponse posts an in_channel command response, authored by the
// command's bot when it has one and by the webhook sentinel otherwise.
func (s *ExternalCommandService) postCommandResponse(
	ctx context.Context,
	cmd *model.ExternalCommand,
	req CommandRequest,
	rootMessageID string,
	res commandResponseWire,
) (*model.Message, error) {
	// PostBotCard re-checks the INVOKING user's access before posting, so a
	// delayed response can never post somewhere the invoker has since lost access
	// to (removed from a private channel while the integration was working).
	return s.messages.PostBotCard(ctx, BotCardInput{
		RequestUserID:   req.UserID,
		AuthorID:        cmd.BotUserID,
		Username:        firstNonEmpty(res.Username, cmd.Username, cmd.Trigger),
		IconURL:         firstNonEmpty(res.IconURL, cmd.IconURL),
		ParentID:        req.ParentID,
		ParentType:      req.ParentType,
		ParentMessageID: rootMessageID,
		Body:            res.Text,
		Attachments:     PrepareActions(res.Attachments),
	})
}

// callIntegration sends the invocation in MM's slash-command shape. POST is
// form-encoded (MM's default); GET puts the same fields in the query string.
func (s *ExternalCommandService) callIntegration(
	ctx context.Context,
	cmd *model.ExternalCommand,
	req CommandRequest,
	responseToken string,
) (commandResponseWire, error) {
	mc := resolveMMContext(ctx, s.resolver, req.ParentID, req.ParentType, req.UserID)
	form := url.Values{}
	form.Set("token", cmd.Token)
	form.Set("team_id", MMSyntheticTeamID)
	form.Set("team_domain", MMSyntheticTeamDomain)
	form.Set("channel_id", req.ParentID)
	form.Set("channel_name", mc.ChannelSlug)
	form.Set("user_id", req.UserID)
	form.Set("user_name", mc.UserName)
	form.Set("command", "/"+cmd.Trigger)
	form.Set("text", req.Text)
	form.Set("trigger_id", store.NewID())
	form.Set("timestamp", strconv.FormatInt(time.Now().Unix(), 10))
	if responseToken != "" {
		form.Set("response_url", s.responseURL(responseToken))
	}

	var httpReq *http.Request
	var err error
	if cmd.NormalizedMethod() == model.CommandMethodGet {
		target := cmd.RequestURL
		// Preserve any query the admin already put on the URL.
		if strings.Contains(target, "?") {
			target += "&" + form.Encode()
		} else {
			target += "?" + form.Encode()
		}
		httpReq, err = http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	} else {
		httpReq, err = http.NewRequestWithContext(ctx, http.MethodPost, cmd.RequestURL, strings.NewReader(form.Encode()))
		if httpReq != nil {
			httpReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		}
	}
	if err != nil {
		return commandResponseWire{}, err
	}
	httpReq.Header.Set("Accept", "application/json")

	res, err := botWebhookClient.Do(httpReq)
	if err != nil {
		slog.Warn("command: integration call failed", "trigger", cmd.Trigger, "error", err)
		return commandResponseWire{}, fmt.Errorf("%w: %v", ErrCommandRunFailed, err)
	}
	defer func() { _, _ = io.Copy(io.Discard, res.Body); _ = res.Body.Close() }()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		slog.Warn("command: integration returned error status", "trigger", cmd.Trigger, "status", res.StatusCode)
		return commandResponseWire{}, fmt.Errorf("%w: status %d", ErrCommandRunFailed, res.StatusCode)
	}
	var out commandResponseWire
	// An empty body is a valid "done, nothing to say" — the same contract as bot
	// replies and action callbacks.
	_ = json.NewDecoder(io.LimitReader(res.Body, botReplyMaxBytes)).Decode(&out)
	return out, nil
}

// mintResponseToken creates the one-shot delayed-response credential. Returns ""
// when delayed responses are unavailable (no Redis store or no base URL), in
// which case response_url is simply omitted.
func (s *ExternalCommandService) mintResponseToken(ctx context.Context, cmd *model.ExternalCommand, req CommandRequest) string {
	if s.responses == nil || s.baseURL == "" {
		return ""
	}
	var b [32]byte
	if _, err := randRead(b[:]); err != nil {
		return ""
	}
	token := base64.RawURLEncoding.EncodeToString(b[:])
	if err := s.responses.Put(ctx, token, &store.PendingCommandResponse{
		CommandID:  cmd.ID,
		Trigger:    cmd.Trigger,
		UserID:     req.UserID,
		ParentID:   req.ParentID,
		ParentType: req.ParentType,
		BotUserID:  cmd.BotUserID,
		Username:   firstNonEmpty(cmd.Username, cmd.Trigger),
		IconURL:    cmd.IconURL,
	}); err != nil {
		slog.Warn("command: minting response_url failed", "trigger", cmd.Trigger, "error", err)
		return ""
	}
	return token
}

func (s *ExternalCommandService) responseURL(token string) string {
	return s.baseURL + "/hooks/commands/" + token
}

// rethreadResponseToken records the message the synchronous response created, so a
// later delayed response threads under it.
func (s *ExternalCommandService) rethreadResponseToken(ctx context.Context, token, rootMessageID string) {
	if s.responses == nil {
		return
	}
	p, err := s.responses.Get(ctx, token)
	if err != nil || p == nil {
		return
	}
	p.RootMessageID = rootMessageID
	if err := s.responses.Put(ctx, token, p); err != nil {
		slog.Debug("command: rethreading response token failed", "error", err)
	}
}

// DeliverDelayedResponse posts a response an integration sent to a response_url.
// The token is the only credential, so everything about *where* this may post
// comes from what was pinned at mint time — never from the request body.
func (s *ExternalCommandService) DeliverDelayedResponse(ctx context.Context, token string, body io.Reader) error {
	if s.responses == nil {
		return ErrResponseURLExpired
	}
	pending, err := s.responses.Get(ctx, token)
	if err != nil {
		return err
	}
	if pending == nil {
		return ErrResponseURLExpired
	}
	var res commandResponseWire
	if err := json.NewDecoder(io.LimitReader(body, botReplyMaxBytes)).Decode(&res); err != nil {
		return fmt.Errorf("command: malformed delayed response: %w", err)
	}
	if strings.TrimSpace(res.Text) == "" && len(res.Attachments) == 0 {
		return nil
	}
	// A delayed response has no live caller to show ephemeral text to, so — unlike
	// the synchronous path — ephemeral here means "nothing to deliver" rather than
	// defaulting to a channel post. MM also defaults a BLANK response_type to
	// ephemeral, so only an explicit in_channel may go public: anything else
	// posted here would publish output the integration expected to be private.
	if !strings.EqualFold(strings.TrimSpace(res.ResponseType), MMResponseTypeInChannel) {
		slog.Debug("command: dropping ephemeral delayed response", "trigger", pending.Trigger)
		return nil
	}

	_, err = s.messages.PostBotCard(ctx, BotCardInput{
		RequestUserID:   pending.UserID,
		AuthorID:        pending.BotUserID,
		Username:        firstNonEmpty(res.Username, pending.Username, pending.Trigger),
		IconURL:         firstNonEmpty(res.IconURL, pending.IconURL),
		ParentID:        pending.ParentID,
		ParentType:      pending.ParentType,
		ParentMessageID: pending.RootMessageID,
		Body:            res.Text,
		Attachments:     PrepareActions(res.Attachments),
	})
	return err
}

// safeGotoLocation filters MM's goto_location, which the client navigates to. Only
// http(s) survives — a javascript: or data: URL here would be a redirect-to-XSS
// handed straight to the browser.
func safeGotoLocation(raw string) string {
	loc := strings.TrimSpace(raw)
	if loc == "" {
		return ""
	}
	u, err := url.Parse(loc)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return ""
	}
	return loc
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
