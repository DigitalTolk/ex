package handler

// Coverage tests for internal/handler/agentworkspace.go — the agent workspace
// tool surface (channels, DMs, search, reactions, reminders, pins, notify).
// All identifiers are prefixed hwsCov to avoid colliding with sibling test
// files. The orchestrator runs on in-file fakes; the channel/conversation/
// message services run on the shared in-package data stores.

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/search"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// ---------------------------------------------------------------- run store

type hwsCovRunStore struct {
	runs      map[string]*model.Run
	events    []*model.RunEvent
	approvals map[string][]*model.Approval
	updateErr error
	apprErr   error
}

func newHwsCovRunStore() *hwsCovRunStore {
	return &hwsCovRunStore{
		runs:      map[string]*model.Run{},
		approvals: map[string][]*model.Approval{},
	}
}

func (f *hwsCovRunStore) CreateRun(_ context.Context, run *model.Run) error {
	f.runs[run.ID] = run
	return nil
}
func (f *hwsCovRunStore) GetRun(_ context.Context, runID string) (*model.Run, error) {
	run, ok := f.runs[runID]
	if !ok {
		return nil, store.ErrNotFound
	}
	return run, nil
}
func (f *hwsCovRunStore) UpdateRun(_ context.Context, run *model.Run, _ model.RunState) error {
	if f.updateErr != nil {
		return f.updateErr
	}
	f.runs[run.ID] = run
	return nil
}
func (f *hwsCovRunStore) RenewRunLease(context.Context, string, string, time.Time) error {
	return nil
}
func (f *hwsCovRunStore) ListQueuedRuns(context.Context, string, int) ([]string, error) {
	return nil, nil
}
func (f *hwsCovRunStore) ClaimRun(context.Context, *model.Run, string, time.Time) error {
	return nil
}
func (f *hwsCovRunStore) DeleteQueueEntry(context.Context, string, string) error { return nil }
func (f *hwsCovRunStore) ListActiveRunsPastDeadline(context.Context, time.Time, int) ([]*model.Run, error) {
	return nil, nil
}
func (f *hwsCovRunStore) ListActiveRuns(context.Context) ([]*model.Run, error) { return nil, nil }
func (f *hwsCovRunStore) AppendRunEvent(_ context.Context, evt *model.RunEvent) error {
	f.events = append(f.events, evt)
	return nil
}
func (f *hwsCovRunStore) ListRunEvents(context.Context, string) ([]*model.RunEvent, error) {
	return nil, nil
}
func (f *hwsCovRunStore) DeleteRunEvents(context.Context, string) error       { return nil }
func (f *hwsCovRunStore) PutDigest(context.Context, *model.RunDigest) error   { return nil }
func (f *hwsCovRunStore) GetDigest(context.Context, string) (*model.RunDigest, error) {
	return nil, store.ErrNotFound
}
func (f *hwsCovRunStore) ListRunsByParent(context.Context, string, int) ([]*model.Run, error) {
	return nil, nil
}
func (f *hwsCovRunStore) PutApproval(_ context.Context, a *model.Approval) error {
	f.approvals[a.RunID] = append(f.approvals[a.RunID], a)
	return nil
}
func (f *hwsCovRunStore) GetApproval(context.Context, string, string) (*model.Approval, error) {
	return nil, store.ErrNotFound
}
func (f *hwsCovRunStore) SettleApproval(_ context.Context, _, _, _, _, _, _ string, _ time.Time) error {
	return nil
}
func (f *hwsCovRunStore) ListApprovals(_ context.Context, runID string) ([]*model.Approval, error) {
	if f.apprErr != nil {
		return nil, f.apprErr
	}
	return f.approvals[runID], nil
}
func (f *hwsCovRunStore) PutArtifact(context.Context, *model.Artifact) error { return nil }
func (f *hwsCovRunStore) ListArtifacts(context.Context, string) ([]*model.Artifact, error) {
	return nil, nil
}

// ------------------------------------------------- orchestrator side fakes

type hwsCovOrchMsgs struct {
	msgs    []*model.Message
	listErr error
}

func (f *hwsCovOrchMsgs) SendAsAgentRun(context.Context, string, string, string, string, string, string, string) (*model.Message, error) {
	return &model.Message{ID: "hws-orch-msg"}, nil
}
func (f *hwsCovOrchMsgs) SetMachineReaction(context.Context, string, string, string, string, string) error {
	return nil
}
func (f *hwsCovOrchMsgs) ListThreadMessages(context.Context, string, string, string, string) ([]*model.Message, error) {
	return f.msgs, f.listErr
}
func (f *hwsCovOrchMsgs) List(context.Context, string, string, string, string, int) ([]*model.Message, bool, error) {
	return f.msgs, false, f.listErr
}

type hwsCovOrchUsers struct{}

func (hwsCovOrchUsers) GetUser(context.Context, string) (*model.User, error) {
	return nil, store.ErrNotFound
}
func (hwsCovOrchUsers) GetUsersByIDs(context.Context, []string) ([]*model.User, error) {
	return nil, nil
}

// hwsCovAgentDir is an empty agent directory: no templates, no skills — just
// enough for AgentService to answer roster/follow calls without falling over.
type hwsCovAgentDir struct{}

func (hwsCovAgentDir) PutTemplate(context.Context, *model.AgentTemplate) error { return nil }
func (hwsCovAgentDir) CreateTemplateIfAbsent(context.Context, *model.AgentTemplate) error {
	return nil
}
func (hwsCovAgentDir) GetTemplate(context.Context, string) (*model.AgentTemplate, error) {
	return nil, store.ErrNotFound
}
func (hwsCovAgentDir) ListTemplates(context.Context) ([]*model.AgentTemplate, error) {
	return nil, nil
}
func (hwsCovAgentDir) CreateAgentUser(context.Context, *model.User) error          { return nil }
func (hwsCovAgentDir) PutAgentPrefs(context.Context, *model.UserAgentPrefs) error  { return nil }
func (hwsCovAgentDir) GetAgentPrefs(context.Context, string, string) (*model.UserAgentPrefs, error) {
	return nil, store.ErrNotFound
}
func (hwsCovAgentDir) PutRunner(context.Context, *model.RunnerRegistration) error { return nil }
func (hwsCovAgentDir) ListRunners(context.Context, string) ([]*model.RunnerRegistration, error) {
	return nil, nil
}
func (hwsCovAgentDir) DeleteRunner(context.Context, string, string) error { return nil }
func (hwsCovAgentDir) PutSkill(context.Context, *model.Skill) error       { return nil }
func (hwsCovAgentDir) GetSkill(context.Context, string) (*model.Skill, error) {
	return nil, store.ErrNotFound
}
func (hwsCovAgentDir) ListSkills(context.Context) ([]*model.Skill, error) { return nil, nil }
func (hwsCovAgentDir) DeleteSkill(context.Context, string) error          { return nil }
func (hwsCovAgentDir) PutAgentMemory(context.Context, *model.AgentMemory) error {
	return nil
}
func (hwsCovAgentDir) GetAgentMemory(context.Context, string, string) (*model.AgentMemory, error) {
	return nil, store.ErrNotFound
}
func (hwsCovAgentDir) PutAgentSubscription(context.Context, *model.AgentSubscription) error {
	return nil
}
func (hwsCovAgentDir) ListSubscriptionsByParent(context.Context, string) ([]*model.AgentSubscription, error) {
	return nil, nil
}
func (hwsCovAgentDir) ListAllSubscriptions(context.Context) ([]*model.AgentSubscription, error) {
	return nil, nil
}
func (hwsCovAgentDir) DeleteAgentSubscription(context.Context, string, string) error { return nil }
func (hwsCovAgentDir) PutTaskClaim(context.Context, *model.TaskClaim) error          { return nil }
func (hwsCovAgentDir) ListTaskClaims(context.Context, string, string) ([]*model.TaskClaim, error) {
	return nil, nil
}
func (hwsCovAgentDir) PutAgentFollow(context.Context, *model.AgentThreadFollow) error { return nil }
func (hwsCovAgentDir) ListAgentFollows(context.Context, string, string) ([]*model.AgentThreadFollow, error) {
	return nil, nil
}

type hwsCovAgentUsers struct{}

func (hwsCovAgentUsers) GetUser(context.Context, string) (*model.User, error) {
	return nil, store.ErrNotFound
}
func (hwsCovAgentUsers) UpdateUser(context.Context, *model.User) error { return nil }

// ---------------------------------------------------------- reminder fakes

type hwsCovRemStore struct {
	scheduled []*model.Reminder
	schedErr  error
	rems      []*model.Reminder
	listErr   error
	cancelOK  bool
	cancelErr error
}

func (f *hwsCovRemStore) ScheduleReminder(_ context.Context, r *model.Reminder) error {
	if f.schedErr != nil {
		return f.schedErr
	}
	f.scheduled = append(f.scheduled, r)
	return nil
}
func (f *hwsCovRemStore) CancelReminder(context.Context, string, string) (bool, error) {
	return f.cancelOK, f.cancelErr
}
func (f *hwsCovRemStore) ListPendingReminders(context.Context, string) ([]*model.Reminder, error) {
	return f.rems, f.listErr
}
func (f *hwsCovRemStore) ClaimDueReminders(context.Context, int) ([]*model.Reminder, error) {
	return nil, nil
}

type hwsCovRemMsgs struct{ err error }

func (f *hwsCovRemMsgs) GetMessage(_ context.Context, parentID, msgID string) (*model.Message, error) {
	if f.err != nil {
		return nil, f.err
	}
	return &model.Message{ID: msgID, ParentID: parentID, Body: "anchor body"}, nil
}

type hwsCovRemAccess struct{ err error }

func (f *hwsCovRemAccess) CheckAccess(context.Context, string, string, string) error {
	return f.err
}

// ------------------------------------------------------------ search fakes

type hwsCovSearcher struct {
	usersHits []search.SearchHit
	usersErr  error
	msgHits   []search.SearchHit
	msgErr    error
}

func (f *hwsCovSearcher) Users(context.Context, string, int) (*search.SearchResult, error) {
	if f.usersErr != nil {
		return nil, f.usersErr
	}
	return &search.SearchResult{Total: len(f.usersHits), Hits: f.usersHits}, nil
}
func (f *hwsCovSearcher) Channels(context.Context, search.ChannelQuery) (*search.SearchResult, error) {
	return &search.SearchResult{}, nil
}
func (f *hwsCovSearcher) Messages(context.Context, search.MessageQuery) (*search.SearchResult, error) {
	if f.msgErr != nil {
		return nil, f.msgErr
	}
	return &search.SearchResult{Total: len(f.msgHits), Hits: f.msgHits}, nil
}
func (f *hwsCovSearcher) Files(context.Context, search.MessageQuery) (*search.SearchResult, error) {
	return &search.SearchResult{}, nil
}

type hwsCovAccessStub struct {
	parents []string
	err     error
}

func (f *hwsCovAccessStub) AllowedParentIDs(context.Context, string) ([]string, error) {
	return f.parents, f.err
}

// ------------------------------------------------------------------- env

type hwsCovEnv struct {
	h        *AgentRunToolHandler
	hBare    *AgentRunToolHandler // workspace deps without search/reminders/conversations
	run      *model.Run
	claims   *model.TokenClaims
	runs     *hwsCovRunStore
	orchMsgs *hwsCovOrchMsgs
	chans    *dataChannelStore
	members  *dataMembershipStore
	msgs     *dataMessageStore
	convs    *dataConversationStore
	remStore *hwsCovRemStore
	searcher *hwsCovSearcher
	access   *hwsCovAccessStub
}

func newHwsCovEnv(t *testing.T) *hwsCovEnv {
	t.Helper()

	runs := newHwsCovRunStore()
	run := &model.Run{
		ID:         "hws-run",
		AgentID:    "hws-agent",
		OwnerID:    "hws-inv",
		InvokerID:  "hws-inv",
		ParentID:   "hws-home",
		ParentType: service.ParentChannel,
		MessageID:  "hws-m1",
		State:      model.RunStateRunning,
		Limits:     model.AgentLimits{MaxPosts: 5},
	}
	runs.runs[run.ID] = run

	orchMsgs := &hwsCovOrchMsgs{}
	agentSvc := service.NewAgentService(hwsCovAgentDir{}, hwsCovAgentUsers{})
	orch := service.NewOrchestrator(runs, agentSvc, hwsCovOrchUsers{}, orchMsgs, nil, nil)

	chans := newDataChannelStore()
	members := newDataMembershipStore()
	msgs := newDataMessageStore()
	convs := newDataConversationStore()
	users := newDataUserStoreForConv()
	broker := &mockBrokerForHandler{}

	for _, u := range []*model.User{
		{ID: "hws-inv", Email: "hws-inv@x.test", DisplayName: "Ivy Invoker"},
		{ID: "hws-bob", Email: "hws-bob@x.test", DisplayName: "Bob Person"},
		{ID: "hws-agent", Email: "hws-agent@x.test", DisplayName: "gg"},
	} {
		if err := users.CreateUser(context.Background(), u); err != nil {
			t.Fatalf("seed user %s: %v", u.ID, err)
		}
	}

	// The run's home channel, the invoker's membership, and a message to
	// react to / pin.
	chans.channels["hws-home"] = &model.Channel{
		ID: "hws-home", Name: "home", Slug: "hws-home", Type: model.ChannelTypePublic,
	}
	if err := members.AddMember(context.Background(), &model.ChannelMembership{
		ChannelID: "hws-home", UserID: "hws-inv", Role: model.ChannelRoleMember,
	}, nil); err != nil {
		t.Fatalf("seed membership: %v", err)
	}
	msgs.messages["hws-home#hws-m1"] = &model.Message{
		ID: "hws-m1", ParentID: "hws-home", AuthorID: "hws-bob", Body: "root",
	}

	messageSvc := service.NewMessageService(msgs, members, convs, nil, broker)
	channelSvc := service.NewChannelService(chans, members, nil, msgs, newMockCache(), broker, nil)
	convSvc := service.NewConversationService(convs, users, nil, broker, nil)
	remStore := &hwsCovRemStore{cancelOK: true}
	remSvc := service.NewReminderService(remStore, &hwsCovRemMsgs{}, &hwsCovRemAccess{})
	searcher := &hwsCovSearcher{}
	access := &hwsCovAccessStub{parents: []string{"hws-home"}}

	h := NewAgentRunToolHandler(orch, messageSvc, nil, agentSvc)
	h.SetWorkspace(AgentWorkspaceDeps{
		Channels:      channelSvc,
		Conversations: convSvc,
		Searcher:      searcher,
		SearchAccess:  access,
		Reminders:     remSvc,
	})

	hBare := NewAgentRunToolHandler(orch, messageSvc, nil, agentSvc)
	hBare.SetWorkspace(AgentWorkspaceDeps{Channels: channelSvc})

	return &hwsCovEnv{
		h:        h,
		hBare:    hBare,
		run:      run,
		claims:   &model.TokenClaims{UserID: "hws-inv", ActorID: "hws-agent", RunID: "hws-run"},
		runs:     runs,
		orchMsgs: orchMsgs,
		chans:    chans,
		members:  members,
		msgs:     msgs,
		convs:    convs,
		remStore: remStore,
		searcher: searcher,
		access:   access,
	}
}

// ghost returns claims bound to a run that does not exist, so GetLiveRun fails.
func (e *hwsCovEnv) ghost() *model.TokenClaims {
	return &model.TokenClaims{UserID: "hws-inv", ActorID: "hws-agent", RunID: "hws-ghost"}
}

func (e *hwsCovEnv) do(t *testing.T, h http.HandlerFunc, method, target, body, pathID string, claims *model.TokenClaims) *httptest.ResponseRecorder {
	t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, rd)
	if claims == nil {
		claims = e.claims
	}
	req = req.WithContext(middleware.ContextWithClaims(req.Context(), claims))
	if pathID != "" {
		req.SetPathValue("id", pathID)
	}
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec
}

func hwsCovWant(t *testing.T, rec *httptest.ResponseRecorder, code int, substr string) {
	t.Helper()
	if rec.Code != code {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, code, rec.Body.String())
	}
	if substr != "" && !strings.Contains(rec.Body.String(), substr) {
		t.Fatalf("body %q missing %q", rec.Body.String(), substr)
	}
}

// ------------------------------------------------------------------ tests

// TestHwsCovGetLiveRunGate exercises the leading GetLiveRun arm of every
// workspace endpoint: an unknown run yields the tool error (404 not_found).
func TestHwsCovGetLiveRunGate(t *testing.T) {
	env := newHwsCovEnv(t)
	endpoints := []struct {
		name   string
		h      http.HandlerFunc
		method string
		body   string
	}{
		{"ListChannels", env.h.ListChannels, http.MethodGet, ""},
		{"CreateChannel", env.h.CreateChannel, http.MethodPost, `{"name":"x"}`},
		{"JoinChannel", env.h.JoinChannel, http.MethodPost, ""},
		{"ReadChannel", env.h.ReadChannel, http.MethodGet, ""},
		{"PostToChannel", env.h.PostToChannel, http.MethodPost, `{"body":"hi"}`},
		{"SearchWorkspace", env.h.SearchWorkspace, http.MethodGet, ""},
		{"React", env.h.React, http.MethodPost, `{"messageID":"m","emoji":"x"}`},
		{"ListUsers", env.h.ListUsers, http.MethodGet, ""},
		{"SendDM", env.h.SendDM, http.MethodPost, `{"userID":"u","body":"hi"}`},
		{"SetReminder", env.h.SetReminder, http.MethodPost, `{"in_minutes":5}`},
		{"ListReminders", env.h.ListReminders, http.MethodGet, ""},
		{"CancelReminder", env.h.CancelReminder, http.MethodDelete, ""},
		{"PinMessage", env.h.PinMessage, http.MethodPost, `{"message_id":"m"}`},
		{"NotifyOwner", env.h.NotifyOwner, http.MethodPost, `{"body":"hi"}`},
	}
	for _, ep := range endpoints {
		t.Run(ep.name, func(t *testing.T) {
			rec := env.do(t, ep.h, ep.method, "/", ep.body, "any", env.ghost())
			hwsCovWant(t, rec, http.StatusNotFound, "not_found")
		})
	}
}

func TestHwsCovListChannels(t *testing.T) {
	t.Run("list error", func(t *testing.T) {
		env := newHwsCovEnv(t)
		env.members.listUserChannelsErr = errors.New("boom")
		rec := env.do(t, env.h.ListChannels, http.MethodGet, "/", "", "", nil)
		hwsCovWant(t, rec, http.StatusInternalServerError, "channel list failed")
	})
	t.Run("happy with a channel", func(t *testing.T) {
		env := newHwsCovEnv(t)
		env.members.userChannels = []*model.UserChannel{{
			UserID: "hws-inv", ChannelID: "hws-home", ChannelName: "home",
			ChannelType: model.ChannelTypePublic,
		}}
		rec := env.do(t, env.h.ListChannels, http.MethodGet, "/", "", "", nil)
		hwsCovWant(t, rec, http.StatusOK, "[ch:hws-home] ~home (public)")
	})
	t.Run("no channels", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.ListChannels, http.MethodGet, "/", "", "", nil)
		hwsCovWant(t, rec, http.StatusOK, "(the invoker is in no channels)")
	})
}

func TestHwsCovCreateChannel(t *testing.T) {
	t.Run("bad body", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.CreateChannel, http.MethodPost, "/", `{"name":"   "}`, "", nil)
		hwsCovWant(t, rec, http.StatusBadRequest, "name required")
	})
	t.Run("happy private", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.CreateChannel, http.MethodPost, "/",
			`{"name":"growth-priv","description":"d","private":true}`, "", nil)
		hwsCovWant(t, rec, http.StatusOK, `"slug":"growth-priv"`)
		if n := len(env.runs.events); n == 0 || env.runs.events[n-1].Type != "workspace.channel_created" {
			t.Fatalf("expected workspace.channel_created audit event, got %+v", env.runs.events)
		}
	})
	t.Run("name conflict", func(t *testing.T) {
		env := newHwsCovEnv(t)
		env.chans.channels["dup"] = &model.Channel{ID: "dup", Name: "growth", Slug: "growth", Type: model.ChannelTypePublic}
		rec := env.do(t, env.h.CreateChannel, http.MethodPost, "/", `{"name":"growth"}`, "", nil)
		hwsCovWant(t, rec, http.StatusConflict, "already exists")
	})
	t.Run("service rejects", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.CreateChannel, http.MethodPost, "/", `{"name":"Bad Name!"}`, "", nil)
		hwsCovWant(t, rec, http.StatusForbidden, "forbidden")
	})
}

func TestHwsCovJoinChannel(t *testing.T) {
	t.Run("join rejected", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.JoinChannel, http.MethodPost, "/", "", "hws-ghost-chan", nil)
		hwsCovWant(t, rec, http.StatusForbidden, "forbidden")
	})
	t.Run("happy", func(t *testing.T) {
		env := newHwsCovEnv(t)
		env.chans.channels["hws-pub"] = &model.Channel{
			ID: "hws-pub", Name: "pub", Slug: "hws-pub", Type: model.ChannelTypePublic,
		}
		rec := env.do(t, env.h.JoinChannel, http.MethodPost, "/", "", "hws-pub", nil)
		hwsCovWant(t, rec, http.StatusOK, `"ok":true`)
	})
}

func TestHwsCovReadChannel(t *testing.T) {
	t.Run("window error", func(t *testing.T) {
		env := newHwsCovEnv(t)
		env.orchMsgs.listErr = errors.New("boom")
		rec := env.do(t, env.h.ReadChannel, http.MethodGet, "/", "", "hws-home", nil)
		hwsCovWant(t, rec, http.StatusForbidden, "cannot read this channel")
	})
	t.Run("happy with clamp", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.ReadChannel, http.MethodGet, "/?limit=99", "", "hws-home", nil)
		hwsCovWant(t, rec, http.StatusOK, `"text"`)
	})
}

func TestHwsCovPostToChannel(t *testing.T) {
	t.Run("bad body", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.PostToChannel, http.MethodPost, "/", `{"body":"  "}`, "hws-home", nil)
		hwsCovWant(t, rec, http.StatusBadRequest, "body required")
	})
	t.Run("notify-only watcher", func(t *testing.T) {
		env := newHwsCovEnv(t)
		env.run.ActionMode = model.WatchActionNotify
		rec := env.do(t, env.h.PostToChannel, http.MethodPost, "/", `{"body":"hi"}`, "hws-home", nil)
		hwsCovWant(t, rec, http.StatusForbidden, "notify_only")
	})
	t.Run("reply mode approval check fails", func(t *testing.T) {
		env := newHwsCovEnv(t)
		env.run.ActionMode = model.WatchActionReply
		env.runs.apprErr = errors.New("boom")
		rec := env.do(t, env.h.PostToChannel, http.MethodPost, "/", `{"body":"hi"}`, "hws-home", nil)
		hwsCovWant(t, rec, http.StatusInternalServerError, "approval check failed")
	})
	t.Run("reply mode unapproved", func(t *testing.T) {
		env := newHwsCovEnv(t)
		env.run.ActionMode = model.WatchActionReply
		rec := env.do(t, env.h.PostToChannel, http.MethodPost, "/", `{"body":"hi"}`, "hws-home", nil)
		hwsCovWant(t, rec, http.StatusForbidden, "approval_required")
	})
	t.Run("reply mode approved posts", func(t *testing.T) {
		env := newHwsCovEnv(t)
		env.run.ActionMode = model.WatchActionReply
		env.runs.approvals["hws-run"] = []*model.Approval{{RunID: "hws-run", State: model.ApprovalApproved}}
		rec := env.do(t, env.h.PostToChannel, http.MethodPost, "/", `{"body":"hi"}`, "hws-home", nil)
		hwsCovWant(t, rec, http.StatusOK, `"remainingPosts":4`)
	})
	t.Run("post cap", func(t *testing.T) {
		env := newHwsCovEnv(t)
		env.run.Spend.Posts = 5
		rec := env.do(t, env.h.PostToChannel, http.MethodPost, "/", `{"body":"hi"}`, "hws-home", nil)
		hwsCovWant(t, rec, http.StatusTooManyRequests, "post_cap")
	})
	t.Run("send rejected", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.PostToChannel, http.MethodPost, "/", `{"body":"hi"}`, "hws-nomember", nil)
		hwsCovWant(t, rec, http.StatusForbidden, "post rejected")
	})
	t.Run("record post fails", func(t *testing.T) {
		env := newHwsCovEnv(t)
		env.runs.updateErr = errors.New("boom")
		rec := env.do(t, env.h.PostToChannel, http.MethodPost, "/", `{"body":"hi"}`, "hws-home", nil)
		hwsCovWant(t, rec, http.StatusOK, `"remainingPosts":0`)
	})
	t.Run("happy", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.PostToChannel, http.MethodPost, "/", `{"body":"hello there"}`, "hws-home", nil)
		hwsCovWant(t, rec, http.StatusOK, `"remainingPosts":4`)
		if n := len(env.runs.events); n == 0 || env.runs.events[n-1].Type != "workspace.channel_posted" {
			t.Fatalf("expected workspace.channel_posted audit event")
		}
	})
}

func TestHwsCovSearchWorkspace(t *testing.T) {
	t.Run("missing q", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.SearchWorkspace, http.MethodGet, "/?q=%20", "", "", nil)
		hwsCovWant(t, rec, http.StatusBadRequest, "q required")
	})
	t.Run("search unavailable", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.hBare.SearchWorkspace, http.MethodGet, "/?q=hello", "", "", nil)
		hwsCovWant(t, rec, http.StatusOK, "(search is not available in this workspace)")
	})
	t.Run("access error", func(t *testing.T) {
		env := newHwsCovEnv(t)
		env.access.err = errors.New("boom")
		rec := env.do(t, env.h.SearchWorkspace, http.MethodGet, "/?q=hello", "", "", nil)
		hwsCovWant(t, rec, http.StatusInternalServerError, "access resolution failed")
	})
	t.Run("search error", func(t *testing.T) {
		env := newHwsCovEnv(t)
		env.searcher.msgErr = errors.New("boom")
		rec := env.do(t, env.h.SearchWorkspace, http.MethodGet, "/?q=hello", "", "", nil)
		hwsCovWant(t, rec, http.StatusInternalServerError, "search failed")
	})
	t.Run("happy with truncated hit", func(t *testing.T) {
		env := newHwsCovEnv(t)
		env.searcher.msgHits = []search.SearchHit{{
			ID: "h1",
			Source: map[string]any{
				"body":     strings.Repeat("b", 220) + "\ntail",
				"parentId": "hws-home",
			},
		}}
		rec := env.do(t, env.h.SearchWorkspace, http.MethodGet, "/?q=hello&limit=99", "", "", nil)
		hwsCovWant(t, rec, http.StatusOK, "[m:h1] (in hws-home)")
	})
	t.Run("no results", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.SearchWorkspace, http.MethodGet, "/?q=hello", "", "", nil)
		hwsCovWant(t, rec, http.StatusOK, "(no results)")
	})
}

func TestHwsCovReact(t *testing.T) {
	t.Run("bad body", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.React, http.MethodPost, "/", `{"messageID":"hws-m1"}`, "", nil)
		hwsCovWant(t, rec, http.StatusBadRequest, "messageID and emoji required")
	})
	t.Run("reserved emoji with explicit parent", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.React, http.MethodPost, "/",
			`{"messageID":"hws-m1","emoji":"⏳","parentID":"hws-home","parentType":"channel"}`, "", nil)
		hwsCovWant(t, rec, http.StatusBadRequest, "reserved_emoji")
	})
	t.Run("rejected with defaulted parent type", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.React, http.MethodPost, "/",
			`{"messageID":"hws-m1","emoji":"👍","parentID":"hws-nomember"}`, "", nil)
		hwsCovWant(t, rec, http.StatusForbidden, "reaction rejected")
	})
	t.Run("happy on run parent", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.React, http.MethodPost, "/",
			`{"messageID":"hws-m1","emoji":"👍"}`, "", nil)
		hwsCovWant(t, rec, http.StatusOK, `"ok":true`)
	})
}

func TestHwsCovListUsers(t *testing.T) {
	t.Run("directory unavailable", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.hBare.ListUsers, http.MethodGet, "/?q=z", "", "", nil)
		hwsCovWant(t, rec, http.StatusOK, "(directory search is not available)")
	})
	t.Run("search error", func(t *testing.T) {
		env := newHwsCovEnv(t)
		env.searcher.usersErr = errors.New("boom")
		rec := env.do(t, env.h.ListUsers, http.MethodGet, "/?q=z", "", "", nil)
		hwsCovWant(t, rec, http.StatusInternalServerError, "user search failed")
	})
	t.Run("happy", func(t *testing.T) {
		env := newHwsCovEnv(t)
		env.searcher.usersHits = []search.SearchHit{{ID: "u9", Source: map[string]any{"displayName": "Zed"}}}
		rec := env.do(t, env.h.ListUsers, http.MethodGet, "/?q=z", "", "", nil)
		hwsCovWant(t, rec, http.StatusOK, "[u:u9] Zed")
	})
	t.Run("no matches", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.ListUsers, http.MethodGet, "/?q=z", "", "", nil)
		hwsCovWant(t, rec, http.StatusOK, "(no matching users)")
	})
}

func TestHwsCovSendDM(t *testing.T) {
	t.Run("bad body", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.SendDM, http.MethodPost, "/", `{"userID":"","body":"hi"}`, "", nil)
		hwsCovWant(t, rec, http.StatusBadRequest, "userID and body required")
	})
	t.Run("notify-only watcher", func(t *testing.T) {
		env := newHwsCovEnv(t)
		env.run.ActionMode = model.WatchActionDraft
		rec := env.do(t, env.h.SendDM, http.MethodPost, "/", `{"userID":"hws-bob","body":"hi"}`, "", nil)
		hwsCovWant(t, rec, http.StatusForbidden, "notify_only")
	})
	t.Run("post cap", func(t *testing.T) {
		env := newHwsCovEnv(t)
		env.run.Spend.Posts = 5
		rec := env.do(t, env.h.SendDM, http.MethodPost, "/", `{"userID":"hws-bob","body":"hi"}`, "", nil)
		hwsCovWant(t, rec, http.StatusTooManyRequests, "post_cap")
	})
	t.Run("dm open fails", func(t *testing.T) {
		env := newHwsCovEnv(t)
		env.convs.getErr = errors.New("boom")
		rec := env.do(t, env.h.SendDM, http.MethodPost, "/", `{"userID":"hws-bob","body":"hi"}`, "", nil)
		hwsCovWant(t, rec, http.StatusBadRequest, "could not open the DM")
	})
	t.Run("send rejected", func(t *testing.T) {
		env := newHwsCovEnv(t)
		long := strings.Repeat("a", 16385)
		rec := env.do(t, env.h.SendDM, http.MethodPost, "/", `{"userID":"hws-bob","body":"`+long+`"}`, "", nil)
		hwsCovWant(t, rec, http.StatusForbidden, "DM rejected")
	})
	t.Run("record post fails", func(t *testing.T) {
		env := newHwsCovEnv(t)
		env.runs.updateErr = errors.New("boom")
		rec := env.do(t, env.h.SendDM, http.MethodPost, "/", `{"userID":"hws-bob","body":"hi"}`, "", nil)
		hwsCovWant(t, rec, http.StatusOK, `"remainingPosts":0`)
	})
	t.Run("happy", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.SendDM, http.MethodPost, "/", `{"userID":"hws-bob","body":"hi bob"}`, "", nil)
		hwsCovWant(t, rec, http.StatusOK, `"remainingPosts":4`)
		if n := len(env.runs.events); n == 0 || env.runs.events[n-1].Type != "workspace.dm_sent" {
			t.Fatalf("expected workspace.dm_sent audit event")
		}
	})
}

func TestHwsCovSetReminder(t *testing.T) {
	t.Run("reminders unavailable", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.hBare.SetReminder, http.MethodPost, "/", `{"in_minutes":5}`, "", nil)
		hwsCovWant(t, rec, http.StatusNotFound, "reminders not available")
	})
	t.Run("invalid body", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.SetReminder, http.MethodPost, "/", `{"remind_at":5}`, "", nil)
		hwsCovWant(t, rec, http.StatusBadRequest, "invalid body")
	})
	t.Run("bad remind_at", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.SetReminder, http.MethodPost, "/", `{"remind_at":"soonish"}`, "", nil)
		hwsCovWant(t, rec, http.StatusBadRequest, "must be RFC3339")
	})
	t.Run("neither given", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.SetReminder, http.MethodPost, "/", `{}`, "", nil)
		hwsCovWant(t, rec, http.StatusBadRequest, "provide remind_at")
	})
	t.Run("schedule fails", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.SetReminder, http.MethodPost, "/",
			`{"message_id":"m9","remind_at":"2020-01-01T00:00:00Z"}`, "", nil)
		hwsCovWant(t, rec, http.StatusBadRequest, "reminder_error")
	})
	t.Run("happy remind_at", func(t *testing.T) {
		env := newHwsCovEnv(t)
		at := time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339)
		rec := env.do(t, env.h.SetReminder, http.MethodPost, "/",
			`{"message_id":"m9","remind_at":"`+at+`"}`, "", nil)
		hwsCovWant(t, rec, http.StatusOK, "Reminder set for")
		if len(env.remStore.scheduled) != 1 || env.remStore.scheduled[0].MessageID != "m9" {
			t.Fatalf("scheduled = %+v, want anchored to m9", env.remStore.scheduled)
		}
	})
	t.Run("happy in_minutes with fallback anchor", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.SetReminder, http.MethodPost, "/", `{"in_minutes":10}`, "", nil)
		hwsCovWant(t, rec, http.StatusOK, "Reminder set for")
		if len(env.remStore.scheduled) != 1 || env.remStore.scheduled[0].MessageID != "hws-m1" {
			t.Fatalf("scheduled = %+v, want anchored to the run message", env.remStore.scheduled)
		}
	})
}

func TestHwsCovListReminders(t *testing.T) {
	t.Run("reminders unavailable", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.hBare.ListReminders, http.MethodGet, "/", "", "", nil)
		hwsCovWant(t, rec, http.StatusNotFound, "reminders not available")
	})
	t.Run("list error", func(t *testing.T) {
		env := newHwsCovEnv(t)
		env.remStore.listErr = errors.New("boom")
		rec := env.do(t, env.h.ListReminders, http.MethodGet, "/", "", "", nil)
		hwsCovWant(t, rec, http.StatusInternalServerError, "reminder list failed")
	})
	t.Run("happy", func(t *testing.T) {
		env := newHwsCovEnv(t)
		env.remStore.rems = []*model.Reminder{{
			ID: "r1", RemindAt: time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC), MessagePreview: "pv",
		}}
		rec := env.do(t, env.h.ListReminders, http.MethodGet, "/", "", "", nil)
		hwsCovWant(t, rec, http.StatusOK, "[rem:r1]")
	})
	t.Run("empty", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.ListReminders, http.MethodGet, "/", "", "", nil)
		hwsCovWant(t, rec, http.StatusOK, "(no pending reminders)")
	})
}

func TestHwsCovCancelReminder(t *testing.T) {
	t.Run("reminders unavailable", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.hBare.CancelReminder, http.MethodDelete, "/", "", "r1", nil)
		hwsCovWant(t, rec, http.StatusNotFound, "reminders not available")
	})
	t.Run("not found", func(t *testing.T) {
		env := newHwsCovEnv(t)
		env.remStore.cancelOK = false
		rec := env.do(t, env.h.CancelReminder, http.MethodDelete, "/", "", "r1", nil)
		hwsCovWant(t, rec, http.StatusNotFound, "no such pending reminder")
	})
	t.Run("happy", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.CancelReminder, http.MethodDelete, "/", "", "r1", nil)
		hwsCovWant(t, rec, http.StatusOK, "Reminder canceled.")
	})
}

func TestHwsCovPinMessage(t *testing.T) {
	t.Run("bad body", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.PinMessage, http.MethodPost, "/", `{"message_id":""}`, "", nil)
		hwsCovWant(t, rec, http.StatusBadRequest, "message_id required")
	})
	t.Run("pin rejected", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.PinMessage, http.MethodPost, "/", `{"message_id":"hws-ghost-msg"}`, "", nil)
		hwsCovWant(t, rec, http.StatusForbidden, "pin rejected")
	})
	t.Run("happy pin", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.PinMessage, http.MethodPost, "/", `{"message_id":"hws-m1"}`, "", nil)
		hwsCovWant(t, rec, http.StatusOK, "Pinned the message.")
	})
	t.Run("happy unpin", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.PinMessage, http.MethodPost, "/", `{"message_id":"hws-m1","pinned":false}`, "", nil)
		hwsCovWant(t, rec, http.StatusOK, "Unpinned the message.")
	})
}

func TestHwsCovNotifyOwner(t *testing.T) {
	t.Run("notify unavailable", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.hBare.NotifyOwner, http.MethodPost, "/", `{"body":"hi"}`, "", nil)
		hwsCovWant(t, rec, http.StatusNotFound, "notify not available")
	})
	t.Run("bad body", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.NotifyOwner, http.MethodPost, "/", `{"body":" "}`, "", nil)
		hwsCovWant(t, rec, http.StatusBadRequest, "body required")
	})
	t.Run("owner dm open fails", func(t *testing.T) {
		env := newHwsCovEnv(t)
		env.convs.getErr = errors.New("boom")
		rec := env.do(t, env.h.NotifyOwner, http.MethodPost, "/", `{"body":"hi"}`, "", nil)
		hwsCovWant(t, rec, http.StatusInternalServerError, "could not open the owner DM")
	})
	t.Run("send rejected", func(t *testing.T) {
		env := newHwsCovEnv(t)
		long := strings.Repeat("a", 16385)
		rec := env.do(t, env.h.NotifyOwner, http.MethodPost, "/", `{"body":"`+long+`"}`, "", nil)
		hwsCovWant(t, rec, http.StatusForbidden, "notify rejected")
	})
	t.Run("happy", func(t *testing.T) {
		env := newHwsCovEnv(t)
		rec := env.do(t, env.h.NotifyOwner, http.MethodPost, "/", `{"body":"done!"}`, "", nil)
		hwsCovWant(t, rec, http.StatusOK, "Notified your creator via DM.")
		if n := len(env.runs.events); n == 0 || env.runs.events[n-1].Type != "workspace.owner_notified" {
			t.Fatalf("expected workspace.owner_notified audit event")
		}
	})
}
