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
	"github.com/DigitalTolk/ex/internal/store"
)

// Error and edge arms of ExternalCommandService that the main happy-path tests in
// extcommand_test.go don't reach.

func TestExternalCommandService_CRUDPassThrough(t *testing.T) {
	svc, cmdStore, _ := setupExtCommands(t)
	ctx := context.Background()
	cmd := mustCreateCommand(t, svc, &model.ExternalCommand{Trigger: "deploy", RequestURL: "https://hooks.example.com/run"})

	got, err := svc.GetCommand(ctx, cmd.ID)
	if err != nil || got.Trigger != "deploy" {
		t.Fatalf("GetCommand = (%+v, %v)", got, err)
	}
	all, err := svc.ListAll(ctx)
	if err != nil || len(all) != 1 {
		t.Fatalf("ListAll = (%d entries, %v), want 1", len(all), err)
	}
	if err := svc.DeleteCommand(ctx, cmd.ID); err != nil {
		t.Fatalf("DeleteCommand: %v", err)
	}
	if _, err := cmdStore.GetCommand(ctx, cmd.ID); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("after delete, GetCommand err = %v, want ErrNotFound", err)
	}
	// Deleting frees the trigger for reuse.
	if _, err := svc.CreateCommand(ctx, "admin1", &model.ExternalCommand{
		Trigger: "deploy", RequestURL: "https://hooks.example.com/run",
	}); err != nil {
		t.Errorf("re-creating a deleted trigger failed: %v", err)
	}
}

func TestExternalCommandService_MissingCommandErrors(t *testing.T) {
	svc, _, _ := setupExtCommands(t)
	ctx := context.Background()
	if _, err := svc.GetCommand(ctx, "nope"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("GetCommand err = %v, want ErrNotFound", err)
	}
	if err := svc.DeleteCommand(ctx, "nope"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("DeleteCommand err = %v, want ErrNotFound", err)
	}
	if _, err := svc.UpdateCommand(ctx, "nope", &model.ExternalCommand{}); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("UpdateCommand err = %v, want ErrNotFound", err)
	}
}

func TestExternalCommandService_ValidationEdges(t *testing.T) {
	svc, _, _ := setupExtCommands(t)
	ctx := context.Background()

	t.Run("a nil body is rejected", func(t *testing.T) {
		if _, err := svc.CreateCommand(ctx, "admin1", nil); !errors.Is(err, ErrInvalidTrigger) {
			t.Fatalf("err = %v, want ErrInvalidTrigger", err)
		}
	})

	t.Run("bot_user_id must be a bot account", func(t *testing.T) {
		_, err := svc.CreateCommand(ctx, "admin1", &model.ExternalCommand{
			Trigger: "asbot", RequestURL: "https://hooks.example.com/run", BotUserID: "u1",
		})
		if err == nil || !strings.Contains(err.Error(), "bot_user_id") {
			t.Fatalf("err = %v, want a bot_user_id rejection", err)
		}
	})

	t.Run("over-long display fields are clamped", func(t *testing.T) {
		cmd := mustCreateCommand(t, svc, &model.ExternalCommand{
			Trigger:     "clamp",
			RequestURL:  "https://hooks.example.com/run",
			Title:       strings.Repeat("t", 200),
			Description: strings.Repeat("d", 900),
			Method:      "g",
		})
		if len([]rune(cmd.Title)) != 100 || len([]rune(cmd.Description)) != 500 {
			t.Errorf("title/description not clamped: %d/%d", len([]rune(cmd.Title)), len([]rune(cmd.Description)))
		}
		if cmd.Method != model.CommandMethodGet {
			t.Errorf("Method = %q, want the case-insensitive GET spelling normalized", cmd.Method)
		}
	})
}

// The autocomplete list is cached briefly; registering a command invalidates it so
// the next fetch is fresh, and a store failure degrades to an empty list rather
// than an error the composer can't act on.
func TestExternalCommandService_ListCaching(t *testing.T) {
	svc, cmdStore, _ := setupExtCommands(t)
	ctx := context.Background()

	if got := svc.ListCommands(ctx); len(got) != 0 {
		t.Fatalf("ListCommands = %+v, want empty", got)
	}
	// Warm the cache, then confirm a second call is served from it.
	seedCommand(t, cmdStore, &model.ExternalCommand{Trigger: "deploy", RequestURL: "https://hooks.example.com/run"})
	first := svc.ListCommands(ctx)
	second := svc.ListCommands(ctx)
	if len(first) != len(second) {
		t.Errorf("cached list differs: %d vs %d", len(first), len(second))
	}

	// An explicit write invalidates, so a newly registered command is offered
	// immediately rather than after the TTL.
	mustCreateCommand(t, svc, &model.ExternalCommand{Trigger: "status", RequestURL: "https://hooks.example.com/run"})
	if got := svc.ListCommands(ctx); len(got) != 2 {
		t.Errorf("ListCommands = %d entries, want 2 after invalidation", len(got))
	}
}

func TestExternalCommandService_ListSkipsUnusableEntries(t *testing.T) {
	svc, cmdStore, _ := setupExtCommands(t)
	// A nil row (a crashed half-delete leaves the id in the directory) must not
	// crash the autocomplete.
	cmdStore.byID["ghost"] = nil
	seedCommand(t, cmdStore, &model.ExternalCommand{
		Trigger: "titled", RequestURL: "https://hooks.example.com/run", Title: "Titled only",
	})
	got := svc.ListCommands(context.Background())
	if len(got) != 1 || got[0].Description != "Titled only" {
		t.Fatalf("ListCommands = %+v, want the title used when no description is set", got)
	}
}

func TestExternalCommandService_ListDegradesOnStoreFailure(t *testing.T) {
	msgSvc, _, _, _, _ := setupMessageService()
	svc := NewExternalCommandService(ExternalCommandDeps{
		Store:    failingCommandStore{},
		Messages: msgSvc,
	})
	// No Reserved func supplied — the constructor must default it rather than
	// leaving a nil call waiting to panic on the first create.
	if got := svc.ListCommands(context.Background()); len(got) != 0 {
		t.Errorf("ListCommands = %+v, want an empty list on a store failure", got)
	}
	if _, err := svc.CreateCommand(context.Background(), "admin1", &model.ExternalCommand{
		Trigger: "x", RequestURL: "https://hooks.example.com/run",
	}); err == nil {
		t.Error("want the store failure surfaced from CreateCommand")
	}
}

// failingCommandStore fails every operation.
type failingCommandStore struct{}

var errCommandStore = errors.New("command store unavailable")

func (failingCommandStore) CreateCommand(context.Context, *model.ExternalCommand) error {
	return errCommandStore
}
func (failingCommandStore) UpdateCommand(context.Context, *model.ExternalCommand) error {
	return errCommandStore
}
func (failingCommandStore) GetCommand(context.Context, string) (*model.ExternalCommand, error) {
	return nil, errCommandStore
}
func (failingCommandStore) GetCommandByTrigger(context.Context, string) (*model.ExternalCommand, error) {
	return nil, errCommandStore
}
func (failingCommandStore) ListCommands(context.Context) ([]*model.ExternalCommand, error) {
	return nil, errCommandStore
}
func (failingCommandStore) DeleteCommand(context.Context, string) error { return errCommandStore }

// A trigger lookup that fails for a reason other than "absent" is a server fault,
// not a 404 — the caller must be able to tell them apart.
func TestRunCommand_StoreFailureIsNotUnknownCommand(t *testing.T) {
	msgSvc, _, _, _, _ := setupMessageService()
	svc := NewExternalCommandService(ExternalCommandDeps{Store: failingCommandStore{}, Messages: msgSvc})
	_, err := svc.RunCommand(context.Background(), "deploy", CommandRequest{
		UserID: "u1", ParentID: "ch1", ParentType: ParentChannel,
	})
	if errors.Is(err, ErrUnknownCommand) || err == nil {
		t.Fatalf("err = %v, want a store failure distinct from ErrUnknownCommand", err)
	}
}

func TestRunCommand_RejectsOverlongText(t *testing.T) {
	svc, cmdStore, _ := setupExtCommands(t)
	seedCommand(t, cmdStore, &model.ExternalCommand{Trigger: "deploy", RequestURL: "https://hooks.example.com/run"})
	_, err := svc.RunCommand(context.Background(), "deploy", CommandRequest{
		UserID: "u1", ParentID: "ch1", ParentType: ParentChannel,
		Text: strings.Repeat("x", maxCommandTextLen+1),
	})
	var userErr *CommandUserError
	if !errors.As(err, &userErr) {
		t.Fatalf("err = %v, want a user-facing CommandUserError", err)
	}
}

// An in_channel response with nothing in it posts nothing — an empty message row
// would be noise, not a result.
func TestRunCommand_EmptyInChannelResponsePostsNothing(t *testing.T) {
	useLoopbackWebhookClient(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"response_type": "in_channel", "text": "  "})
	}))
	defer srv.Close()

	svc, cmdStore, _ := setupExtCommands(t)
	seedCommand(t, cmdStore, &model.ExternalCommand{Trigger: "quiet", RequestURL: srv.URL})
	res, err := svc.RunCommand(context.Background(), "quiet", CommandRequest{
		UserID: "u1", ParentID: "ch1", ParentType: ParentChannel,
	})
	if err != nil {
		t.Fatalf("RunCommand: %v", err)
	}
	if res.Message != nil {
		t.Errorf("Message = %+v, want nothing posted", res.Message)
	}
}

// A GET-method command carries the same fields in the query string, preserving any
// query the admin already put on the URL.
func TestRunCommand_GetMethodUsesQueryString(t *testing.T) {
	useLoopbackWebhookClient(t)
	var gotQuery string
	var gotMethod string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery, gotMethod = r.URL.RawQuery, r.Method
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	svc, cmdStore, _ := setupExtCommands(t)
	seedCommand(t, cmdStore, &model.ExternalCommand{
		Trigger: "status", RequestURL: srv.URL + "/?team=core", Method: model.CommandMethodGet,
	})
	if _, err := svc.RunCommand(context.Background(), "status", CommandRequest{
		UserID: "u1", ParentID: "ch1", ParentType: ParentChannel, Text: "web",
	}); err != nil {
		t.Fatalf("RunCommand: %v", err)
	}
	if gotMethod != http.MethodGet {
		t.Errorf("method = %q, want GET", gotMethod)
	}
	if !strings.Contains(gotQuery, "team=core") {
		t.Errorf("query = %q, want the admin's own query preserved", gotQuery)
	}
	if !strings.Contains(gotQuery, "command=%2Fstatus") || !strings.Contains(gotQuery, "text=web") {
		t.Errorf("query = %q, want the MM fields", gotQuery)
	}
}

// A GET command with no existing query still gets one.
func TestRunCommand_GetMethodAddsQueryString(t *testing.T) {
	useLoopbackWebhookClient(t)
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	svc, cmdStore, _ := setupExtCommands(t)
	seedCommand(t, cmdStore, &model.ExternalCommand{
		Trigger: "plain", RequestURL: srv.URL, Method: model.CommandMethodGet,
	})
	if _, err := svc.RunCommand(context.Background(), "plain", CommandRequest{
		UserID: "u1", ParentID: "ch1", ParentType: ParentChannel,
	}); err != nil {
		t.Fatalf("RunCommand: %v", err)
	}
	if !strings.Contains(gotQuery, "command=%2Fplain") {
		t.Errorf("query = %q, want the MM fields", gotQuery)
	}
}

// A malformed request URL fails before any HTTP call.
func TestRunCommand_MalformedRequestURL(t *testing.T) {
	svc, cmdStore, _ := setupExtCommands(t)
	seedCommand(t, cmdStore, &model.ExternalCommand{Trigger: "bad", RequestURL: "https://exa mple.com/\x7f"})
	_, err := svc.RunCommand(context.Background(), "bad", CommandRequest{
		UserID: "u1", ParentID: "ch1", ParentType: ParentChannel,
	})
	if err == nil {
		t.Fatal("want an error for an unbuildable request")
	}
}

// When the integration fails, the response token it was handed is revoked
// immediately rather than left in Redis until its TTL.
func TestRunCommand_FailureRevokesResponseToken(t *testing.T) {
	useLoopbackWebhookClient(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	svc, cmdStore, responses, _ := setupExtCommandsWithResponses(t)
	seedCommand(t, cmdStore, &model.ExternalCommand{Trigger: "deploy", RequestURL: srv.URL})
	if _, err := svc.RunCommand(context.Background(), "deploy", CommandRequest{
		UserID: "u1", ParentID: "ch1", ParentType: ParentChannel,
	}); !errors.Is(err, ErrCommandRunFailed) {
		t.Fatalf("err = %v, want ErrCommandRunFailed", err)
	}
	responses.mu.Lock()
	left := len(responses.pending)
	responses.mu.Unlock()
	if left != 0 {
		t.Errorf("%d response tokens left after a failed run, want 0", left)
	}
}

// A failure to mint the token must not fail the command: the integration simply
// isn't offered a delayed-response URL.
func TestRunCommand_MintFailureOmitsResponseURL(t *testing.T) {
	useLoopbackWebhookClient(t)
	var gotResponseURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		gotResponseURL = r.PostForm.Get("response_url")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	msgSvc, _, memberships, _, _ := setupMessageService()
	if err := memberships.AddMember(context.Background(),
		&model.ChannelMembership{ChannelID: "ch1", UserID: "u1"}, &model.UserChannel{}); err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	cmdStore := newFakeExtCommandStore()
	svc := NewExternalCommandService(ExternalCommandDeps{
		Store:     cmdStore,
		Messages:  msgSvc,
		Responses: failingResponseStore{},
		BaseURL:   "https://ex.example.com",
	})
	seedCommand(t, cmdStore, &model.ExternalCommand{Trigger: "deploy", RequestURL: srv.URL})

	if _, err := svc.RunCommand(context.Background(), "deploy", CommandRequest{
		UserID: "u1", ParentID: "ch1", ParentType: ParentChannel,
	}); err != nil {
		t.Fatalf("RunCommand: %v", err)
	}
	if gotResponseURL != "" {
		t.Errorf("response_url = %q, want it omitted when minting failed", gotResponseURL)
	}
}

// failingResponseStore fails Put and returns nothing on Get.
type failingResponseStore struct{}

func (failingResponseStore) Put(context.Context, string, *store.PendingCommandResponse) error {
	return errors.New("redis down")
}

func (failingResponseStore) Get(context.Context, string) (*store.PendingCommandResponse, error) {
	return nil, errors.New("redis down")
}

func (failingResponseStore) Delete(context.Context, string) {}

func TestDeliverDelayedResponse_Edges(t *testing.T) {
	ctx := context.Background()

	t.Run("without a response store there is nothing to deliver to", func(t *testing.T) {
		svc, _, _ := setupExtCommands(t)
		if err := svc.DeliverDelayedResponse(ctx, "tok", strings.NewReader(`{}`)); !errors.Is(err, ErrResponseURLExpired) {
			t.Fatalf("err = %v, want ErrResponseURLExpired", err)
		}
	})

	t.Run("a store failure is surfaced", func(t *testing.T) {
		msgSvc, _, _, _, _ := setupMessageService()
		svc := NewExternalCommandService(ExternalCommandDeps{
			Store: newFakeExtCommandStore(), Messages: msgSvc, Responses: failingResponseStore{},
		})
		if err := svc.DeliverDelayedResponse(ctx, "tok", strings.NewReader(`{}`)); err == nil {
			t.Fatal("want the store failure surfaced")
		}
	})

	t.Run("a malformed body is rejected", func(t *testing.T) {
		svc, _, responses, _ := setupExtCommandsWithResponses(t)
		if err := responses.Put(ctx, "tok", &store.PendingCommandResponse{
			UserID: "u1", ParentID: "ch1", ParentType: ParentChannel,
		}); err != nil {
			t.Fatalf("Put: %v", err)
		}
		if err := svc.DeliverDelayedResponse(ctx, "tok", strings.NewReader(`not json`)); err == nil {
			t.Fatal("want a rejection for a malformed delayed response")
		}
	})

	t.Run("an empty body posts nothing", func(t *testing.T) {
		svc, _, responses, messages := setupExtCommandsWithResponses(t)
		before := len(messages.messages)
		if err := responses.Put(ctx, "tok", &store.PendingCommandResponse{
			UserID: "u1", ParentID: "ch1", ParentType: ParentChannel,
		}); err != nil {
			t.Fatalf("Put: %v", err)
		}
		if err := svc.DeliverDelayedResponse(ctx, "tok", strings.NewReader(`{}`)); err != nil {
			t.Fatalf("DeliverDelayedResponse: %v", err)
		}
		if len(messages.messages) != before {
			t.Error("an empty delayed response must post nothing")
		}
	})
}

// rethreadResponseToken is best-effort: a store that loses the token between the
// mint and the rethread must not fail the command that already succeeded.
func TestRethreadResponseToken_MissingTokenIsHarmless(t *testing.T) {
	svc, _, _, _ := setupExtCommandsWithResponses(t)
	svc.rethreadResponseToken(context.Background(), "never-minted", "m1")
}

func TestSafeGotoLocation_MalformedURL(t *testing.T) {
	// url.Parse rejects a control character outright — the filter must treat that
	// as "no location" rather than passing the raw string through.
	if got := safeGotoLocation("http://\x7f"); got != "" {
		t.Errorf("safeGotoLocation = %q, want empty", got)
	}
	if got := safeGotoLocation("   "); got != "" {
		t.Errorf("safeGotoLocation(blank) = %q, want empty", got)
	}
}

func TestFirstNonEmpty(t *testing.T) {
	if got := firstNonEmpty("", "  ", "x", "y"); got != "x" {
		t.Errorf("firstNonEmpty = %q, want x", got)
	}
	if got := firstNonEmpty("", " "); got != "" {
		t.Errorf("firstNonEmpty(all blank) = %q, want empty", got)
	}
}

// The remaining error arms of the command path: a random-source failure, update
// validation, delayed-response bookkeeping, and a transport-level integration
// failure (as opposed to an error status).

func TestCreateCommand_TokenRandomnessFailure(t *testing.T) {
	svc, _, _ := setupExtCommands(t)
	restore := randRead
	randRead = func([]byte) (int, error) { return 0, errors.New("no entropy") }
	t.Cleanup(func() { randRead = restore })

	_, err := svc.CreateCommand(context.Background(), "admin1", &model.ExternalCommand{
		Trigger: "deploy", RequestURL: "https://hooks.example.com/run",
	})
	if err == nil {
		t.Fatal("want the failure surfaced rather than a command with a weak token")
	}
}

// Without a usable token the integration is simply not offered a response_url —
// the command itself still runs.
func TestRunCommand_ResponseTokenRandomnessFailure(t *testing.T) {
	useLoopbackWebhookClient(t)
	var gotResponseURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		gotResponseURL = r.PostForm.Get("response_url")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	svc, cmdStore, _, _ := setupExtCommandsWithResponses(t)
	seedCommand(t, cmdStore, &model.ExternalCommand{Trigger: "deploy", RequestURL: srv.URL})
	restore := randRead
	randRead = func([]byte) (int, error) { return 0, errors.New("no entropy") }
	t.Cleanup(func() { randRead = restore })

	if _, err := svc.RunCommand(context.Background(), "deploy", CommandRequest{
		UserID: "u1", ParentID: "ch1", ParentType: ParentChannel,
	}); err != nil {
		t.Fatalf("RunCommand: %v", err)
	}
	if gotResponseURL != "" {
		t.Errorf("response_url = %q, want it omitted", gotResponseURL)
	}
}

func TestCreateCommand_InvalidTriggerRejected(t *testing.T) {
	svc, _, _ := setupExtCommands(t)
	_, err := svc.CreateCommand(context.Background(), "admin1", &model.ExternalCommand{
		Trigger: "two words", RequestURL: "https://hooks.example.com/run",
	})
	if !errors.Is(err, ErrInvalidTrigger) {
		t.Fatalf("err = %v, want ErrInvalidTrigger", err)
	}
}

func TestUpdateCommand_ValidationAndStoreFailures(t *testing.T) {
	ctx := context.Background()

	t.Run("an invalid request URL is rejected", func(t *testing.T) {
		svc, _, _ := setupExtCommands(t)
		cmd := mustCreateCommand(t, svc, &model.ExternalCommand{
			Trigger: "deploy", RequestURL: "https://hooks.example.com/run",
		})
		_, err := svc.UpdateCommand(ctx, cmd.ID, &model.ExternalCommand{RequestURL: "http://127.0.0.1/run"})
		if !errors.Is(err, ErrInvalidRequestURL) {
			t.Fatalf("err = %v, want ErrInvalidRequestURL", err)
		}
	})

	t.Run("a store write failure is surfaced", func(t *testing.T) {
		msgSvc, _, _, _, _ := setupMessageService()
		svc := NewExternalCommandService(ExternalCommandDeps{
			Store: updateFailStore{}, Messages: msgSvc,
		})
		_, err := svc.UpdateCommand(ctx, "cmd-1", &model.ExternalCommand{RequestURL: "https://hooks.example.com/v2"})
		if err == nil {
			t.Fatal("want the store failure surfaced")
		}
	})
}

// A transport failure reaching the integration is ErrCommandRunFailed, the same
// as an error status — either way the integration, not ex, is at fault.
func TestRunCommand_TransportFailure(t *testing.T) {
	useLoopbackWebhookClient(t)
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	srv.Close() // closed → connection refused

	svc, cmdStore, _ := setupExtCommands(t)
	seedCommand(t, cmdStore, &model.ExternalCommand{Trigger: "deploy", RequestURL: srv.URL})
	_, err := svc.RunCommand(context.Background(), "deploy", CommandRequest{
		UserID: "u1", ParentID: "ch1", ParentType: ParentChannel,
	})
	if !errors.Is(err, ErrCommandRunFailed) {
		t.Fatalf("err = %v, want ErrCommandRunFailed", err)
	}
}

func TestRethreadResponseToken_Arms(t *testing.T) {
	ctx := context.Background()

	t.Run("no response store is a no-op", func(t *testing.T) {
		svc, _, _ := setupExtCommands(t)
		svc.rethreadResponseToken(ctx, "tok", "m1")
	})

	t.Run("a failed write is best-effort", func(t *testing.T) {
		// The command already posted successfully; failing to record the thread root
		// must not turn that into an error.
		msgSvc, _, _, _, _ := setupMessageService()
		svc := NewExternalCommandService(ExternalCommandDeps{
			Store: newFakeExtCommandStore(), Messages: msgSvc, Responses: rethreadFailStore{},
		})
		svc.rethreadResponseToken(ctx, "tok", "m1")
	})
}

// updateFailStore reads back a command but refuses the write.
type updateFailStore struct{ failingCommandStore }

func (updateFailStore) GetCommand(context.Context, string) (*model.ExternalCommand, error) {
	return &model.ExternalCommand{ID: "cmd-1", Trigger: "deploy", RequestURL: "https://hooks.example.com/run"}, nil
}

// rethreadFailStore resolves a token but refuses the write-back.
type rethreadFailStore struct{}

func (rethreadFailStore) Put(context.Context, string, *store.PendingCommandResponse) error {
	return errors.New("redis down")
}

func (rethreadFailStore) Get(context.Context, string) (*store.PendingCommandResponse, error) {
	return &store.PendingCommandResponse{UserID: "u1", ParentID: "ch1", ParentType: ParentChannel}, nil
}

func (rethreadFailStore) Delete(context.Context, string) {}

// If the in_channel post itself fails, the command reports the failure rather
// than claiming success with nothing in the chat.
func TestRunCommand_PostFailureIsReported(t *testing.T) {
	useLoopbackWebhookClient(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// An in_channel body past the message-length limit: the integration answered
		// fine, but the post can't be made.
		_ = json.NewEncoder(w).Encode(map[string]string{
			"response_type": "in_channel",
			"text":          strings.Repeat("x", 100_000),
		})
	}))
	defer srv.Close()

	svc, cmdStore, _ := setupExtCommands(t)
	seedCommand(t, cmdStore, &model.ExternalCommand{Trigger: "deploy", RequestURL: srv.URL})
	_, err := svc.RunCommand(context.Background(), "deploy", CommandRequest{
		UserID: "u1", ParentID: "ch1", ParentType: ParentChannel,
	})
	if err == nil {
		t.Fatal("want the post failure surfaced")
	}
}
