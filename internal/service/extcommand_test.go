package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// fakeExtCommandStore is an in-memory ExternalCommandStore.
type fakeExtCommandStore struct {
	mu       sync.Mutex
	byID     map[string]*model.ExternalCommand
	triggers map[string]string // trigger -> id
}

func newFakeExtCommandStore() *fakeExtCommandStore {
	return &fakeExtCommandStore{
		byID:     map[string]*model.ExternalCommand{},
		triggers: map[string]string{},
	}
}

func (f *fakeExtCommandStore) CreateCommand(_ context.Context, cmd *model.ExternalCommand) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, taken := f.triggers[cmd.Trigger]; taken {
		return store.ErrAlreadyExists
	}
	copied := *cmd
	f.byID[cmd.ID] = &copied
	f.triggers[cmd.Trigger] = cmd.ID
	return nil
}

func (f *fakeExtCommandStore) UpdateCommand(_ context.Context, cmd *model.ExternalCommand) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.byID[cmd.ID]; !ok {
		return store.ErrNotFound
	}
	copied := *cmd
	f.byID[cmd.ID] = &copied
	return nil
}

func (f *fakeExtCommandStore) GetCommand(_ context.Context, id string) (*model.ExternalCommand, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	cmd, ok := f.byID[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	copied := *cmd
	return &copied, nil
}

func (f *fakeExtCommandStore) GetCommandByTrigger(ctx context.Context, trigger string) (*model.ExternalCommand, error) {
	f.mu.Lock()
	id, ok := f.triggers[strings.ToLower(trigger)]
	f.mu.Unlock()
	if !ok {
		return nil, store.ErrNotFound
	}
	return f.GetCommand(ctx, id)
}

func (f *fakeExtCommandStore) ListCommands(_ context.Context) ([]*model.ExternalCommand, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]*model.ExternalCommand, 0, len(f.byID))
	for _, c := range f.byID {
		// A nil entry stands in for a crashed half-delete: the id is still in the
		// directory but its META row is gone. The real store yields nothing for it.
		if c == nil {
			out = append(out, nil)
			continue
		}
		copied := *c
		out = append(out, &copied)
	}
	return out, nil
}

func (f *fakeExtCommandStore) DeleteCommand(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	cmd, ok := f.byID[id]
	if !ok {
		return store.ErrNotFound
	}
	delete(f.triggers, cmd.Trigger)
	delete(f.byID, id)
	return nil
}

// setupExtCommands wires an ExternalCommandService over the message-service test
// harness, with "u1" a member of channel "ch1".
func setupExtCommands(t *testing.T) (*ExternalCommandService, *fakeExtCommandStore, *mockMessageStore) {
	t.Helper()
	msgSvc, messages, memberships, _, _ := setupMessageService()
	if err := memberships.AddMember(context.Background(),
		&model.ChannelMembership{ChannelID: "ch1", UserID: "u1"}, &model.UserChannel{}); err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	cmdStore := newFakeExtCommandStore()
	svc := NewExternalCommandService(ExternalCommandDeps{
		Store:    cmdStore,
		Messages: msgSvc,
		Resolver: stubMMResolver{channelSlug: "general", userName: "anna.smith"},
		BaseURL:  "https://ex.example.com",
		Reserved: func() map[string]bool { return map[string]bool{"mstmeetings": true} },
	})
	return svc, cmdStore, messages
}

func mustCreateCommand(t *testing.T, svc *ExternalCommandService, in *model.ExternalCommand) *model.ExternalCommand {
	t.Helper()
	cmd, err := svc.CreateCommand(context.Background(), "admin1", in)
	if err != nil {
		t.Fatalf("CreateCommand: %v", err)
	}
	return cmd
}

// seedCommand writes a command straight to the store, bypassing CreateCommand's
// URL validation. Needed because an httptest server is http://127.0.0.1 — exactly
// what validateCallbackURL refuses for real registrations (see
// TestCreateCommand_Validation, which covers that boundary against real URLs).
func seedCommand(t *testing.T, s *fakeExtCommandStore, cmd *model.ExternalCommand) *model.ExternalCommand {
	t.Helper()
	copied := *cmd
	copied.ID = "cmd-" + copied.Trigger
	copied.Token = "excmd_test_" + copied.Trigger
	copied.Method = copied.NormalizedMethod()
	if err := s.CreateCommand(context.Background(), &copied); err != nil {
		t.Fatalf("seed command: %v", err)
	}
	return &copied
}

func TestNormalizeTrigger(t *testing.T) {
	ok := map[string]string{
		"deploy":   "deploy",
		"/deploy":  "deploy",
		"  Deploy": "deploy",
		"roll-out": "roll-out",
	}
	for in, want := range ok {
		got, err := NormalizeTrigger(in)
		if err != nil || got != want {
			t.Errorf("NormalizeTrigger(%q) = (%q, %v), want (%q, nil)", in, got, err, want)
		}
	}
	for _, in := range []string{"", "   ", "two words", "a/b", strings.Repeat("x", maxTriggerLen+1)} {
		if _, err := NormalizeTrigger(in); !errors.Is(err, ErrInvalidTrigger) {
			t.Errorf("NormalizeTrigger(%q) = %v, want ErrInvalidTrigger", in, err)
		}
	}
}

func TestCreateCommand_Validation(t *testing.T) {
	svc, _, _ := setupExtCommands(t)
	ctx := context.Background()

	t.Run("rejects a non-public request URL", func(t *testing.T) {
		_, err := svc.CreateCommand(ctx, "admin1", &model.ExternalCommand{
			Trigger: "deploy", RequestURL: "http://127.0.0.1/run",
		})
		if !errors.Is(err, ErrInvalidRequestURL) {
			t.Fatalf("err = %v, want ErrInvalidRequestURL", err)
		}
	})

	t.Run("refuses to shadow a built-in trigger", func(t *testing.T) {
		// A built-in always wins at dispatch, so an external command on the same
		// trigger would be silently dead — better to reject the registration.
		_, err := svc.CreateCommand(ctx, "admin1", &model.ExternalCommand{
			Trigger: "mstmeetings", RequestURL: "https://hooks.example.com/run",
		})
		if !errors.Is(err, ErrTriggerReserved) {
			t.Fatalf("err = %v, want ErrTriggerReserved", err)
		}
	})

	t.Run("refuses a duplicate trigger", func(t *testing.T) {
		mustCreateCommand(t, svc, &model.ExternalCommand{Trigger: "dupe", RequestURL: "https://hooks.example.com/run"})
		_, err := svc.CreateCommand(ctx, "admin1", &model.ExternalCommand{
			Trigger: "dupe", RequestURL: "https://hooks.example.com/other",
		})
		if !errors.Is(err, ErrTriggerTaken) {
			t.Fatalf("err = %v, want ErrTriggerTaken", err)
		}
	})

	t.Run("issues a token once", func(t *testing.T) {
		cmd := mustCreateCommand(t, svc, &model.ExternalCommand{Trigger: "tok", RequestURL: "https://hooks.example.com/run"})
		if !strings.HasPrefix(cmd.Token, "excmd_") {
			t.Errorf("Token = %q, want an excmd_ prefix", cmd.Token)
		}
		// The token is a credential: it must not be serialized by the read APIs.
		encoded, err := json.Marshal(cmd)
		if err != nil {
			t.Fatalf("Marshal: %v", err)
		}
		if strings.Contains(string(encoded), cmd.Token) {
			t.Errorf("serialized command leaks its token: %s", encoded)
		}
	})
}

// UpdateCommand must not move a claimed trigger: the claim row is what enforces
// uniqueness, and it isn't moved atomically with the update.
func TestUpdateCommand_KeepsTriggerAndToken(t *testing.T) {
	svc, _, _ := setupExtCommands(t)
	cmd := mustCreateCommand(t, svc, &model.ExternalCommand{Trigger: "deploy", RequestURL: "https://hooks.example.com/run"})

	updated, err := svc.UpdateCommand(context.Background(), cmd.ID, &model.ExternalCommand{
		Trigger:     "renamed",
		RequestURL:  "https://hooks.example.com/v2",
		Description: "now with more rollout",
	})
	if err != nil {
		t.Fatalf("UpdateCommand: %v", err)
	}
	if updated.Trigger != "deploy" {
		t.Errorf("Trigger = %q, want the original (renames go through delete+create)", updated.Trigger)
	}
	if updated.Token != cmd.Token {
		t.Error("Token changed on update; an integration's credential must survive an edit")
	}
	if updated.RequestURL != "https://hooks.example.com/v2" {
		t.Errorf("RequestURL = %q, want it updated", updated.RequestURL)
	}
}

func TestRunCommand_SendsMattermostPayload(t *testing.T) {
	useLoopbackWebhookClient(t)
	var got url.Values
	var contentType string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		contentType = r.Header.Get("Content-Type")
		_ = r.ParseForm()
		got = r.PostForm
		_ = json.NewEncoder(w).Encode(map[string]string{"text": "on it"})
	}))
	defer srv.Close()

	svc, cmdStore, _ := setupExtCommands(t)
	cmd := seedCommand(t, cmdStore, &model.ExternalCommand{Trigger: "deploy", RequestURL: srv.URL})

	res, err := svc.RunCommand(context.Background(), "deploy", CommandRequest{
		UserID: "u1", ParentID: "ch1", ParentType: ParentChannel, Text: "web v2",
	})
	if err != nil {
		t.Fatalf("RunCommand: %v", err)
	}

	if contentType != "application/x-www-form-urlencoded" {
		t.Errorf("Content-Type = %q, want form encoding", contentType)
	}
	want := map[string]string{
		"token":        cmd.Token,
		"team_id":      MMSyntheticTeamID,
		"team_domain":  MMSyntheticTeamDomain,
		"channel_id":   "ch1",
		"channel_name": "general",
		"user_id":      "u1",
		"user_name":    "anna.smith",
		"command":      "/deploy",
		"text":         "web v2",
	}
	for k, v := range want {
		if got.Get(k) != v {
			t.Errorf("form[%q] = %q, want %q", k, got.Get(k), v)
		}
	}
	if got.Get("trigger_id") == "" {
		t.Error("form[trigger_id] is empty")
	}
	// No Redis store is wired in this harness, so response_url is omitted rather
	// than handed out as a URL that could never be honored.
	if got.Get("response_url") != "" {
		t.Errorf("response_url = %q, want none without a response store", got.Get("response_url"))
	}

	// MM defaults an unset response_type to ephemeral. Getting this backwards would
	// publish output the integration expected to stay private.
	if res.EphemeralText != "on it" {
		t.Errorf("EphemeralText = %q, want the default-ephemeral text", res.EphemeralText)
	}
	if res.Message != nil {
		t.Errorf("Message = %+v, want nothing posted for an ephemeral response", res.Message)
	}
}

func TestRunCommand_InChannelResponsePostsMessage(t *testing.T) {
	useLoopbackWebhookClient(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"response_type": "in_channel",
			"text":          "Deploying web v2",
			"username":      "Deploy Bot",
			"attachments":   []map[string]any{{"text": "started"}},
		})
	}))
	defer srv.Close()

	svc, cmdStore, messages := setupExtCommands(t)
	seedCommand(t, cmdStore, &model.ExternalCommand{
		Trigger: "deploy", RequestURL: srv.URL, BotUserID: "bot_deploy",
	})

	res, err := svc.RunCommand(context.Background(), "deploy", CommandRequest{
		UserID: "u1", ParentID: "ch1", ParentType: ParentChannel, Text: "web v2",
	})
	if err != nil {
		t.Fatalf("RunCommand: %v", err)
	}
	if res.Message == nil {
		t.Fatal("Message = nil, want an in-channel post")
	}
	if res.EphemeralText != "" {
		t.Errorf("EphemeralText = %q, want empty for an in_channel response", res.EphemeralText)
	}
	stored, err := messages.GetMessage(context.Background(), "ch1", res.Message.ID)
	if err != nil {
		t.Fatalf("GetMessage: %v", err)
	}
	// Authored by the command's bot, displayed under the response's username.
	if stored.AuthorID != "bot_deploy" {
		t.Errorf("AuthorID = %q, want the command's bot account", stored.AuthorID)
	}
	if stored.WebhookUsername != "Deploy Bot" {
		t.Errorf("WebhookUsername = %q, want the response override", stored.WebhookUsername)
	}
	if len(stored.MessageAttachments) != 1 {
		t.Errorf("attachments = %+v, want the response's attachment", stored.MessageAttachments)
	}
}

// A user who cannot post in the chat must not be able to make the integration
// run — and must not learn anything about the chat by trying.
func TestRunCommand_ChecksAccessBeforeCallingOut(t *testing.T) {
	useLoopbackWebhookClient(t)
	var called bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	svc, cmdStore, _ := setupExtCommands(t)
	seedCommand(t, cmdStore, &model.ExternalCommand{Trigger: "deploy", RequestURL: srv.URL})

	_, err := svc.RunCommand(context.Background(), "deploy", CommandRequest{
		UserID: "stranger", ParentID: "ch1", ParentType: ParentChannel,
	})
	if err == nil {
		t.Fatal("a non-member must not be able to run a command in the channel")
	}
	if called {
		t.Error("the integration was called before the access check passed")
	}
}

func TestRunCommand_UnknownTrigger(t *testing.T) {
	svc, _, _ := setupExtCommands(t)
	_, err := svc.RunCommand(context.Background(), "nope", CommandRequest{
		UserID: "u1", ParentID: "ch1", ParentType: ParentChannel,
	})
	if !errors.Is(err, ErrUnknownCommand) {
		t.Fatalf("err = %v, want ErrUnknownCommand", err)
	}
}

func TestRunCommand_IntegrationFailure(t *testing.T) {
	useLoopbackWebhookClient(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()

	svc, cmdStore, _ := setupExtCommands(t)
	seedCommand(t, cmdStore, &model.ExternalCommand{Trigger: "deploy", RequestURL: srv.URL})

	_, err := svc.RunCommand(context.Background(), "deploy", CommandRequest{
		UserID: "u1", ParentID: "ch1", ParentType: ParentChannel,
	})
	if !errors.Is(err, ErrCommandRunFailed) {
		t.Fatalf("err = %v, want ErrCommandRunFailed", err)
	}
}

// goto_location is handed to the browser, so anything but http(s) is dropped
// rather than becoming a redirect-to-XSS.
func TestRunCommand_FiltersGotoLocation(t *testing.T) {
	useLoopbackWebhookClient(t)
	var location string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"goto_location": location})
	}))
	defer srv.Close()

	svc, cmdStore, _ := setupExtCommands(t)
	seedCommand(t, cmdStore, &model.ExternalCommand{Trigger: "go", RequestURL: srv.URL})

	cases := map[string]string{
		"https://example.com/x":   "https://example.com/x",
		"http://example.com/x":    "http://example.com/x",
		"javascript:alert(1)":     "",
		"data:text/html,<script>": "",
		"file:///etc/passwd":      "",
	}
	for in, want := range cases {
		location = in
		res, err := svc.RunCommand(context.Background(), "go", CommandRequest{
			UserID: "u1", ParentID: "ch1", ParentType: ParentChannel,
		})
		if err != nil {
			t.Fatalf("RunCommand(%q): %v", in, err)
		}
		if res.GotoLocation != want {
			t.Errorf("goto_location %q → %q, want %q", in, res.GotoLocation, want)
		}
	}
}

func TestListCommands_ForAutocomplete(t *testing.T) {
	svc, _, _ := setupExtCommands(t)
	mustCreateCommand(t, svc, &model.ExternalCommand{
		Trigger: "deploy", RequestURL: "https://hooks.example.com/run",
		Description: "Ship a service", AutocompleteHint: "[service] [version]",
	})

	list := svc.ListCommands(context.Background())
	if len(list) != 1 || list[0].Name != "deploy" {
		t.Fatalf("ListCommands = %+v, want one entry named deploy", list)
	}
	if !strings.Contains(list[0].Description, "[service] [version]") ||
		!strings.Contains(list[0].Description, "Ship a service") {
		t.Errorf("Description = %q, want the hint and the description", list[0].Description)
	}
}

// The registry merges built-ins and external commands, and a built-in shadows an
// external command of the same name in both List and Run.
func TestCommandService_MergesExternalRunner(t *testing.T) {
	svc, _, _ := setupExtCommands(t)
	mustCreateCommand(t, svc, &model.ExternalCommand{Trigger: "deploy", RequestURL: "https://hooks.example.com/run"})

	registry := NewCommandService()
	registry.Register(&fakeCommand{info: CommandInfo{Name: "builtin"}})
	registry.SetExternalRunner(svc)

	names := map[string]bool{}
	for _, info := range registry.List(context.Background()) {
		names[info.Name] = true
	}
	if !names["builtin"] || !names["deploy"] {
		t.Fatalf("List = %+v, want both the built-in and the external command", names)
	}
}

// fakeResponseStore is an in-memory CommandResponseStore.
type fakeResponseStore struct {
	mu      sync.Mutex
	pending map[string]*store.PendingCommandResponse
}

func newFakeResponseStore() *fakeResponseStore {
	return &fakeResponseStore{pending: map[string]*store.PendingCommandResponse{}}
}

func (f *fakeResponseStore) Put(_ context.Context, token string, p *store.PendingCommandResponse) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	copied := *p
	f.pending[token] = &copied
	return nil
}

func (f *fakeResponseStore) Get(_ context.Context, token string) (*store.PendingCommandResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p, ok := f.pending[token]
	if !ok {
		return nil, nil
	}
	copied := *p
	return &copied, nil
}

func (f *fakeResponseStore) Delete(_ context.Context, token string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.pending, token)
}

func (f *fakeResponseStore) only(t *testing.T) (string, *store.PendingCommandResponse) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.pending) != 1 {
		t.Fatalf("pending tokens = %d, want exactly 1", len(f.pending))
	}
	for token, p := range f.pending {
		return token, p
	}
	return "", nil
}

// setupExtCommandsWithResponses is setupExtCommands plus a response store, so the
// response_url path is exercised.
func setupExtCommandsWithResponses(t *testing.T) (*ExternalCommandService, *fakeExtCommandStore, *fakeResponseStore, *mockMessageStore) {
	t.Helper()
	msgSvc, messages, memberships, _, _ := setupMessageService()
	if err := memberships.AddMember(context.Background(),
		&model.ChannelMembership{ChannelID: "ch1", UserID: "u1"}, &model.UserChannel{}); err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	cmdStore := newFakeExtCommandStore()
	responses := newFakeResponseStore()
	svc := NewExternalCommandService(ExternalCommandDeps{
		Store:     cmdStore,
		Messages:  msgSvc,
		Responses: responses,
		Resolver:  stubMMResolver{channelSlug: "general", userName: "anna.smith"},
		BaseURL:   "https://ex.example.com",
	})
	return svc, cmdStore, responses, messages
}

func TestRunCommand_HandsOutResponseURL(t *testing.T) {
	useLoopbackWebhookClient(t)
	var gotResponseURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		gotResponseURL = r.PostForm.Get("response_url")
		_ = json.NewEncoder(w).Encode(map[string]string{"response_type": "in_channel", "text": "working on it"})
	}))
	defer srv.Close()

	svc, cmdStore, responses, _ := setupExtCommandsWithResponses(t)
	seedCommand(t, cmdStore, &model.ExternalCommand{Trigger: "deploy", RequestURL: srv.URL, BotUserID: "bot_deploy"})

	res, err := svc.RunCommand(context.Background(), "deploy", CommandRequest{
		UserID: "u1", ParentID: "ch1", ParentType: ParentChannel,
	})
	if err != nil {
		t.Fatalf("RunCommand: %v", err)
	}

	token, pending := responses.only(t)
	if want := "https://ex.example.com/hooks/commands/" + token; gotResponseURL != want {
		t.Errorf("response_url = %q, want %q", gotResponseURL, want)
	}
	// What the token authorizes is pinned server-side at mint time — a stolen token
	// can only do what this invocation could.
	if pending.UserID != "u1" || pending.ParentID != "ch1" || pending.ParentType != ParentChannel {
		t.Errorf("pinned invocation = %+v, want the invoking user and chat", pending)
	}
	if pending.BotUserID != "bot_deploy" {
		t.Errorf("pinned bot = %q, want the command's bot", pending.BotUserID)
	}
	// A delayed response threads under the message the synchronous one posted.
	if res.Message == nil || pending.RootMessageID != res.Message.ID {
		t.Errorf("pinned root = %q, want the posted message id", pending.RootMessageID)
	}
}

func TestDeliverDelayedResponse(t *testing.T) {
	ctx := context.Background()

	t.Run("posts an in_channel response as the pinned identity", func(t *testing.T) {
		svc, _, responses, messages := setupExtCommandsWithResponses(t)
		if err := responses.Put(ctx, "tok1", &store.PendingCommandResponse{
			Trigger: "deploy", UserID: "u1", ParentID: "ch1", ParentType: ParentChannel,
			BotUserID: "bot_deploy", Username: "Deploy Bot",
		}); err != nil {
			t.Fatalf("Put: %v", err)
		}
		body := strings.NewReader(`{"response_type":"in_channel","text":"deploy finished"}`)
		if err := svc.DeliverDelayedResponse(ctx, "tok1", body); err != nil {
			t.Fatalf("DeliverDelayedResponse: %v", err)
		}
		var found *model.Message
		for _, m := range messages.messages {
			if m.Body == "deploy finished" {
				found = m
			}
		}
		if found == nil {
			t.Fatal("the delayed response was not posted")
		}
		if found.AuthorID != "bot_deploy" || found.WebhookUsername != "Deploy Bot" {
			t.Errorf("posted as %q/%q, want the pinned bot identity", found.AuthorID, found.WebhookUsername)
		}
	})

	t.Run("an unknown or expired token is refused", func(t *testing.T) {
		svc, _, _, _ := setupExtCommandsWithResponses(t)
		err := svc.DeliverDelayedResponse(ctx, "nope", strings.NewReader(`{"text":"hi"}`))
		if !errors.Is(err, ErrResponseURLExpired) {
			t.Fatalf("err = %v, want ErrResponseURLExpired", err)
		}
	})

	t.Run("an ephemeral delayed response posts nothing", func(t *testing.T) {
		// There is no live caller to show it to, so ephemeral means "drop" here —
		// never "post it publicly", which would leak what was meant to be private.
		svc, _, responses, messages := setupExtCommandsWithResponses(t)
		before := len(messages.messages)
		if err := responses.Put(ctx, "tok2", &store.PendingCommandResponse{
			Trigger: "deploy", UserID: "u1", ParentID: "ch1", ParentType: ParentChannel,
		}); err != nil {
			t.Fatalf("Put: %v", err)
		}
		body := strings.NewReader(`{"response_type":"ephemeral","text":"only for you"}`)
		if err := svc.DeliverDelayedResponse(ctx, "tok2", body); err != nil {
			t.Fatalf("DeliverDelayedResponse: %v", err)
		}
		if len(messages.messages) != before {
			t.Error("an ephemeral delayed response must not be posted into the chat")
		}
	})

	t.Run("a blank response_type is ephemeral (the MM default), never a public post", func(t *testing.T) {
		// An integration that omits response_type expects MM's default — private.
		// Posting it in_channel would publish output meant only for the invoker.
		svc, _, responses, messages := setupExtCommandsWithResponses(t)
		before := len(messages.messages)
		if err := responses.Put(ctx, "tok4", &store.PendingCommandResponse{
			Trigger: "deploy", UserID: "u1", ParentID: "ch1", ParentType: ParentChannel,
		}); err != nil {
			t.Fatalf("Put: %v", err)
		}
		body := strings.NewReader(`{"text":"internal progress note for the invoker"}`)
		if err := svc.DeliverDelayedResponse(ctx, "tok4", body); err != nil {
			t.Fatalf("DeliverDelayedResponse: %v", err)
		}
		if len(messages.messages) != before {
			t.Error("a delayed response without response_type must not be posted publicly")
		}
	})

	t.Run("a user who lost access cannot be posted on behalf of", func(t *testing.T) {
		svc, _, responses, _ := setupExtCommandsWithResponses(t)
		if err := responses.Put(ctx, "tok3", &store.PendingCommandResponse{
			Trigger: "deploy", UserID: "gone", ParentID: "ch1", ParentType: ParentChannel,
		}); err != nil {
			t.Fatalf("Put: %v", err)
		}
		err := svc.DeliverDelayedResponse(ctx, "tok3", strings.NewReader(`{"response_type":"in_channel","text":"late"}`))
		if err == nil {
			t.Fatal("want a rejection when the invoking user can no longer post there")
		}
	})
}
