package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func TestPrepareActions(t *testing.T) {
	const okURL = "https://hooks.example.com/act"

	t.Run("mints an id when the integration supplies none", func(t *testing.T) {
		out := PrepareActions([]model.MessageAttachment{{
			Actions: []model.MessageAction{{Name: "Approve", Integration: &model.ActionIntegration{URL: okURL}}},
		}})
		if len(out[0].Actions) != 1 || out[0].Actions[0].ID == "" {
			t.Fatalf("actions = %+v, want one action with a minted id", out[0].Actions)
		}
	})

	t.Run("keeps ids unique across attachments on the same message", func(t *testing.T) {
		// Invocation names only the id, so a duplicate across attachments would be
		// ambiguous — the second must be re-minted.
		out := PrepareActions([]model.MessageAttachment{
			{Actions: []model.MessageAction{{ID: "same", Name: "A", Integration: &model.ActionIntegration{URL: okURL}}}},
			{Actions: []model.MessageAction{{ID: "same", Name: "B", Integration: &model.ActionIntegration{URL: okURL}}}},
		})
		if a, b := out[0].Actions[0].ID, out[1].Actions[0].ID; a == b {
			t.Errorf("both actions kept id %q, want the duplicate re-minted", a)
		}
	})

	t.Run("drops actions with no integration or an unsafe URL", func(t *testing.T) {
		out := PrepareActions([]model.MessageAttachment{{Actions: []model.MessageAction{
			{ID: "a", Name: "no integration"},
			{ID: "b", Name: "internal", Integration: &model.ActionIntegration{URL: "https://127.0.0.1/act"}},
			{ID: "c", Name: "plain http", Integration: &model.ActionIntegration{URL: "http://hooks.example.com/act"}},
			{ID: "d", Name: "fine", Integration: &model.ActionIntegration{URL: okURL}},
		}}})
		if len(out[0].Actions) != 1 || out[0].Actions[0].ID != "d" {
			t.Fatalf("actions = %+v, want only the safe one kept", out[0].Actions)
		}
	})

	t.Run("drops a select with no options and defaults unknown types to button", func(t *testing.T) {
		out := PrepareActions([]model.MessageAttachment{{Actions: []model.MessageAction{
			{ID: "a", Name: "empty select", Type: "select", Integration: &model.ActionIntegration{URL: okURL}},
			{ID: "b", Name: "odd", Type: "radio", Integration: &model.ActionIntegration{URL: okURL}},
		}}})
		if len(out[0].Actions) != 1 {
			t.Fatalf("actions = %+v, want the optionless select dropped", out[0].Actions)
		}
		if out[0].Actions[0].Type != model.MessageActionTypeButton {
			t.Errorf("type = %q, want it normalized to button", out[0].Actions[0].Type)
		}
	})

	t.Run("caps actions per attachment", func(t *testing.T) {
		many := make([]model.MessageAction, 0, maxActionsPerAttachment+3)
		for i := 0; i < maxActionsPerAttachment+3; i++ {
			many = append(many, model.MessageAction{Name: "a", Integration: &model.ActionIntegration{URL: okURL}})
		}
		out := PrepareActions([]model.MessageAttachment{{Actions: many}})
		if len(out[0].Actions) != maxActionsPerAttachment {
			t.Errorf("kept %d actions, want the cap of %d", len(out[0].Actions), maxActionsPerAttachment)
		}
	})

	t.Run("does not mutate the caller's slice", func(t *testing.T) {
		in := []model.MessageAttachment{{Actions: []model.MessageAction{{Name: "x"}}}}
		_ = PrepareActions(in)
		if len(in[0].Actions) != 1 {
			t.Error("input attachment was mutated")
		}
	})
}

// The integration URL and its context are server-side config. They must never
// reach a client, even though inbound JSON populates them.
func TestMessageAction_IntegrationNeverSerialized(t *testing.T) {
	raw := `{"id":"a1","name":"Approve","integration":{"url":"https://hooks.example.com/act","context":{"task":"T-1"}}}`
	var action model.MessageAction
	if err := json.Unmarshal([]byte(raw), &action); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if action.Integration == nil || action.Integration.URL != "https://hooks.example.com/act" {
		t.Fatalf("integration not read from inbound JSON: %+v", action.Integration)
	}
	if action.Integration.Context["task"] != "T-1" {
		t.Errorf("context not read from inbound JSON: %+v", action.Integration.Context)
	}

	out, err := json.Marshal(action)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	for _, leaked := range []string{"integration", "hooks.example.com", "T-1"} {
		if strings.Contains(string(out), leaked) {
			t.Errorf("serialized action leaks %q: %s", leaked, out)
		}
	}
}

// setupActionService wires a MessageService with an accessible channel and one
// message carrying a single button whose integration points at srvURL.
func setupActionService(t *testing.T, srvURL string, ctxData map[string]any) (*MessageService, *mockMessageStore) {
	t.Helper()
	svc, messages, memberships, _, _ := setupMessageService()
	if err := memberships.AddMember(context.Background(),
		&model.ChannelMembership{ChannelID: "ch1", UserID: "u1"}, &model.UserChannel{}); err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	msg := &model.Message{
		ID: "m1", ParentID: "ch1", AuthorID: "bot_x", Body: "Approve this?",
		MessageAttachments: []model.MessageAttachment{{
			Text: "PR #12",
			Actions: []model.MessageAction{{
				ID: "act1", Name: "Approve", Type: model.MessageActionTypeButton,
				Integration: &model.ActionIntegration{URL: srvURL, Context: ctxData},
			}},
		}},
	}
	if err := messages.CreateMessage(context.Background(), msg); err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	return svc, messages
}

func TestInvokeMessageAction_CallsIntegrationAndAppliesUpdate(t *testing.T) {
	useLoopbackWebhookClient(t)
	var got actionRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ephemeral_text": "Approved — thanks!",
			"update": map[string]any{
				"message": "Approved by you",
				"props":   map[string]any{"attachments": []map[string]any{{"text": "PR #12 · approved"}}},
			},
		})
	}))
	defer srv.Close()

	svc, messages := setupActionService(t, srv.URL, map[string]any{"pr": "12"})
	svc.SetBotContextResolver(stubMMResolver{channelSlug: "reviews", userName: "anna.smith"})

	res, err := svc.InvokeMessageAction(context.Background(), "u1", "ch1", ParentChannel, "m1", "act1", "")
	if err != nil {
		t.Fatalf("InvokeMessageAction: %v", err)
	}

	// The payload an existing Mattermost integration expects.
	if got.UserID != "u1" || got.PostID != "m1" || got.ChannelID != "ch1" {
		t.Errorf("request identity = %+v, want the invoking user and post", got)
	}
	if got.UserName != "anna.smith" || got.ChannelName != "reviews" {
		t.Errorf("request names = %q/%q, want resolved names", got.UserName, got.ChannelName)
	}
	if got.TeamID != MMSyntheticTeamID || got.TriggerID == "" {
		t.Errorf("team_id = %q, trigger_id = %q; both must be populated", got.TeamID, got.TriggerID)
	}
	// The integration's own context is echoed back verbatim — that is how it knows
	// which thing the button referred to.
	if got.Context["pr"] != "12" {
		t.Errorf("context = %+v, want the stored integration context echoed", got.Context)
	}

	if res.EphemeralText != "Approved — thanks!" {
		t.Errorf("EphemeralText = %q", res.EphemeralText)
	}
	if res.Message == nil || res.Message.Body != "Approved by you" {
		t.Fatalf("Message = %+v, want the body rewritten", res.Message)
	}
	// The update is persisted, not just returned.
	stored, err := messages.GetMessage(context.Background(), "ch1", "m1")
	if err != nil {
		t.Fatalf("GetMessage: %v", err)
	}
	if stored.Body != "Approved by you" || stored.EditedAt == nil {
		t.Errorf("stored message = %+v, want the persisted update with an edit stamp", stored)
	}
	if len(stored.MessageAttachments) != 1 || stored.MessageAttachments[0].Text != "PR #12 · approved" {
		t.Errorf("stored attachments = %+v, want them replaced", stored.MessageAttachments)
	}
}

// A select's chosen value rides inside the integration's own context under
// "selected_option", which is where MM receivers read it from.
func TestInvokeMessageAction_SelectPassesChosenOption(t *testing.T) {
	useLoopbackWebhookClient(t)
	var got actionRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	svc, messages := setupActionService(t, srv.URL, map[string]any{"pr": "12"})
	// Turn the seeded button into a select.
	stored, _ := messages.GetMessage(context.Background(), "ch1", "m1")
	stored.MessageAttachments[0].Actions[0].Type = model.MessageActionTypeSelect

	if _, err := svc.InvokeMessageAction(context.Background(), "u1", "ch1", ParentChannel, "m1", "act1", "approve"); err != nil {
		t.Fatalf("InvokeMessageAction: %v", err)
	}
	if got.Context["selected_option"] != "approve" {
		t.Errorf("context = %+v, want selected_option=approve", got.Context)
	}
	if got.Context["pr"] != "12" {
		t.Error("merging the selection must not drop the integration's own context keys")
	}
}

func TestInvokeMessageAction_Failures(t *testing.T) {
	useLoopbackWebhookClient(t)

	t.Run("unknown action id", func(t *testing.T) {
		svc, _ := setupActionService(t, "https://hooks.example.com/act", nil)
		_, err := svc.InvokeMessageAction(context.Background(), "u1", "ch1", ParentChannel, "m1", "nope", "")
		if !errors.Is(err, ErrActionNotFound) {
			t.Fatalf("err = %v, want ErrActionNotFound", err)
		}
	})

	t.Run("a non-member cannot invoke", func(t *testing.T) {
		svc, _ := setupActionService(t, "https://hooks.example.com/act", nil)
		_, err := svc.InvokeMessageAction(context.Background(), "stranger", "ch1", ParentChannel, "m1", "act1", "")
		if err == nil {
			t.Fatal("a user with no access must not be able to invoke an action")
		}
	})

	t.Run("a disabled action is refused", func(t *testing.T) {
		svc, messages := setupActionService(t, "https://hooks.example.com/act", nil)
		stored, _ := messages.GetMessage(context.Background(), "ch1", "m1")
		stored.MessageAttachments[0].Actions[0].Disabled = true
		_, err := svc.InvokeMessageAction(context.Background(), "u1", "ch1", ParentChannel, "m1", "act1", "")
		if !errors.Is(err, ErrActionDisabled) {
			t.Fatalf("err = %v, want ErrActionDisabled", err)
		}
	})

	t.Run("an action on a deleted message is gone", func(t *testing.T) {
		svc, messages := setupActionService(t, "https://hooks.example.com/act", nil)
		stored, _ := messages.GetMessage(context.Background(), "ch1", "m1")
		stored.Deleted = true
		_, err := svc.InvokeMessageAction(context.Background(), "u1", "ch1", ParentChannel, "m1", "act1", "")
		if !errors.Is(err, ErrActionNotFound) {
			t.Fatalf("err = %v, want ErrActionNotFound", err)
		}
	})

	t.Run("an integration error is reported as such", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}))
		defer srv.Close()
		svc, _ := setupActionService(t, srv.URL, nil)
		_, err := svc.InvokeMessageAction(context.Background(), "u1", "ch1", ParentChannel, "m1", "act1", "")
		if !errors.Is(err, ErrActionFailed) {
			t.Fatalf("err = %v, want ErrActionFailed", err)
		}
	})
}

// An update whose actions are new integration input gets the same validation as
// the original post's — an unsafe callback URL cannot be smuggled in via an update.
func TestInvokeMessageAction_UpdateActionsAreRevalidated(t *testing.T) {
	useLoopbackWebhookClient(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"update": map[string]any{
				"message": "next step",
				"props": map[string]any{"attachments": []map[string]any{{
					"text": "pick one",
					"actions": []map[string]any{
						{"id": "evil", "name": "Nope", "integration": map[string]any{"url": "https://169.254.169.254/meta"}},
						{"id": "fine", "name": "Yes", "integration": map[string]any{"url": "https://hooks.example.com/next"}},
					},
				}}},
			},
		})
	}))
	defer srv.Close()

	svc, messages := setupActionService(t, srv.URL, nil)
	if _, err := svc.InvokeMessageAction(context.Background(), "u1", "ch1", ParentChannel, "m1", "act1", ""); err != nil {
		t.Fatalf("InvokeMessageAction: %v", err)
	}
	stored, _ := messages.GetMessage(context.Background(), "ch1", "m1")
	actions := stored.MessageAttachments[0].Actions
	if len(actions) != 1 || actions[0].ID != "fine" {
		t.Fatalf("actions = %+v, want the link-local one dropped", actions)
	}
}

// Remaining arms of the action path: oversized context, update validation, and a
// stored action whose integration went missing.

func TestPrepareActions_RejectsOversizedContext(t *testing.T) {
	big := make(map[string]any, 1)
	big["blob"] = strings.Repeat("x", actionContextMaxBytes+1)
	out := PrepareActions([]model.MessageAttachment{{Actions: []model.MessageAction{{
		ID: "a", Name: "Big", Integration: &model.ActionIntegration{URL: "https://hooks.example.com/act", Context: big},
	}}}})
	if len(out[0].Actions) != 0 {
		t.Errorf("actions = %+v, want the oversized context dropped", out[0].Actions)
	}
}

func TestPrepareActions_ContextLimits(t *testing.T) {
	if !contextWithinLimit(nil) {
		t.Error("a nil context is within the limit")
	}
	// A value json cannot encode is treated as over the limit rather than stored.
	if contextWithinLimit(map[string]any{"fn": func() {}}) {
		t.Error("an unencodable context must be rejected")
	}
}

func TestPrepareActions_TrimsSelectOptions(t *testing.T) {
	opts := make([]model.MessageActionOption, maxActionOptions+3)
	for i := range opts {
		opts[i] = model.MessageActionOption{Text: "o", Value: "v"}
	}
	out := PrepareActions([]model.MessageAttachment{{Actions: []model.MessageAction{{
		ID: "s", Name: "Pick", Type: model.MessageActionTypeSelect, Options: opts,
		Integration: &model.ActionIntegration{URL: "https://hooks.example.com/act"},
	}}}})
	if got := len(out[0].Actions[0].Options); got != maxActionOptions {
		t.Errorf("options = %d, want the cap of %d", got, maxActionOptions)
	}
}

func TestPrepareActions_DefaultsAnEmptyName(t *testing.T) {
	// A nameless button would render as an unlabelled control.
	out := PrepareActions([]model.MessageAttachment{{Actions: []model.MessageAction{{
		ID: "a", Name: "   ", Integration: &model.ActionIntegration{URL: "https://hooks.example.com/act"},
	}}}})
	if out[0].Actions[0].Name != "Continue" {
		t.Errorf("Name = %q, want a default label", out[0].Actions[0].Name)
	}
}

func TestPrepareActions_PassesThroughWithoutActions(t *testing.T) {
	if got := PrepareActions(nil); got != nil {
		t.Errorf("PrepareActions(nil) = %+v, want nil", got)
	}
	in := []model.MessageAttachment{{Text: "plain"}}
	out := PrepareActions(in)
	if len(out) != 1 || out[0].Actions != nil {
		t.Errorf("out = %+v, want the attachment untouched", out)
	}
}

// An action row whose integration is missing (a hand-edited or legacy row) is
// treated as not found rather than dereferenced.
func TestInvokeMessageAction_ActionWithoutIntegration(t *testing.T) {
	svc, messages := setupActionService(t, "https://hooks.example.com/act", nil)
	stored, _ := messages.GetMessage(context.Background(), "ch1", "m1")
	stored.MessageAttachments[0].Actions[0].Integration = nil
	_, err := svc.InvokeMessageAction(context.Background(), "u1", "ch1", ParentChannel, "m1", "act1", "")
	if !errors.Is(err, ErrActionNotFound) {
		t.Fatalf("err = %v, want ErrActionNotFound", err)
	}
}

func TestInvokeMessageAction_UnknownMessage(t *testing.T) {
	svc, _ := setupActionService(t, "https://hooks.example.com/act", nil)
	_, err := svc.InvokeMessageAction(context.Background(), "u1", "ch1", ParentChannel, "missing", "act1", "")
	if err == nil {
		t.Fatal("want an error for a message that doesn't exist")
	}
}

// An integration whose URL can't be built into a request fails cleanly.
func TestInvokeMessageAction_MalformedIntegrationURL(t *testing.T) {
	useLoopbackWebhookClient(t)
	svc, messages := setupActionService(t, "https://hooks.example.com/act", nil)
	stored, _ := messages.GetMessage(context.Background(), "ch1", "m1")
	stored.MessageAttachments[0].Actions[0].Integration.URL = "https://exa mple.com/\x7f"
	if _, err := svc.InvokeMessageAction(context.Background(), "u1", "ch1", ParentChannel, "m1", "act1", ""); err == nil {
		t.Fatal("want an error for an unbuildable request")
	}
}

// The integration already ran, so a failed DISPLAY update is a partial success:
// the caller still gets its ephemeral text instead of an error implying nothing
// happened.
func TestInvokeMessageAction_UpdateFailureStillReturnsEphemeral(t *testing.T) {
	useLoopbackWebhookClient(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// An update that would leave the post with neither a body nor attachments.
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ephemeral_text": "done anyway",
			"update":         map[string]any{"props": map[string]any{"attachments": []map[string]any{}}},
		})
	}))
	defer srv.Close()

	svc, messages := setupActionService(t, srv.URL, nil)
	stored, _ := messages.GetMessage(context.Background(), "ch1", "m1")
	stored.Body = "" // no body either, so the update has nothing left to show

	res, err := svc.InvokeMessageAction(context.Background(), "u1", "ch1", ParentChannel, "m1", "act1", "")
	if err != nil {
		t.Fatalf("InvokeMessageAction: %v", err)
	}
	if res.EphemeralText != "done anyway" {
		t.Errorf("EphemeralText = %q, want it returned despite the failed update", res.EphemeralText)
	}
	if res.Message != nil {
		t.Errorf("Message = %+v, want none after a failed update", res.Message)
	}
}

// An update body that violates the message-body rules is refused.
func TestInvokeMessageAction_UpdateBodyValidated(t *testing.T) {
	useLoopbackWebhookClient(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"update": map[string]any{"message": strings.Repeat("x", 100_000)},
		})
	}))
	defer srv.Close()

	svc, messages := setupActionService(t, srv.URL, nil)
	if _, err := svc.InvokeMessageAction(context.Background(), "u1", "ch1", ParentChannel, "m1", "act1", ""); err != nil {
		t.Fatalf("InvokeMessageAction: %v", err)
	}
	stored, _ := messages.GetMessage(context.Background(), "ch1", "m1")
	if stored.Body != "Approve this?" {
		t.Error("an over-long update body must not be applied")
	}
}

// Too many attachments in an update is refused for the same reason a send would be.
func TestInvokeMessageAction_UpdateAttachmentCountValidated(t *testing.T) {
	useLoopbackWebhookClient(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		many := make([]map[string]any, 200)
		for i := range many {
			many[i] = map[string]any{"text": "a"}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"update": map[string]any{"props": map[string]any{"attachments": many}},
		})
	}))
	defer srv.Close()

	svc, messages := setupActionService(t, srv.URL, nil)
	if _, err := svc.InvokeMessageAction(context.Background(), "u1", "ch1", ParentChannel, "m1", "act1", ""); err != nil {
		t.Fatalf("InvokeMessageAction: %v", err)
	}
	stored, _ := messages.GetMessage(context.Background(), "ch1", "m1")
	if len(stored.MessageAttachments) != 1 {
		t.Errorf("attachments = %d, want the original kept", len(stored.MessageAttachments))
	}
}

// A store write failure during the update is reported as a partial success too.
func TestInvokeMessageAction_UpdateStoreFailure(t *testing.T) {
	useLoopbackWebhookClient(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ephemeral_text": "ran",
			"update":         map[string]any{"message": "updated"},
		})
	}))
	defer srv.Close()

	svc, messages := setupActionService(t, srv.URL, nil)
	messages.updateErr = errors.New("dynamo down")
	res, err := svc.InvokeMessageAction(context.Background(), "u1", "ch1", ParentChannel, "m1", "act1", "")
	if err != nil {
		t.Fatalf("InvokeMessageAction: %v", err)
	}
	if res.EphemeralText != "ran" || res.Message != nil {
		t.Errorf("res = %+v, want the ephemeral text without an updated message", res)
	}
}

// The integration's context is echoed back verbatim, so a value that cannot be
// encoded fails the call rather than silently dropping the context the
// integration needs to identify what the button referred to.
func TestInvokeMessageAction_UnencodableContext(t *testing.T) {
	useLoopbackWebhookClient(t)
	svc, messages := setupActionService(t, "https://hooks.example.com/act", nil)
	stored, _ := messages.GetMessage(context.Background(), "ch1", "m1")
	stored.MessageAttachments[0].Actions[0].Integration.Context = map[string]any{"fn": func() {}}

	if _, err := svc.InvokeMessageAction(context.Background(), "u1", "ch1", ParentChannel, "m1", "act1", ""); err == nil {
		t.Fatal("want an error for a context that cannot be encoded")
	}
}

// A transport failure (as opposed to an error status) is still the integration's
// fault, so it maps to ErrActionFailed.
func TestInvokeMessageAction_TransportFailure(t *testing.T) {
	useLoopbackWebhookClient(t)
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	srv.Close() // closed → connection refused

	svc, _ := setupActionService(t, srv.URL, nil)
	_, err := svc.InvokeMessageAction(context.Background(), "u1", "ch1", ParentChannel, "m1", "act1", "")
	if !errors.Is(err, ErrActionFailed) {
		t.Fatalf("err = %v, want ErrActionFailed", err)
	}
}
