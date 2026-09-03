package handler

// Coverage tests for codingtask.go and context.go. All identifiers are
// prefixed htaskCov to avoid colliding with other test files.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// ------------------------------------------------------------------ shared

func htaskCovDecode(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode response: %v (body %q)", err, rec.Body.String())
	}
	return out
}

func htaskCovErrCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	out := htaskCovDecode(t, rec)
	e, _ := out["error"].(map[string]any)
	code, _ := e["code"].(string)
	return code
}

func htaskCovReq(method, url, body, userID, runID string) *http.Request {
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, url, nil)
	} else {
		req = httptest.NewRequest(method, url, strings.NewReader(body))
	}
	return req.WithContext(middleware.ContextWithClaims(req.Context(), &model.TokenClaims{UserID: userID, RunID: runID}))
}

// ------------------------------------------------------------ context fakes

type htaskCovCtxStore struct {
	items   map[string]*model.ContextItem // parentType#parentID#itemID
	listErr error
	putErr  error
}

func newHtaskCovCtxStore() *htaskCovCtxStore {
	return &htaskCovCtxStore{items: map[string]*model.ContextItem{}}
}

func (s *htaskCovCtxStore) key(pt, pid, iid string) string { return pt + "#" + pid + "#" + iid }

func (s *htaskCovCtxStore) PutContextItem(_ context.Context, it *model.ContextItem) error {
	if s.putErr != nil {
		return s.putErr
	}
	cp := *it
	s.items[s.key(it.ParentType, it.ParentID, it.ID)] = &cp
	return nil
}

func (s *htaskCovCtxStore) GetContextItem(_ context.Context, parentType, parentID, itemID string) (*model.ContextItem, error) {
	it, ok := s.items[s.key(parentType, parentID, itemID)]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *it
	return &cp, nil
}

func (s *htaskCovCtxStore) ListContextItems(_ context.Context, parentType, parentID string) ([]*model.ContextItem, error) {
	if s.listErr != nil {
		return nil, s.listErr
	}
	var out []*model.ContextItem
	for k, it := range s.items {
		if strings.HasPrefix(k, parentType+"#"+parentID+"#") {
			cp := *it
			out = append(out, &cp)
		}
	}
	return out, nil
}

func (s *htaskCovCtxStore) DeleteContextItem(_ context.Context, parentType, parentID, itemID string) error {
	delete(s.items, s.key(parentType, parentID, itemID))
	return nil
}

type htaskCovAccess struct{ err error }

func (a *htaskCovAccess) CheckAccess(context.Context, string, string, string) error { return a.err }

type htaskCovCtxFixture struct {
	h      *ContextHandler
	store  *htaskCovCtxStore
	access *htaskCovAccess
}

func newHtaskCovCtxFixture() *htaskCovCtxFixture {
	st := newHtaskCovCtxStore()
	acc := &htaskCovAccess{}
	return &htaskCovCtxFixture{h: NewContextHandler(service.NewContextService(st, acc)), store: st, access: acc}
}

func htaskCovCtxReq(method, body, userID, parentType, parentID, itemID string) *http.Request {
	req := htaskCovReq(method, "/api/v1/context/"+parentType+"/"+parentID, body, userID, "")
	req.SetPathValue("parentType", parentType)
	req.SetPathValue("parentID", parentID)
	if itemID != "" {
		req.SetPathValue("itemID", itemID)
	}
	return req
}

// ------------------------------------------------------------ context tests

func TestHtaskCovContextList(t *testing.T) {
	fx := newHtaskCovCtxFixture()
	seed := &model.ContextItem{ID: "it1", ParentID: "chan1", ParentType: "channel", AuthorID: "u1", Body: "fact"}
	if err := fx.store.PutContextItem(context.Background(), seed); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	fx.h.List(rec, htaskCovCtxReq(http.MethodGet, "", "u1", "channel", "chan1", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("list = %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	out := htaskCovDecode(t, rec)
	items, _ := out["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("items = %v, want 1 item", out["items"])
	}

	// Access error → forbidden arm of writeContextError.
	fx.access.err = service.ErrForbidden
	rec = httptest.NewRecorder()
	fx.h.List(rec, htaskCovCtxReq(http.MethodGet, "", "u1", "channel", "chan1", ""))
	if rec.Code != http.StatusForbidden || htaskCovErrCode(t, rec) != "forbidden" {
		t.Fatalf("forbidden list = %d %s", rec.Code, rec.Body.String())
	}
	fx.access.err = nil

	// Store error → default arm (500).
	fx.store.listErr = errors.New("dynamo down")
	rec = httptest.NewRecorder()
	fx.h.List(rec, htaskCovCtxReq(http.MethodGet, "", "u1", "channel", "chan1", ""))
	if rec.Code != http.StatusInternalServerError || htaskCovErrCode(t, rec) != "internal" {
		t.Fatalf("failing list = %d %s", rec.Code, rec.Body.String())
	}
}

func TestHtaskCovContextCreate(t *testing.T) {
	fx := newHtaskCovCtxFixture()

	// Malformed body.
	rec := httptest.NewRecorder()
	fx.h.Create(rec, htaskCovCtxReq(http.MethodPost, "{not json", "u1", "channel", "chan1", ""))
	if rec.Code != http.StatusBadRequest || htaskCovErrCode(t, rec) != "bad_request" {
		t.Fatalf("bad body = %d %s", rec.Code, rec.Body.String())
	}

	// Validation error from the service (empty body text).
	rec = httptest.NewRecorder()
	fx.h.Create(rec, htaskCovCtxReq(http.MethodPost, `{"body":"   "}`, "u1", "channel", "chan1", ""))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty body = %d, want 400", rec.Code)
	}

	// Happy path.
	rec = httptest.NewRecorder()
	fx.h.Create(rec, htaskCovCtxReq(http.MethodPost, `{"body":"decision: ship it","pinned":true}`, "u1", "channel", "chan1", ""))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d (%s)", rec.Code, rec.Body.String())
	}
	out := htaskCovDecode(t, rec)
	item, _ := out["item"].(map[string]any)
	if item["body"] != "decision: ship it" || item["pinned"] != true || item["authorID"] != "u1" {
		t.Fatalf("created item wrong: %v", item)
	}

	// Full parent → context_full arm.
	for i := 0; i < model.ContextItemsPerScope; i++ {
		it := &model.ContextItem{ID: fmt.Sprintf("full-%d", i), ParentID: "chan-full", ParentType: "channel", AuthorID: "u1", Body: "x"}
		if err := fx.store.PutContextItem(context.Background(), it); err != nil {
			t.Fatal(err)
		}
	}
	rec = httptest.NewRecorder()
	fx.h.Create(rec, htaskCovCtxReq(http.MethodPost, `{"body":"one more"}`, "u1", "channel", "chan-full", ""))
	if rec.Code != http.StatusConflict || htaskCovErrCode(t, rec) != "context_full" {
		t.Fatalf("full parent = %d %s", rec.Code, rec.Body.String())
	}
}

func TestHtaskCovContextSetPinned(t *testing.T) {
	fx := newHtaskCovCtxFixture()
	seed := &model.ContextItem{ID: "it1", ParentID: "chan1", ParentType: "channel", AuthorID: "u1", Body: "fact"}
	if err := fx.store.PutContextItem(context.Background(), seed); err != nil {
		t.Fatal(err)
	}

	// Malformed body.
	rec := httptest.NewRecorder()
	fx.h.SetPinned(rec, htaskCovCtxReq(http.MethodPatch, "{oops", "u1", "channel", "chan1", "it1"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad body = %d", rec.Code)
	}

	// Missing item → not_found arm.
	rec = httptest.NewRecorder()
	fx.h.SetPinned(rec, htaskCovCtxReq(http.MethodPatch, `{"pinned":true}`, "u1", "channel", "chan1", "nope"))
	if rec.Code != http.StatusNotFound || htaskCovErrCode(t, rec) != "not_found" {
		t.Fatalf("missing item = %d %s", rec.Code, rec.Body.String())
	}

	// Happy path.
	rec = httptest.NewRecorder()
	fx.h.SetPinned(rec, htaskCovCtxReq(http.MethodPatch, `{"pinned":true}`, "u1", "channel", "chan1", "it1"))
	if rec.Code != http.StatusOK {
		t.Fatalf("pin = %d (%s)", rec.Code, rec.Body.String())
	}
	out := htaskCovDecode(t, rec)
	item, _ := out["item"].(map[string]any)
	if item["pinned"] != true {
		t.Fatalf("item not pinned: %v", item)
	}
}

func TestHtaskCovContextDelete(t *testing.T) {
	fx := newHtaskCovCtxFixture()
	mine := &model.ContextItem{ID: "mine", ParentID: "chan1", ParentType: "channel", AuthorID: "u1", Body: "a"}
	other := &model.ContextItem{ID: "other", ParentID: "chan1", ParentType: "channel", AuthorID: "u2", Body: "b"}
	for _, it := range []*model.ContextItem{mine, other} {
		if err := fx.store.PutContextItem(context.Background(), it); err != nil {
			t.Fatal(err)
		}
	}

	// Another human's item → forbidden.
	rec := httptest.NewRecorder()
	fx.h.Delete(rec, htaskCovCtxReq(http.MethodDelete, "", "u1", "channel", "chan1", "other"))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("delete other's item = %d, want 403", rec.Code)
	}

	// Own item → ok.
	rec = httptest.NewRecorder()
	fx.h.Delete(rec, htaskCovCtxReq(http.MethodDelete, "", "u1", "channel", "chan1", "mine"))
	if rec.Code != http.StatusOK {
		t.Fatalf("delete = %d (%s)", rec.Code, rec.Body.String())
	}
	if out := htaskCovDecode(t, rec); out["ok"] != true {
		t.Fatalf("delete body = %v", out)
	}
}

// --------------------------------------------------------- writeTaskError

func TestHtaskCovWriteTaskError(t *testing.T) {
	cases := []struct {
		err    error
		status int
		code   string
	}{
		{store.ErrNotFound, http.StatusNotFound, "not_found"},
		{service.ErrRunClosed, http.StatusConflict, "run_closed"},
		{service.ErrTaskActive, http.StatusConflict, "task_active"},
		{service.ErrProjectUnknown, http.StatusConflict, "project_unknown"},
		{service.ErrTaskTransition, http.StatusConflict, "bad_transition"},
		{store.ErrStaleTask, http.StatusConflict, "bad_transition"},
		{service.ErrTaskNotReady, http.StatusConflict, "not_ready"},
		{service.ErrNotRequester, http.StatusForbidden, "forbidden"},
		{service.ErrTaskAgent, http.StatusServiceUnavailable, "no_dev_agent"},
		{service.ErrForbidden, http.StatusForbidden, "forbidden"},
		{service.ErrNotTaskRun, http.StatusBadRequest, "not_task_run"},
		{service.ErrValidation, http.StatusBadRequest, "bad_request"},
		{errors.New("boom"), http.StatusInternalServerError, "internal"},
	}
	for _, tc := range cases {
		rec := httptest.NewRecorder()
		writeTaskError(rec, tc.err)
		if rec.Code != tc.status {
			t.Fatalf("writeTaskError(%v) = %d, want %d", tc.err, rec.Code, tc.status)
		}
		if got := htaskCovErrCode(t, rec); got != tc.code {
			t.Fatalf("writeTaskError(%v) code = %q, want %q", tc.err, got, tc.code)
		}
	}
}

// ------------------------------------------------------------- MR helpers

func TestHtaskCovMRHelpers(t *testing.T) {
	// mrBodyFallback: first paragraph only.
	task := &model.CodingTask{Goal: "First paragraph.\n\nSecond paragraph."}
	if got := mrBodyFallback(task); got != "First paragraph." {
		t.Fatalf("mrBodyFallback = %q", got)
	}
	// mrBodyFallback: 600-rune clip.
	long := &model.CodingTask{Goal: strings.Repeat("å", 700)}
	if got := mrBodyFallback(long); len([]rune(got)) != 601 || !strings.HasSuffix(got, "…") {
		t.Fatalf("mrBodyFallback long = %d runes", len([]rune(got)))
	}
	// Short goal untouched.
	if got := mrBodyFallback(&model.CodingTask{Goal: " fix it "}); got != "fix it" {
		t.Fatalf("mrBodyFallback short = %q", got)
	}

	// mrFooter: no URL, no ticket.
	plain := &model.CodingTask{}
	if got := mrFooter(plain, ""); got != "_🛠️ Written with the Ex coding agent (dev)_" {
		t.Fatalf("mrFooter plain = %q", got)
	}
	// Localhost URLs are suppressed.
	if got := mrFooter(plain, "http://localhost:8080/channel/c#msg-1"); strings.Contains(got, "task thread") {
		t.Fatalf("mrFooter localhost leaked: %q", got)
	}
	if got := mrFooter(plain, "http://127.0.0.1:8080/x"); strings.Contains(got, "task thread") {
		t.Fatalf("mrFooter loopback leaked: %q", got)
	}
	// Public URL + ticket with link.
	linked := &model.CodingTask{Ticket: &model.TaskTicket{ID: "CS-7", URL: "https://tick/7"}}
	got := mrFooter(linked, "https://ex.example/channel/c#msg-1")
	if !strings.Contains(got, "[task thread](https://ex.example/channel/c#msg-1)") || !strings.Contains(got, "[CS-7](https://tick/7)") {
		t.Fatalf("mrFooter linked = %q", got)
	}
	// Ticket without URL.
	bare := &model.CodingTask{Ticket: &model.TaskTicket{ID: "CS-9"}}
	if got := mrFooter(bare, ""); !strings.Contains(got, "Ticket CS-9") || strings.Contains(got, "](") {
		t.Fatalf("mrFooter bare ticket = %q", got)
	}

	// mrDescription = fallback + footer.
	desc := mrDescription(&model.CodingTask{Goal: "Fix the crash."}, "")
	if !strings.HasPrefix(desc, "Fix the crash.") || !strings.Contains(desc, "\n\n---\n_🛠️") {
		t.Fatalf("mrDescription = %q", desc)
	}
}

// -------------------------------------------------------- task-layer fakes

var htaskCovDevID = service.AgentUserID(service.AgentSlugDev)

type htaskCovRunStore struct {
	runs   map[string]*model.Run
	getErr map[string]error
}

func newHtaskCovRunStore() *htaskCovRunStore {
	return &htaskCovRunStore{runs: map[string]*model.Run{}, getErr: map[string]error{}}
}

func (f *htaskCovRunStore) CreateRun(_ context.Context, run *model.Run) error {
	cp := *run
	f.runs[run.ID] = &cp
	return nil
}

func (f *htaskCovRunStore) GetRun(_ context.Context, runID string) (*model.Run, error) {
	if err, ok := f.getErr[runID]; ok {
		return nil, err
	}
	run, ok := f.runs[runID]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *run
	return &cp, nil
}

func (f *htaskCovRunStore) UpdateRun(_ context.Context, run *model.Run, _ model.RunState) error {
	if _, ok := f.runs[run.ID]; !ok {
		return store.ErrNotFound
	}
	cp := *run
	f.runs[run.ID] = &cp
	return nil
}

func (f *htaskCovRunStore) RenewRunLease(context.Context, string, string, time.Time) error { return nil }
func (f *htaskCovRunStore) ListQueuedRuns(context.Context, string, int) ([]string, error) {
	return nil, nil
}
func (f *htaskCovRunStore) ClaimRun(context.Context, *model.Run, string, time.Time) error { return nil }
func (f *htaskCovRunStore) DeleteQueueEntry(context.Context, string, string) error        { return nil }
func (f *htaskCovRunStore) ListActiveRunsPastDeadline(context.Context, time.Time, int) ([]*model.Run, error) {
	return nil, nil
}
func (f *htaskCovRunStore) ListActiveRuns(context.Context) ([]*model.Run, error) { return nil, nil }
func (f *htaskCovRunStore) AppendRunEvent(context.Context, *model.RunEvent) error {
	return nil
}
func (f *htaskCovRunStore) ListRunEvents(context.Context, string) ([]*model.RunEvent, error) {
	return nil, nil
}
func (f *htaskCovRunStore) DeleteRunEvents(context.Context, string) error { return nil }
func (f *htaskCovRunStore) PutDigest(context.Context, *model.RunDigest) error {
	return nil
}
func (f *htaskCovRunStore) GetDigest(context.Context, string) (*model.RunDigest, error) {
	return nil, store.ErrNotFound
}
func (f *htaskCovRunStore) ListRunsByParent(context.Context, string, int) ([]*model.Run, error) {
	return nil, nil
}
func (f *htaskCovRunStore) PutApproval(context.Context, *model.Approval) error { return nil }
func (f *htaskCovRunStore) GetApproval(context.Context, string, string) (*model.Approval, error) {
	return nil, store.ErrNotFound
}
func (f *htaskCovRunStore) SettleApproval(context.Context, string, string, string, string, string, string, time.Time) error {
	return nil
}
func (f *htaskCovRunStore) ListApprovals(context.Context, string) ([]*model.Approval, error) {
	return nil, nil
}
func (f *htaskCovRunStore) PutArtifact(context.Context, *model.Artifact) error { return nil }
func (f *htaskCovRunStore) ListArtifacts(context.Context, string) ([]*model.Artifact, error) {
	return nil, nil
}

type htaskCovAgentDir struct {
	templates map[string]*model.AgentTemplate
	runners   map[string][]*model.RunnerRegistration
}

func newHtaskCovAgentDir() *htaskCovAgentDir {
	return &htaskCovAgentDir{templates: map[string]*model.AgentTemplate{}, runners: map[string][]*model.RunnerRegistration{}}
}

func (f *htaskCovAgentDir) PutTemplate(_ context.Context, tpl *model.AgentTemplate) error {
	cp := *tpl
	f.templates[tpl.Slug] = &cp
	return nil
}

func (f *htaskCovAgentDir) CreateTemplateIfAbsent(ctx context.Context, tpl *model.AgentTemplate) error {
	if _, ok := f.templates[tpl.Slug]; ok {
		return store.ErrAlreadyExists
	}
	return f.PutTemplate(ctx, tpl)
}

func (f *htaskCovAgentDir) GetTemplate(_ context.Context, slug string) (*model.AgentTemplate, error) {
	tpl, ok := f.templates[slug]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *tpl
	return &cp, nil
}

func (f *htaskCovAgentDir) ListTemplates(context.Context) ([]*model.AgentTemplate, error) {
	return nil, nil
}
func (f *htaskCovAgentDir) CreateAgentUser(context.Context, *model.User) error { return nil }
func (f *htaskCovAgentDir) PutAgentPrefs(context.Context, *model.UserAgentPrefs) error {
	return nil
}
func (f *htaskCovAgentDir) GetAgentPrefs(context.Context, string, string) (*model.UserAgentPrefs, error) {
	return nil, store.ErrNotFound
}

func (f *htaskCovAgentDir) PutRunner(_ context.Context, reg *model.RunnerRegistration) error {
	cp := *reg
	f.runners[reg.OwnerID] = append(f.runners[reg.OwnerID], &cp)
	return nil
}

func (f *htaskCovAgentDir) ListRunners(_ context.Context, ownerID string) ([]*model.RunnerRegistration, error) {
	return append([]*model.RunnerRegistration(nil), f.runners[ownerID]...), nil
}

func (f *htaskCovAgentDir) DeleteRunner(context.Context, string, string) error { return nil }
func (f *htaskCovAgentDir) PutSkill(context.Context, *model.Skill) error       { return nil }
func (f *htaskCovAgentDir) GetSkill(context.Context, string) (*model.Skill, error) {
	return nil, store.ErrNotFound
}
func (f *htaskCovAgentDir) ListSkills(context.Context) ([]*model.Skill, error) { return nil, nil }
func (f *htaskCovAgentDir) DeleteSkill(context.Context, string) error          { return nil }
func (f *htaskCovAgentDir) PutAgentMemory(context.Context, *model.AgentMemory) error {
	return nil
}
func (f *htaskCovAgentDir) GetAgentMemory(context.Context, string, string) (*model.AgentMemory, error) {
	return nil, store.ErrNotFound
}
func (f *htaskCovAgentDir) PutAgentSubscription(context.Context, *model.AgentSubscription) error {
	return nil
}
func (f *htaskCovAgentDir) ListSubscriptionsByParent(context.Context, string) ([]*model.AgentSubscription, error) {
	return nil, nil
}
func (f *htaskCovAgentDir) ListAllSubscriptions(context.Context) ([]*model.AgentSubscription, error) {
	return nil, nil
}
func (f *htaskCovAgentDir) DeleteAgentSubscription(context.Context, string, string) error {
	return nil
}
func (f *htaskCovAgentDir) PutTaskClaim(context.Context, *model.TaskClaim) error { return nil }
func (f *htaskCovAgentDir) ListTaskClaims(context.Context, string, string) ([]*model.TaskClaim, error) {
	return nil, nil
}
func (f *htaskCovAgentDir) PutAgentFollow(context.Context, *model.AgentThreadFollow) error {
	return nil
}
func (f *htaskCovAgentDir) ListAgentFollows(context.Context, string, string) ([]*model.AgentThreadFollow, error) {
	return nil, nil
}

type htaskCovUsers struct{ users map[string]*model.User }

func (f *htaskCovUsers) GetUser(_ context.Context, id string) (*model.User, error) {
	u, ok := f.users[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *u
	return &cp, nil
}

func (f *htaskCovUsers) UpdateUser(_ context.Context, u *model.User) error {
	cp := *u
	f.users[u.ID] = &cp
	return nil
}

func (f *htaskCovUsers) GetUsersByIDs(_ context.Context, ids []string) ([]*model.User, error) {
	var out []*model.User
	for _, id := range ids {
		if u, ok := f.users[id]; ok {
			cp := *u
			out = append(out, &cp)
		}
	}
	return out, nil
}

// htaskCovMessages serves as both the orchestrator's and the task service's
// message surface.
type htaskCovMessages struct {
	seq       int
	posts     []*model.Message
	accessErr error
}

func (f *htaskCovMessages) SendAsAgentRun(_ context.Context, agentID, _, parentID, parentType, body, parentMessageID, runID string) (*model.Message, error) {
	f.seq++
	m := &model.Message{
		ID: fmt.Sprintf("htaskcov-msg-%d", f.seq), ParentID: parentID, ParentType: parentType,
		AuthorID: agentID, Body: body, ParentMessageID: parentMessageID, AgentRunID: runID,
	}
	f.posts = append(f.posts, m)
	return m, nil
}

func (f *htaskCovMessages) RewriteAgentMessage(_ context.Context, _, _, _, msgID, body string) (*model.Message, error) {
	return &model.Message{ID: msgID, Body: body}, nil
}

func (f *htaskCovMessages) SetPinned(_ context.Context, _, _, _, msgID string, pinned bool) (*model.Message, error) {
	return &model.Message{ID: msgID, Pinned: pinned}, nil
}

func (f *htaskCovMessages) CheckAccess(context.Context, string, string, string) error {
	return f.accessErr
}

func (f *htaskCovMessages) SetMachineReaction(context.Context, string, string, string, string, string) error {
	return nil
}

func (f *htaskCovMessages) ListThreadMessages(context.Context, string, string, string, string) ([]*model.Message, error) {
	return nil, nil
}

func (f *htaskCovMessages) List(context.Context, string, string, string, string, int) ([]*model.Message, bool, error) {
	return nil, false, nil
}

type htaskCovChannels struct {
	channels map[string]*model.Channel
	members  map[string]map[string]bool
}

func newHtaskCovChannels() *htaskCovChannels {
	return &htaskCovChannels{channels: map[string]*model.Channel{}, members: map[string]map[string]bool{}}
}

func (f *htaskCovChannels) GetByID(_ context.Context, id string) (*model.Channel, error) {
	ch, ok := f.channels[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	return ch, nil
}

func (f *htaskCovChannels) GetBySlug(_ context.Context, slug string) (*model.Channel, error) {
	for _, ch := range f.channels {
		if ch.Slug == slug {
			return ch, nil
		}
	}
	return nil, store.ErrNotFound
}

func (f *htaskCovChannels) CreateWithID(_ context.Context, userID, id, name string, chanType model.ChannelType, description string) (*model.Channel, error) {
	ch := &model.Channel{ID: id, Name: name, Slug: name, Type: chanType, Description: description, CreatedBy: userID}
	f.channels[id] = ch
	f.members[id] = map[string]bool{userID: true}
	return ch, nil
}

func (f *htaskCovChannels) AutoJoinChannel(_ context.Context, userID, channelID string, _ model.ChannelRole) error {
	if _, ok := f.channels[channelID]; !ok {
		return store.ErrNotFound
	}
	f.members[channelID][userID] = true
	return nil
}

func (f *htaskCovChannels) IsMember(_ context.Context, userID, channelID string) bool {
	return f.members[channelID][userID]
}

type htaskCovTaskStore struct {
	tasks           map[string]*model.CodingTask
	projects        map[string]*model.CodingProject
	listProjectsErr error
}

func newHtaskCovTaskStore() *htaskCovTaskStore {
	return &htaskCovTaskStore{tasks: map[string]*model.CodingTask{}, projects: map[string]*model.CodingProject{}}
}

func (f *htaskCovTaskStore) CreateTask(_ context.Context, t *model.CodingTask) error {
	cp := *t
	f.tasks[t.ID] = &cp
	return nil
}

func (f *htaskCovTaskStore) GetTask(_ context.Context, id string) (*model.CodingTask, error) {
	t, ok := f.tasks[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *t
	cp.Repos = append([]model.TaskRepo(nil), t.Repos...)
	return &cp, nil
}

func (f *htaskCovTaskStore) UpdateTask(_ context.Context, t *model.CodingTask, _ model.TaskState) error {
	if _, ok := f.tasks[t.ID]; !ok {
		return store.ErrNotFound
	}
	cp := *t
	cp.Repos = append([]model.TaskRepo(nil), t.Repos...)
	f.tasks[t.ID] = &cp
	return nil
}

func (f *htaskCovTaskStore) ListTasksByChannel(_ context.Context, channelID string) ([]*model.CodingTask, error) {
	var out []*model.CodingTask
	for _, t := range f.tasks {
		if t.ChannelID == channelID {
			cp := *t
			out = append(out, &cp)
		}
	}
	return out, nil
}

func (f *htaskCovTaskStore) GetTaskByThread(_ context.Context, threadRootID string) (*model.CodingTask, error) {
	for _, t := range f.tasks {
		if threadRootID != "" && t.ThreadRootID == threadRootID {
			cp := *t
			return &cp, nil
		}
	}
	return nil, store.ErrNotFound
}

func (f *htaskCovTaskStore) CreateProject(_ context.Context, p *model.CodingProject) error {
	cp := *p
	f.projects[p.Key] = &cp
	return nil
}

func (f *htaskCovTaskStore) UpdateProject(_ context.Context, p *model.CodingProject) error {
	cp := *p
	f.projects[p.Key] = &cp
	return nil
}

func (f *htaskCovTaskStore) GetProject(_ context.Context, key string) (*model.CodingProject, error) {
	p, ok := f.projects[key]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *p
	return &cp, nil
}

func (f *htaskCovTaskStore) ListProjects(context.Context) ([]*model.CodingProject, error) {
	if f.listProjectsErr != nil {
		return nil, f.listProjectsErr
	}
	var out []*model.CodingProject
	for _, p := range f.projects {
		cp := *p
		out = append(out, &cp)
	}
	return out, nil
}

type htaskCovPub struct{}

func (htaskCovPub) Publish(context.Context, string, *events.Event) error { return nil }

type htaskCovMinter struct{}

func (htaskCovMinter) GenerateRunToken(string, string, string, time.Time) (string, error) {
	return "htaskcov-token", nil
}

// ---------------------------------------------------------- task fixture

type htaskCovFixture struct {
	h     *CodingTaskHandler
	svc   *service.CodingTaskService
	orch  *service.Orchestrator
	tasks *htaskCovTaskStore
	chans *htaskCovChannels
	msgs  *htaskCovMessages
	users *htaskCovUsers
	runs  *htaskCovRunStore
	dir   *htaskCovAgentDir
}

func newHtaskCovFixture(t *testing.T) *htaskCovFixture {
	t.Helper()
	dir := newHtaskCovAgentDir()
	users := &htaskCovUsers{users: map[string]*model.User{
		"u-alice": {ID: "u-alice", DisplayName: "Alice"},
		"u-bob":   {ID: "u-bob", DisplayName: "Bob"},
		htaskCovDevID: {
			ID: htaskCovDevID, DisplayName: "dev", Kind: model.UserKindAgent,
			AgentConfig: &model.AgentConfig{TemplateSlug: service.AgentSlugDev},
		},
	}}
	agentSvc := service.NewAgentService(dir, users)
	if err := agentSvc.SeedDefaults(context.Background()); err != nil {
		t.Fatalf("seed agents: %v", err)
	}
	// Alice's runner is online; Bob has none (kickoff-failure cases).
	if err := dir.PutRunner(context.Background(), &model.RunnerRegistration{
		RunnerID: "r1", OwnerID: "u-alice",
		Harnesses:      []model.RunnerHarness{{Name: model.HarnessClaude}},
		LeaseExpiresAt: time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatalf("put runner: %v", err)
	}
	runs := newHtaskCovRunStore()
	msgs := &htaskCovMessages{}
	orch := service.NewOrchestrator(runs, agentSvc, users, msgs, htaskCovPub{}, htaskCovMinter{})
	tasks := newHtaskCovTaskStore()
	orch.SetTaskStore(tasks)
	chans := newHtaskCovChannels()
	svc := service.NewCodingTaskService(tasks, chans, msgs, users, agentSvc, orch)
	svc.SetBaseURL("https://ex.example")
	return &htaskCovFixture{
		h: NewCodingTaskHandler(svc, orch), svc: svc, orch: orch,
		tasks: tasks, chans: chans, msgs: msgs, users: users, runs: runs, dir: dir,
	}
}

func (fx *htaskCovFixture) seedRun(t *testing.T, id, invokerID, taskID string) *model.Run {
	t.Helper()
	now := time.Now()
	run := &model.Run{
		ID: id, AgentID: htaskCovDevID, OwnerID: invokerID, InvokerID: invokerID,
		ParentID: "chan-general", ParentType: service.ParentChannel, MessageID: "m-" + id,
		State: model.RunStateRunning, Mode: model.RunModeTask, TaskID: taskID,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := fx.runs.CreateRun(context.Background(), run); err != nil {
		t.Fatalf("seed run: %v", err)
	}
	return run
}

func (fx *htaskCovFixture) seedTask(t *testing.T, id string, state model.TaskState, repos []model.TaskRepo) *model.CodingTask {
	t.Helper()
	now := time.Now()
	task := &model.CodingTask{
		ID: id, ProjectKey: "portal", ProjectName: "Portal", Title: "Fix crash",
		Goal: "the picker throws", Kind: model.TaskKindBug, State: state,
		Steering: model.TaskSteeringRequester, ChannelID: "chan-p", ThreadRootID: "card-" + id,
		RequesterID: "u-alice", AgentID: htaskCovDevID, Repos: repos,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := fx.tasks.CreateTask(context.Background(), task); err != nil {
		t.Fatalf("seed task: %v", err)
	}
	return task
}

func htaskCovBackendRepos() []model.TaskRepo {
	return []model.TaskRepo{{Path: "dt/portal-api", Role: model.RepoRoleBackend, BaseBranch: "main", Branch: "ex/task-1-fix"}}
}

// ------------------------------------------------------------ Create tests

func TestHtaskCovCreate(t *testing.T) {
	t.Run("run lookup fails", func(t *testing.T) {
		fx := newHtaskCovFixture(t)
		rec := httptest.NewRecorder()
		fx.h.Create(rec, htaskCovReq(http.MethodPost, "/api/v1/agent/run/coding-task", `{}`, "u-alice", "missing-run"))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("create with dead run = %d, want 404", rec.Code)
		}
	})

	t.Run("malformed body", func(t *testing.T) {
		fx := newHtaskCovFixture(t)
		fx.seedRun(t, "run-1", "u-alice", "")
		rec := httptest.NewRecorder()
		fx.h.Create(rec, htaskCovReq(http.MethodPost, "/api/v1/agent/run/coding-task", `{oops`, "u-alice", "run-1"))
		if rec.Code != http.StatusBadRequest || htaskCovErrCode(t, rec) != "bad_request" {
			t.Fatalf("bad body = %d %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("service rejects input", func(t *testing.T) {
		fx := newHtaskCovFixture(t)
		fx.seedRun(t, "run-1", "u-alice", "")
		rec := httptest.NewRecorder()
		fx.h.Create(rec, htaskCovReq(http.MethodPost, "/api/v1/agent/run/coding-task", `{"project":""}`, "u-alice", "run-1"))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("empty project = %d, want 400", rec.Code)
		}
	})

	t.Run("happy path with kickoff", func(t *testing.T) {
		fx := newHtaskCovFixture(t)
		fx.seedRun(t, "run-1", "u-alice", "")
		body := `{
			"project": "Booking Portal",
			"repos": [
				{"path": "dt/booking-portal-frontend", "role": "frontend", "base_branch": "main"},
				{"path": "dt/booking-portal-api", "role": "backend"}
			],
			"title": "Fix Feb-29 crash",
			"goal": "The date picker throws on Feb 29.",
			"kind": "bug",
			"base_branch": "main",
			"ticket": {"connector": "cliffhub", "id": " CS-7 ", "url": "https://tick/7"}
		}`
		rec := httptest.NewRecorder()
		fx.h.Create(rec, htaskCovReq(http.MethodPost, "/api/v1/agent/run/coding-task", body, "u-alice", "run-1"))
		if rec.Code != http.StatusOK {
			t.Fatalf("create = %d (%s)", rec.Code, rec.Body.String())
		}
		out := htaskCovDecode(t, rec)
		if out["taskID"] == "" || out["project"] != "Booking Portal" || out["projectKey"] != "booking-portal" {
			t.Fatalf("create response wrong: %v", out)
		}
		if out["channelSlug"] != "booking-portal" || out["projectCreated"] != true || out["kickoffStarted"] != true {
			t.Fatalf("create response wrong: %v", out)
		}
		text, _ := out["text"].(string)
		if !strings.Contains(text, "Task created: 🐛 bug Fix Feb-29 crash for Booking Portal") ||
			!strings.Contains(text, "→ https://ex.example/channel/") ||
			!strings.Contains(text, "Your task run has started") {
			t.Fatalf("create text wrong: %q", text)
		}
		// The stored task carries the trimmed ticket.
		taskID, _ := out["taskID"].(string)
		stored, err := fx.tasks.GetTask(context.Background(), taskID)
		if err != nil || stored.Ticket == nil || stored.Ticket.ID != "CS-7" || stored.Ticket.Connector != "cliffhub" {
			t.Fatalf("stored ticket wrong: %+v err=%v", stored, err)
		}
	})

	t.Run("kickoff fails when requester offline", func(t *testing.T) {
		fx := newHtaskCovFixture(t)
		fx.seedRun(t, "run-b", "u-bob", "")
		body := `{
			"project": "Other Tool",
			"repos": [{"path": "dt/other-tool", "role": "backend"}],
			"title": "T", "goal": "g"
		}`
		rec := httptest.NewRecorder()
		fx.h.Create(rec, htaskCovReq(http.MethodPost, "/api/v1/agent/run/coding-task", body, "u-bob", "run-b"))
		if rec.Code != http.StatusOK {
			t.Fatalf("create = %d (%s)", rec.Code, rec.Body.String())
		}
		out := htaskCovDecode(t, rec)
		if out["kickoffStarted"] != false {
			t.Fatalf("kickoffStarted = %v, want false", out["kickoffStarted"])
		}
		text, _ := out["text"].(string)
		if !strings.Contains(text, "the first run could not start") {
			t.Fatalf("kickoff-failure text wrong: %q", text)
		}
	})
}

// ------------------------------------------------------------ Report tests

func TestHtaskCovReport(t *testing.T) {
	t.Run("run lookup fails", func(t *testing.T) {
		fx := newHtaskCovFixture(t)
		rec := httptest.NewRecorder()
		fx.h.Report(rec, htaskCovReq(http.MethodPost, "/api/v1/agent/run/coding-task/report", `{}`, "u-alice", "missing"))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("report dead run = %d", rec.Code)
		}
	})

	t.Run("malformed body", func(t *testing.T) {
		fx := newHtaskCovFixture(t)
		fx.seedRun(t, "run-1", "u-alice", "t1")
		rec := httptest.NewRecorder()
		fx.h.Report(rec, htaskCovReq(http.MethodPost, "/api/v1/agent/run/coding-task/report", `{`, "u-alice", "run-1"))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("bad body = %d", rec.Code)
		}
	})

	t.Run("run not bound to a task", func(t *testing.T) {
		fx := newHtaskCovFixture(t)
		fx.seedRun(t, "run-free", "u-alice", "")
		rec := httptest.NewRecorder()
		fx.h.Report(rec, htaskCovReq(http.MethodPost, "/api/v1/agent/run/coding-task/report", `{"state":"in_progress"}`, "u-alice", "run-free"))
		if rec.Code != http.StatusBadRequest || htaskCovErrCode(t, rec) != "not_task_run" {
			t.Fatalf("unbound run = %d %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("happy path", func(t *testing.T) {
		fx := newHtaskCovFixture(t)
		task := fx.seedTask(t, "t1", model.TaskStateCreated, htaskCovBackendRepos())
		fx.seedRun(t, "run-1", "u-alice", task.ID)
		body := `{
			"state": "in_progress",
			"note": "digging in",
			"repos": [{"path": "dt/portal-api", "branch": "ex/task-1-fix", "base_branch": "main", "workspace_dir": "/w/portal", "mr_url": "https://gl/mr/1", "changed": true}]
		}`
		rec := httptest.NewRecorder()
		fx.h.Report(rec, htaskCovReq(http.MethodPost, "/api/v1/agent/run/coding-task/report", body, "u-alice", "run-1"))
		if rec.Code != http.StatusOK {
			t.Fatalf("report = %d (%s)", rec.Code, rec.Body.String())
		}
		out := htaskCovDecode(t, rec)
		if out["state"] != "in_progress" || out["text"] != "task is now in_progress" {
			t.Fatalf("report response wrong: %v", out)
		}
	})
}

// ---------------------------------------------------------- TestPlan tests

func TestHtaskCovTestPlan(t *testing.T) {
	t.Run("run lookup fails", func(t *testing.T) {
		fx := newHtaskCovFixture(t)
		rec := httptest.NewRecorder()
		fx.h.TestPlan(rec, htaskCovReq(http.MethodPost, "/api/v1/agent/run/coding-task/test-plan", `{}`, "u-alice", "missing"))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("test-plan dead run = %d", rec.Code)
		}
	})

	t.Run("malformed body", func(t *testing.T) {
		fx := newHtaskCovFixture(t)
		fx.seedRun(t, "run-1", "u-alice", "t1")
		rec := httptest.NewRecorder()
		fx.h.TestPlan(rec, htaskCovReq(http.MethodPost, "/api/v1/agent/run/coding-task/test-plan", `[`, "u-alice", "run-1"))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("bad body = %d", rec.Code)
		}
	})

	t.Run("plan without steps refused", func(t *testing.T) {
		fx := newHtaskCovFixture(t)
		task := fx.seedTask(t, "t1", model.TaskStateInProgress, htaskCovBackendRepos())
		fx.seedRun(t, "run-1", "u-alice", task.ID)
		rec := httptest.NewRecorder()
		fx.h.TestPlan(rec, htaskCovReq(http.MethodPost, "/api/v1/agent/run/coding-task/test-plan", `{"url":"https://x"}`, "u-alice", "run-1"))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("empty plan = %d", rec.Code)
		}
	})

	t.Run("happy path", func(t *testing.T) {
		fx := newHtaskCovFixture(t)
		task := fx.seedTask(t, "t1", model.TaskStateInProgress, htaskCovBackendRepos())
		fx.seedRun(t, "run-1", "u-alice", task.ID)
		body := `{
			"url": "https://localhost:3000",
			"steps": ["Open the booking page", "Pick Feb 29"],
			"counter_steps": ["Feb 28 still books normally"],
			"accounts": "seeded admin",
			"notes": "backend only"
		}`
		rec := httptest.NewRecorder()
		fx.h.TestPlan(rec, htaskCovReq(http.MethodPost, "/api/v1/agent/run/coding-task/test-plan", body, "u-alice", "run-1"))
		if rec.Code != http.StatusOK {
			t.Fatalf("test-plan = %d (%s)", rec.Code, rec.Body.String())
		}
		out := htaskCovDecode(t, rec)
		if out["state"] != string(model.TaskStateAwaitingTest) {
			t.Fatalf("state = %v", out["state"])
		}
		if text, _ := out["text"].(string); !strings.Contains(text, "published") {
			t.Fatalf("text = %q", text)
		}
	})
}

// --------------------------------------------------------- RequestMR tests

func TestHtaskCovRequestMR(t *testing.T) {
	t.Run("run lookup fails", func(t *testing.T) {
		fx := newHtaskCovFixture(t)
		rec := httptest.NewRecorder()
		fx.h.RequestMR(rec, htaskCovReq(http.MethodPost, "/api/v1/agent/run/coding-task/request-mr", "", "u-alice", "missing"))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("request-mr dead run = %d", rec.Code)
		}
	})

	t.Run("malformed body", func(t *testing.T) {
		fx := newHtaskCovFixture(t)
		fx.seedRun(t, "run-1", "u-alice", "t1")
		rec := httptest.NewRecorder()
		fx.h.RequestMR(rec, htaskCovReq(http.MethodPost, "/api/v1/agent/run/coding-task/request-mr", `{"approvalID":`, "u-alice", "run-1"))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("bad body = %d", rec.Code)
		}
	})

	t.Run("service error", func(t *testing.T) {
		fx := newHtaskCovFixture(t)
		fx.seedRun(t, "run-free", "u-alice", "")
		rec := httptest.NewRecorder()
		fx.h.RequestMR(rec, htaskCovReq(http.MethodPost, "/api/v1/agent/run/coding-task/request-mr", "", "u-alice", "run-free"))
		if rec.Code != http.StatusBadRequest || htaskCovErrCode(t, rec) != "not_task_run" {
			t.Fatalf("unbound run = %d %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("not ready", func(t *testing.T) {
		fx := newHtaskCovFixture(t)
		task := fx.seedTask(t, "t1", model.TaskStateInProgress, htaskCovBackendRepos())
		fx.seedRun(t, "run-1", "u-alice", task.ID)
		rec := httptest.NewRecorder()
		fx.h.RequestMR(rec, htaskCovReq(http.MethodPost, "/api/v1/agent/run/coding-task/request-mr", "", "u-alice", "run-1"))
		if rec.Code != http.StatusOK {
			t.Fatalf("request-mr = %d (%s)", rec.Code, rec.Body.String())
		}
		out := htaskCovDecode(t, rec)
		if out["status"] != service.MRStatusNotReady || !strings.Contains(out["message"].(string), "not ready") {
			t.Fatalf("not-ready response wrong: %v", out)
		}
	})

	t.Run("ask for sign-off", func(t *testing.T) {
		fx := newHtaskCovFixture(t)
		task := fx.seedTask(t, "t1", model.TaskStateAwaitingTest, htaskCovBackendRepos())
		fx.seedRun(t, "run-1", "u-alice", task.ID)
		rec := httptest.NewRecorder()
		fx.h.RequestMR(rec, htaskCovReq(http.MethodPost, "/api/v1/agent/run/coding-task/request-mr", "{}", "u-alice", "run-1"))
		if rec.Code != http.StatusOK {
			t.Fatalf("request-mr = %d (%s)", rec.Code, rec.Body.String())
		}
		out := htaskCovDecode(t, rec)
		if out["status"] != service.MRStatusAsk {
			t.Fatalf("status = %v, want ask", out["status"])
		}
		if sum, _ := out["summary"].(string); !strings.Contains(sum, task.ID) {
			t.Fatalf("summary must carry the task id: %v", out["summary"])
		}
	})

	t.Run("approved after sign-off", func(t *testing.T) {
		fx := newHtaskCovFixture(t)
		task := fx.seedTask(t, "t1", model.TaskStateAwaitingTest, htaskCovBackendRepos())
		now := time.Now()
		task.SignedOffAt = &now
		task.Ticket = &model.TaskTicket{ID: "CS-7", URL: "https://tick/7"}
		if err := fx.tasks.UpdateTask(context.Background(), task, task.State); err != nil {
			t.Fatal(err)
		}
		fx.seedRun(t, "run-1", "u-alice", task.ID)
		rec := httptest.NewRecorder()
		fx.h.RequestMR(rec, htaskCovReq(http.MethodPost, "/api/v1/agent/run/coding-task/request-mr", "", "u-alice", "run-1"))
		if rec.Code != http.StatusOK {
			t.Fatalf("request-mr = %d (%s)", rec.Code, rec.Body.String())
		}
		out := htaskCovDecode(t, rec)
		if out["status"] != service.MRStatusApproved || out["mrTitle"] != "Fix crash" {
			t.Fatalf("approved response wrong: %v", out)
		}
		if desc, _ := out["mrDescription"].(string); !strings.Contains(desc, "the picker throws") || !strings.Contains(desc, "CS-7") {
			t.Fatalf("mrDescription wrong: %q", desc)
		}
		if labels, _ := out["labels"].([]any); len(labels) != 1 || labels[0] != "ex:dev" {
			t.Fatalf("labels wrong: %v", out["labels"])
		}
		if msg, _ := out["message"].(string); !strings.Contains(msg, "approved") {
			t.Fatalf("message wrong: %q", msg)
		}
	})

	t.Run("denied approval", func(t *testing.T) {
		fx := newHtaskCovFixture(t)
		task := fx.seedTask(t, "t1", model.TaskStateAwaitingTest, htaskCovBackendRepos())
		fx.seedRun(t, "run-1", "u-alice", task.ID)
		rec := httptest.NewRecorder()
		fx.h.RequestMR(rec, htaskCovReq(http.MethodPost, "/api/v1/agent/run/coding-task/request-mr", `{"approvalID":"ap-nope"}`, "u-alice", "run-1"))
		if rec.Code != http.StatusOK {
			t.Fatalf("request-mr = %d (%s)", rec.Code, rec.Body.String())
		}
		out := htaskCovDecode(t, rec)
		if out["status"] != service.MRStatusDenied || !strings.Contains(out["message"].(string), "declined") {
			t.Fatalf("denied response wrong: %v", out)
		}
	})
}

// ---------------------------------------------------- read-endpoint tests

func TestHtaskCovGet(t *testing.T) {
	fx := newHtaskCovFixture(t)

	rec := httptest.NewRecorder()
	req := htaskCovReq(http.MethodGet, "/api/v1/coding-tasks/missing", "", "u-alice", "")
	req.SetPathValue("id", "missing")
	fx.h.Get(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("get missing task = %d", rec.Code)
	}

	// A pre-repos row (nil repos) must serialize repos as [].
	task := fx.seedTask(t, "t-old", model.TaskStateCreated, nil)
	rec = httptest.NewRecorder()
	req = htaskCovReq(http.MethodGet, "/api/v1/coding-tasks/"+task.ID, "", "u-alice", "")
	req.SetPathValue("id", task.ID)
	fx.h.Get(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("get = %d (%s)", rec.Code, rec.Body.String())
	}
	out := htaskCovDecode(t, rec)
	tj, _ := out["task"].(map[string]any)
	repos, ok := tj["repos"].([]any)
	if !ok || len(repos) != 0 {
		t.Fatalf("repos must be [], got %v", tj["repos"])
	}
	if url, _ := out["url"].(string); !strings.Contains(url, "/channel/chan-p#msg-card-t-old") {
		t.Fatalf("url wrong: %v", out["url"])
	}
}

func TestHtaskCovListByChannel(t *testing.T) {
	fx := newHtaskCovFixture(t)

	// Access refused.
	fx.msgs.accessErr = errors.New("not a member")
	rec := httptest.NewRecorder()
	req := htaskCovReq(http.MethodGet, "/api/v1/channels/chan-p/coding-tasks", "", "u-alice", "")
	req.SetPathValue("id", "chan-p")
	fx.h.ListByChannel(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("forbidden list = %d", rec.Code)
	}
	fx.msgs.accessErr = nil

	// Empty channel → tasks is [] not null.
	rec = httptest.NewRecorder()
	req = htaskCovReq(http.MethodGet, "/api/v1/channels/chan-p/coding-tasks", "", "u-alice", "")
	req.SetPathValue("id", "chan-p")
	fx.h.ListByChannel(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list = %d (%s)", rec.Code, rec.Body.String())
	}
	out := htaskCovDecode(t, rec)
	if tasks, ok := out["tasks"].([]any); !ok || len(tasks) != 0 {
		t.Fatalf("tasks must be [], got %v", out["tasks"])
	}
}

func TestHtaskCovListProjects(t *testing.T) {
	fx := newHtaskCovFixture(t)

	// Store failure → 500 via writeTaskError default.
	fx.tasks.listProjectsErr = errors.New("dynamo down")
	rec := httptest.NewRecorder()
	fx.h.ListProjects(rec, htaskCovReq(http.MethodGet, "/api/v1/coding-projects", "", "u-alice", ""))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("failing list = %d", rec.Code)
	}
	fx.tasks.listProjectsErr = nil

	// No projects → [] not null.
	rec = httptest.NewRecorder()
	fx.h.ListProjects(rec, htaskCovReq(http.MethodGet, "/api/v1/coding-projects", "", "u-alice", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("list = %d (%s)", rec.Code, rec.Body.String())
	}
	out := htaskCovDecode(t, rec)
	if projects, ok := out["projects"].([]any); !ok || len(projects) != 0 {
		t.Fatalf("projects must be [], got %v", out["projects"])
	}
}

// -------------------------------------------------- card-action tests

func TestHtaskCovSignOff(t *testing.T) {
	fx := newHtaskCovFixture(t)
	task := fx.seedTask(t, "t1", model.TaskStateAwaitingTest, htaskCovBackendRepos())

	// Only the requester may sign off.
	rec := httptest.NewRecorder()
	req := htaskCovReq(http.MethodPost, "/api/v1/coding-tasks/t1/signoff", "", "u-bob", "")
	req.SetPathValue("id", task.ID)
	fx.h.SignOff(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("non-requester sign-off = %d, want 403", rec.Code)
	}

	// The requester's sign-off lands.
	rec = httptest.NewRecorder()
	req = htaskCovReq(http.MethodPost, "/api/v1/coding-tasks/t1/signoff", "", "u-alice", "")
	req.SetPathValue("id", task.ID)
	fx.h.SignOff(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("sign-off = %d (%s)", rec.Code, rec.Body.String())
	}
	out := htaskCovDecode(t, rec)
	tj, _ := out["task"].(map[string]any)
	if tj["signedOffAt"] == nil {
		t.Fatalf("task must carry signedOffAt: %v", tj)
	}
}

func TestHtaskCovSetSteering(t *testing.T) {
	fx := newHtaskCovFixture(t)
	task := fx.seedTask(t, "t1", model.TaskStateInProgress, htaskCovBackendRepos())

	// Missing steering value.
	rec := httptest.NewRecorder()
	req := htaskCovReq(http.MethodPatch, "/api/v1/coding-tasks/t1", `{}`, "u-alice", "")
	req.SetPathValue("id", task.ID)
	fx.h.SetSteering(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing steering = %d", rec.Code)
	}

	// Unknown mode → validation error from the service.
	rec = httptest.NewRecorder()
	req = htaskCovReq(http.MethodPatch, "/api/v1/coding-tasks/t1", `{"steering":"everyone?"}`, "u-alice", "")
	req.SetPathValue("id", task.ID)
	fx.h.SetSteering(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad steering mode = %d", rec.Code)
	}

	// Happy flip.
	rec = httptest.NewRecorder()
	req = htaskCovReq(http.MethodPatch, "/api/v1/coding-tasks/t1", `{"steering":"anyone"}`, "u-alice", "")
	req.SetPathValue("id", task.ID)
	fx.h.SetSteering(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("set steering = %d (%s)", rec.Code, rec.Body.String())
	}
	out := htaskCovDecode(t, rec)
	tj, _ := out["task"].(map[string]any)
	if tj["steering"] != model.TaskSteeringAnyone {
		t.Fatalf("steering = %v", tj["steering"])
	}
}

func TestHtaskCovClose(t *testing.T) {
	fx := newHtaskCovFixture(t)
	repos := htaskCovBackendRepos()
	repos[0].MRURL = "https://gl/mr/1"
	task := fx.seedTask(t, "t1", model.TaskStateMRCreated, repos)

	// Missing state.
	rec := httptest.NewRecorder()
	req := htaskCovReq(http.MethodPost, "/api/v1/coding-tasks/t1/close", `{}`, "u-alice", "")
	req.SetPathValue("id", task.ID)
	fx.h.Close(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing state = %d", rec.Code)
	}

	// Non-requester refused.
	rec = httptest.NewRecorder()
	req = htaskCovReq(http.MethodPost, "/api/v1/coding-tasks/t1/close", `{"state":"done"}`, "u-bob", "")
	req.SetPathValue("id", task.ID)
	fx.h.Close(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("non-requester close = %d", rec.Code)
	}

	// Requester closes as done (MRs are open).
	rec = httptest.NewRecorder()
	req = htaskCovReq(http.MethodPost, "/api/v1/coding-tasks/t1/close", `{"state":"done"}`, "u-alice", "")
	req.SetPathValue("id", task.ID)
	fx.h.Close(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("close = %d (%s)", rec.Code, rec.Body.String())
	}
	out := htaskCovDecode(t, rec)
	tj, _ := out["task"].(map[string]any)
	if tj["state"] != string(model.TaskStateDone) {
		t.Fatalf("state = %v", tj["state"])
	}
}
