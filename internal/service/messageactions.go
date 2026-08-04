package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// Interactive message actions — Mattermost's interactive-message contract
// (docs/rfc-generic-bots-mcp.md §2). An integration posts an attachment carrying
// buttons or a select menu; a member uses one; ex calls the integration back and
// applies whatever it returns.
//
// The client never sees or sends the callback URL: it sends only the action's id,
// and ex resolves the stored model.ActionIntegration server-side. That matters for
// two reasons — the URL and its context are integration-internal config that would
// otherwise leak to every channel member, and a client that could name the URL and
// context could forge a call to the integration with a context of its choosing.

// Action-invocation failures. Handlers map these to 4xx.
var (
	// ErrActionNotFound covers both an unknown action id and one with no
	// integration to call. Undifferentiated on purpose: a client probing ids
	// learns nothing about which exist.
	ErrActionNotFound = errors.New("message: action not found")
	// ErrActionDisabled is a deliberate refusal for an action the integration
	// marked disabled, so the client can say why nothing happened.
	ErrActionDisabled = errors.New("message: action is disabled")
	// ErrActionFailed marks an integration that errored, timed out, or answered
	// with a non-2xx status.
	ErrActionFailed = errors.New("message: action integration failed")
)

// Bounds on interactive attachments. An integration is untrusted input, and every
// action is persisted on the message row and rendered for every member, so the
// per-message counts are capped.
const (
	maxActionsPerAttachment = 5
	maxActionOptions        = 25
	maxActionNameLen        = 100
	// actionContextMaxBytes caps the opaque integration context ex will store and
	// echo back. It rides on the message row, so it cannot be unbounded.
	actionContextMaxBytes = 8 << 10
)

// PrepareActions normalizes the interactive actions on outbound attachments and
// drops anything unusable. Every action that survives has a non-empty, unique id
// and a callable https integration.
//
// Called on every path that persists integration-supplied attachments (bot
// replies, slash-command responses, incoming webhooks), so an action can never
// reach the store unvalidated.
func PrepareActions(atts []model.MessageAttachment) []model.MessageAttachment {
	if len(atts) == 0 {
		return atts
	}
	out := make([]model.MessageAttachment, len(atts))
	copy(out, atts)
	// Ids must be unique per MESSAGE, not per attachment, because an invocation
	// names only the id — a collision across two attachments would be ambiguous.
	seen := make(map[string]bool)
	for i := range out {
		if len(out[i].Actions) == 0 {
			continue
		}
		kept := make([]model.MessageAction, 0, min(len(out[i].Actions), maxActionsPerAttachment))
		for _, a := range out[i].Actions {
			if len(kept) >= maxActionsPerAttachment {
				slog.Warn("message actions: dropping actions over per-attachment cap",
					"cap", maxActionsPerAttachment)
				break
			}
			a, ok := prepareAction(a, seen)
			if !ok {
				continue
			}
			seen[a.ID] = true
			kept = append(kept, a)
		}
		if len(kept) == 0 {
			out[i].Actions = nil
			continue
		}
		out[i].Actions = kept
	}
	return out
}

// prepareAction validates one action, minting an id when the integration didn't
// supply a usable one.
func prepareAction(a model.MessageAction, seen map[string]bool) (model.MessageAction, bool) {
	// An action with no integration can never do anything, and rendering a dead
	// button is worse than rendering none.
	if a.Integration == nil || strings.TrimSpace(a.Integration.URL) == "" {
		slog.Warn("message actions: dropping action with no integration URL", "name", a.Name)
		return a, false
	}
	// Same SSRF boundary as outgoing webhooks: public https only, re-checked at
	// dial time when the action actually fires.
	if err := validateCallbackURL(strings.TrimSpace(a.Integration.URL)); err != nil {
		slog.Warn("message actions: dropping action with unsafe integration URL", "name", a.Name, "error", err)
		return a, false
	}
	a.Integration.URL = strings.TrimSpace(a.Integration.URL)
	if !contextWithinLimit(a.Integration.Context) {
		slog.Warn("message actions: dropping action with oversized context", "name", a.Name)
		return a, false
	}

	a.Name = clampRunes(strings.TrimSpace(a.Name), maxActionNameLen)
	if a.Name == "" {
		a.Name = "Continue"
	}
	switch strings.ToLower(strings.TrimSpace(a.Type)) {
	case model.MessageActionTypeSelect:
		a.Type = model.MessageActionTypeSelect
		if len(a.Options) == 0 {
			slog.Warn("message actions: dropping select action with no options", "name", a.Name)
			return a, false
		}
		if len(a.Options) > maxActionOptions {
			a.Options = a.Options[:maxActionOptions]
		}
	default:
		// Anything unrecognized renders as a button — MM's own default, and the
		// only other control type ex renders.
		a.Type = model.MessageActionTypeButton
		a.Options = nil
	}

	a.ID = strings.TrimSpace(a.ID)
	if a.ID == "" || seen[a.ID] {
		a.ID = store.NewID()
	}
	return a, true
}

func contextWithinLimit(c map[string]any) bool {
	if len(c) == 0 {
		return true
	}
	encoded, err := json.Marshal(c)
	return err == nil && len(encoded) <= actionContextMaxBytes
}

// ActionResult is the outcome of one action invocation.
type ActionResult struct {
	// EphemeralText is a message for the invoking user only. ex has no ephemeral
	// posts, but an action always has a live HTTP caller to answer, so this is
	// returned in that response rather than dropped.
	EphemeralText string `json:"ephemeral_text,omitempty"`
	// Message is the updated post when the integration asked for an update; nil
	// when it did not.
	Message *model.Message `json:"message,omitempty"`
}

// actionRequest is MM's interactive-action request payload.
type actionRequest struct {
	UserID      string         `json:"user_id"`
	UserName    string         `json:"user_name"`
	ChannelID   string         `json:"channel_id"`
	ChannelName string         `json:"channel_name"`
	TeamID      string         `json:"team_id"`
	TeamDomain  string         `json:"team_domain"`
	PostID      string         `json:"post_id"`
	TriggerID   string         `json:"trigger_id"`
	Type        string         `json:"type"`
	DataSource  string         `json:"data_source"`
	Context     map[string]any `json:"context,omitempty"`
}

// actionResponse is MM's interactive-action response payload.
type actionResponse struct {
	EphemeralText string `json:"ephemeral_text"`
	Update        *struct {
		Message string `json:"message"`
		Props   *struct {
			Attachments []model.MessageAttachment `json:"attachments"`
		} `json:"props"`
	} `json:"update"`
}

// InvokeMessageAction runs an interactive action on behalf of userID: it verifies
// the user can see the message, calls the action's integration with MM's payload,
// and applies the response — updating the post in place and/or returning text for
// the caller alone.
func (s *MessageService) InvokeMessageAction(
	ctx context.Context,
	userID, parentID, parentType, messageID, actionID string,
	selectedOption string,
) (ActionResult, error) {
	if err := s.checkAccess(ctx, userID, parentID, parentType); err != nil {
		return ActionResult{}, err
	}
	msg, err := s.messages.GetMessage(ctx, parentID, messageID)
	if err != nil {
		return ActionResult{}, fmt.Errorf("message: get: %w", err)
	}
	if msg.Deleted {
		return ActionResult{}, ErrActionNotFound
	}
	action, ok := findAction(msg, actionID)
	if !ok {
		return ActionResult{}, ErrActionNotFound
	}
	if action.Disabled {
		return ActionResult{}, ErrActionDisabled
	}

	res, err := s.callActionIntegration(ctx, msg, action, userID, parentType, selectedOption)
	if err != nil {
		return ActionResult{}, err
	}

	out := ActionResult{EphemeralText: clampRunes(strings.TrimSpace(res.EphemeralText), 2000)}
	if res.Update == nil {
		return out, nil
	}
	updated, err := s.applyActionUpdate(ctx, msg, parentType, res)
	if err != nil {
		// The integration already ran and may have had a side effect, so a failed
		// *display* update is reported as a partial success: the caller still gets
		// the ephemeral text rather than an error implying nothing happened.
		slog.Warn("message actions: update failed after integration ran",
			"messageID", messageID, "error", err)
		return out, nil
	}
	out.Message = updated
	return out, nil
}

// findAction locates an action by id across the message's attachments.
func findAction(msg *model.Message, actionID string) (model.MessageAction, bool) {
	for _, att := range msg.MessageAttachments {
		for _, a := range att.Actions {
			if a.ID == actionID {
				return a, a.Integration != nil && a.Integration.URL != ""
			}
		}
	}
	return model.MessageAction{}, false
}

// callActionIntegration POSTs MM's action payload and decodes the response.
func (s *MessageService) callActionIntegration(
	ctx context.Context,
	msg *model.Message,
	action model.MessageAction,
	userID, parentType, selectedOption string,
) (actionResponse, error) {
	mc := resolveMMContext(ctx, s.botCtx, msg.ParentID, parentType, userID)

	// The context is the integration's own, echoed back verbatim. MM carries a
	// select's choice inside it under "selected_option", so a receiver reads the
	// choice from the same place it reads its own keys.
	actionCtx := action.Integration.Context
	if action.Type == model.MessageActionTypeSelect {
		merged := make(map[string]any, len(actionCtx)+1)
		for k, v := range actionCtx {
			merged[k] = v
		}
		merged["selected_option"] = selectedOption
		actionCtx = merged
	}

	body, err := json.Marshal(actionRequest{
		UserID:      userID,
		UserName:    mc.UserName,
		ChannelID:   msg.ParentID,
		ChannelName: mc.ChannelSlug,
		TeamID:      MMSyntheticTeamID,
		TeamDomain:  MMSyntheticTeamDomain,
		PostID:      msg.ID,
		// trigger_id exists in MM to authorize opening an interactive dialog.
		// ex has no dialogs yet (RFC §8), so it is a fresh opaque value carried
		// for payload compatibility and nothing else.
		TriggerID:  store.NewID(),
		Type:       action.Type,
		DataSource: "",
		Context:    actionCtx,
	})
	if err != nil {
		return actionResponse{}, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, action.Integration.URL, bytes.NewReader(body))
	if err != nil {
		return actionResponse{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	res, err := botWebhookClient.Do(req)
	if err != nil {
		return actionResponse{}, fmt.Errorf("%w: %v", ErrActionFailed, err)
	}
	defer func() { _, _ = io.Copy(io.Discard, res.Body); _ = res.Body.Close() }()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return actionResponse{}, fmt.Errorf("%w: status %d", ErrActionFailed, res.StatusCode)
	}
	var out actionResponse
	// As with bot replies, an empty body is a valid "done, nothing to say".
	_ = json.NewDecoder(io.LimitReader(res.Body, botReplyMaxBytes)).Decode(&out)
	return out, nil
}

// applyActionUpdate rewrites the post's body and/or attachments in place and
// broadcasts the edit, which is how an integration turns "Approve / Reject"
// buttons into "Approved by …".
//
// Deliberately NOT routed through Edit: that path enforces "only the author may
// edit", and the author here is the bot, not the human who clicked. The authority
// for this write is that the integration owning the message asked for it.
func (s *MessageService) applyActionUpdate(
	ctx context.Context,
	msg *model.Message,
	parentType string,
	res actionResponse,
) (*model.Message, error) {
	updated := *msg
	if res.Update.Message != "" {
		if err := ValidateMessageBody(res.Update.Message); err != nil {
			return nil, err
		}
		updated.Body = res.Update.Message
	}
	if res.Update.Props != nil {
		atts := res.Update.Props.Attachments
		if err := ValidateAttachmentCount(len(atts)); err != nil {
			return nil, err
		}
		// Re-prepared, not trusted: the update's actions are new integration input
		// and get the same id-minting and URL validation as the original post's.
		updated.MessageAttachments = PrepareActions(atts)
	}
	if updated.Body == "" && len(updated.MessageAttachments) == 0 {
		return nil, errors.New("message: action update must leave a body or attachments")
	}
	now := time.Now()
	updated.EditedAt = &now
	if err := s.messages.UpdateMessage(ctx, &updated); err != nil {
		return nil, fmt.Errorf("message: action update: %w", err)
	}
	s.attachRendered(&updated)
	s.publishEvent(ctx, updated.ParentID, parentType, events.EventMessageEdited, &updated)
	s.indexMessage(ctx, &updated, parentType)
	return &updated, nil
}
