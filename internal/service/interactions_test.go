package service

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
)

// ---- fakes

type fakeIxState struct {
	mu       sync.Mutex
	urls     map[string]*fakeURL
	history  map[string][]model.InteractionEntry
	failures map[string]int
	paused   map[string]time.Duration
	mintErr  error
	useErr   error
	stateErr error // record / list / failure / success / paused

	triggers   map[string]model.TriggerRecord
	views      map[string]*model.StoredView
	externals  map[string]string
	idem       map[string][]byte
	triggerErr error // mint / use trigger
	viewErr    error // save / get / find / delete view
	idemErr    error // claim / finish idempotency key
	// saveViewErr / deleteViewErr fail only that write, so a form can be
	// read and then fail to save or close.
	saveViewErr   error
	deleteViewErr error
	dropErr       error // DropViewExternalID
	getViewErr    error // GetView only
}

type fakeURL struct {
	rec  model.ResponseURLRecord
	uses int
}

func newFakeIxState() *fakeIxState {
	return &fakeIxState{urls: map[string]*fakeURL{}, history: map[string][]model.InteractionEntry{}, failures: map[string]int{}, paused: map[string]time.Duration{},
		triggers: map[string]model.TriggerRecord{}, views: map[string]*model.StoredView{}, externals: map[string]string{}, idem: map[string][]byte{}}
}

func (f *fakeIxState) MintTrigger(_ context.Context, hash string, rec model.TriggerRecord, _ time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.triggerErr != nil {
		return f.triggerErr
	}
	f.triggers[hash] = rec
	return nil
}

func (f *fakeIxState) UseTrigger(_ context.Context, hash string) (*model.TriggerRecord, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.triggerErr != nil {
		return nil, f.triggerErr
	}
	rec, ok := f.triggers[hash]
	if !ok {
		return nil, nil
	}
	delete(f.triggers, hash)
	return &rec, nil
}

func (f *fakeIxState) SaveView(_ context.Context, v *model.StoredView, _ time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.viewErr != nil {
		return f.viewErr
	}
	if f.saveViewErr != nil {
		return f.saveViewErr
	}
	cp := *v
	f.views[v.View.ID] = &cp
	if v.View.ExternalID != "" {
		f.externals[v.WebhookID+":"+v.View.ExternalID] = v.View.ID
	}
	return nil
}

func (f *fakeIxState) GetView(_ context.Context, id string) (*model.StoredView, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.getViewErr != nil {
		return nil, f.getViewErr
	}
	if f.viewErr != nil {
		return nil, f.viewErr
	}
	v, ok := f.views[id]
	if !ok {
		return nil, nil
	}
	cp := *v
	return &cp, nil
}

func (f *fakeIxState) ViewIDByExternalID(_ context.Context, webhookID, ext string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.externals[webhookID+":"+ext], f.viewErr
}

func (f *fakeIxState) DeleteView(_ context.Context, v *model.StoredView) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.viewErr != nil {
		return f.viewErr
	}
	if f.deleteViewErr != nil {
		return f.deleteViewErr
	}
	delete(f.views, v.View.ID)
	f.dropExternal(v.WebhookID, v.View.ExternalID, v.View.ID)
	return nil
}

// dropExternal forgets an external_id while it still names viewID, as the
// Redis script does. Callers hold f.mu.
func (f *fakeIxState) dropExternal(webhookID, externalID, viewID string) {
	if key := webhookID + ":" + externalID; f.externals[key] == viewID {
		delete(f.externals, key)
	}
}

func (f *fakeIxState) DropViewExternalID(_ context.Context, webhookID, externalID, viewID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.dropErr != nil {
		return f.dropErr
	}
	f.dropExternal(webhookID, externalID, viewID)
	return nil
}

func (f *fakeIxState) ClaimIdempotencyKey(_ context.Context, scope, key string, _ time.Duration) ([]byte, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.idemErr != nil {
		return nil, false, f.idemErr
	}
	if prev, ok := f.idem[scope+":"+key]; ok {
		return prev, false, nil
	}
	f.idem[scope+":"+key] = nil
	return nil, true, nil
}

func (f *fakeIxState) FinishIdempotencyKey(_ context.Context, scope, key string, answer []byte, _ time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.idemErr != nil {
		return f.idemErr
	}
	if answer == nil {
		delete(f.idem, scope+":"+key)
	} else {
		f.idem[scope+":"+key] = answer
	}
	return nil
}

func (f *fakeIxState) MintResponseURL(_ context.Context, hash string, rec model.ResponseURLRecord, uses int, _ time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.mintErr != nil {
		return f.mintErr
	}
	f.urls[hash] = &fakeURL{rec: rec, uses: uses}
	return nil
}

func (f *fakeIxState) UseResponseURL(_ context.Context, hash string) (*model.ResponseURLRecord, int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.useErr != nil {
		return nil, 0, f.useErr
	}
	u, ok := f.urls[hash]
	if !ok {
		return nil, 0, nil
	}
	u.uses--
	rec := u.rec
	return &rec, u.uses, nil
}

func (f *fakeIxState) RecordInteraction(_ context.Context, id string, e model.InteractionEntry) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.stateErr != nil {
		return f.stateErr
	}
	f.history[id] = append([]model.InteractionEntry{e}, f.history[id]...)
	return nil
}

func (f *fakeIxState) ListInteractions(_ context.Context, id string) ([]model.InteractionEntry, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.history[id], f.stateErr
}

func (f *fakeIxState) NoteAppFailure(_ context.Context, id string, threshold int, pause time.Duration) (time.Duration, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.stateErr != nil {
		return 0, f.stateErr
	}
	f.failures[id]++
	if f.failures[id] >= threshold {
		f.paused[id] = pause
		return pause, nil
	}
	return 0, nil
}

func (f *fakeIxState) NoteAppSuccess(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.failures, id)
	return f.stateErr
}

func (f *fakeIxState) AppPausedFor(_ context.Context, id string) (time.Duration, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.paused[id], f.stateErr
}

func (f *fakeIxState) lastEntry(id string) model.InteractionEntry {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.history[id][0]
}

type fakeClickLimiter struct {
	deny, denyApp bool
	appErr        error // the app-call limiter is down
}

func (f *fakeClickLimiter) AllowClick(context.Context, string) (bool, error) { return !f.deny, nil }
func (f *fakeClickLimiter) AllowAppCall(context.Context, string) (bool, time.Duration, error) {
	return !f.denyApp, 1500 * time.Millisecond, f.appErr
}

// ---- fixture

// fakeApp is an app server: it checks each request's signature against the
// secrets it holds and answers with whatever the test sets.
type fakeApp struct {
	t       *testing.T
	secrets []string
	mu      sync.Mutex
	got     []blockActionsPayload
	bodies  [][]byte
	sigs    []string
	status  int
	reply   string
	delay   time.Duration
}

func (a *fakeApp) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	ts := r.Header.Get("X-Ex-Request-Timestamp")
	sigHeader := r.Header.Get("X-Ex-Signature")
	verified := false
	for _, secret := range a.secrets {
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write([]byte("v0:" + ts + ":"))
		mac.Write(body)
		want := "v0=" + hex.EncodeToString(mac.Sum(nil))
		for _, sig := range strings.Split(sigHeader, ",") {
			if hmac.Equal([]byte(sig), []byte(want)) {
				verified = true
			}
		}
	}
	if !verified {
		a.t.Errorf("app got a request whose signature it can't verify: %q", sigHeader)
	}
	var p blockActionsPayload
	_ = json.Unmarshal(body, &p)
	a.mu.Lock()
	a.got = append(a.got, p)
	a.bodies = append(a.bodies, body)
	a.sigs = append(a.sigs, sigHeader)
	status, reply, delay := a.status, a.reply, a.delay
	a.mu.Unlock()
	if delay > 0 {
		time.Sleep(delay)
	}
	if status == 0 {
		status = http.StatusOK
	}
	w.WriteHeader(status)
	_, _ = w.Write([]byte(reply))
}

// answer changes how the app answers; locked, since a slow request from
// before may still be in the handler.
func (a *fakeApp) answer(status int, reply string, delay time.Duration) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.status, a.reply, a.delay = status, reply, delay
}

type ixFixture struct {
	svc      *InteractionService
	msgs     *MessageService
	messages *mockMessageStore
	hooks    *fakeWebhookStore
	state    *fakeIxState
	limiter  *fakeClickLimiter
	pub      *mockPublisher
	app      *fakeApp
	server   *httptest.Server
	wh       *model.IncomingWebhook
}

func newIxFixture(t *testing.T) *ixFixture {
	t.Helper()
	svc, messages, memberships, _, pub := setupMessageService()
	for _, u := range []string{"u-1", "u-2"} {
		memberships.memberships["ch1#"+u] = &model.ChannelMembership{ChannelID: "ch1", UserID: u, Role: model.ChannelRoleMember}
	}
	ch := &model.Channel{ID: "ch1", Name: "Platform", Slug: "platform", Type: model.ChannelTypePublic}
	hooks := &fakeWebhookStore{items: map[string]*model.IncomingWebhook{}}
	webhooks := NewIncomingWebhookService(hooks, fakeWebhookChannels{byID: map[string]*model.Channel{ch.ID: ch}, bySlug: map[string]*model.Channel{ch.Slug: ch}}, svc, fakeWebhookImageProxy{}, "")
	webhooks.SetUserResolver(fakeWebhookUsers{users: []*model.User{{ID: "u-1", DisplayName: "Virpal", Email: "virpal@ex.test"}}})
	state := newFakeIxState()
	limiter := &fakeClickLimiter{}
	ix := NewInteractionService(svc, webhooks, state, limiter, pub, InteractionConfig{SigningKey: []byte("server-key"), BaseURL: "https://chat.ex.test/", AllowPrivate: true})
	ix.timeout = 300 * time.Millisecond
	f := &ixFixture{svc: ix, msgs: svc, messages: messages, hooks: hooks, state: state, limiter: limiter, pub: pub}
	f.wh = &model.IncomingWebhook{ID: "wh", Title: "MeetingMind", Username: "MeetingMind", ChannelID: "ch1", CreatedBy: "u-1", SecretVersion: 1}
	f.app = &fakeApp{t: t, secrets: []string{ix.signer.Secret("wh", 1)}}
	f.server = httptest.NewServer(f.app)
	t.Cleanup(f.server.Close)
	f.wh.InteractivityURL = f.server.URL
	hooks.items["wh"] = f.wh
	messages.messages["ch1#m1"] = appMessage()
	return f
}

// appMessage is MeetingMind's card: an app button, an ack, and a button in a
// card, posted with the app's token.
func appMessage() *model.Message {
	use := btn("use_date", "Use Fri 23 Oct")
	use.Value = "m_8f2c:A3:2026-10-23"
	ack := btn("ack", "Ack")
	ack.ExAction = model.ExActionAck
	return &model.Message{
		ID: "m1", ParentID: "ch1", AuthorID: WebhookAuthorID, Body: "Platform sync", WebhookID: "wh", WebhookUsername: "MeetingMind", AppButtons: true,
		Blocks: model.Blocks{
			{Type: model.BlockSection, BlockID: "b1", Text: plain("A3"), Accessory: &use},
			{Type: model.BlockActions, BlockID: "b2", Elements: []model.BlockElement{ack}},
		},
		ActionTallies: []model.ActionTally{{BlockID: "b2", ActionID: "ack", UserIDs: []string{"u-2"}}},
	}
}

func (f *ixFixture) click(userID string) (*ActResult, error) {
	return f.msgs.Act(context.Background(), userID, "ch1", ParentChannel, "m1", "b1", "use_date")
}

// ---- clicks

func TestClick_SendsTheStoredButtonSignedAndAppliesTheReply(t *testing.T) {
	f := newIxFixture(t)
	f.app.reply = `{"replace_original": true, "text": "A3 is due Fri", "blocks": [{"type":"section","text":{"type":"mrkdwn","text":"**A3** due Fri"}},{"type":"actions","block_id":"b2","elements":[{"type":"button","action_id":"ack","ex_action":"ack","text":{"type":"plain_text","text":"Ack"}}]}], "notice": "Saved"}`
	res, err := f.click("u-1")
	if err != nil {
		t.Fatalf("click: %v", err)
	}
	if len(f.app.got) != 1 {
		t.Fatalf("app got %d requests", len(f.app.got))
	}
	p := f.app.got[0]
	if p.Type != "block_actions" || p.User.ID != "u-1" || p.User.Name != "Virpal" || p.User.Email != "" {
		t.Fatalf("user = %+v", p.User)
	}
	if p.Channel.Name != "Platform" || p.Container.MessageID != "m1" || p.Message.Text != "Platform sync" {
		t.Fatalf("where = %+v %+v %+v", p.Channel, p.Container, p.Message)
	}
	if a := p.Actions[0]; a.ActionID != "use_date" || a.BlockID != "b1" || a.Value != "m_8f2c:A3:2026-10-23" {
		t.Fatalf("action = %+v", a)
	}
	if !strings.HasPrefix(p.ResponseURL, "https://chat.ex.test/api/v1/apps/respond/") || !strings.HasPrefix(p.InteractionID, "i_") {
		t.Fatalf("response url %q, interaction %q", p.ResponseURL, p.InteractionID)
	}
	if res.Notice != "Saved" || res.Message.Body != "A3 is due Fri" || res.Message.Version != 1 || res.Message.EditedAt != nil {
		t.Fatalf("result = %+v %+v", res.Notice, res.Message)
	}
	// The ack on the button the new card still has keeps its tally.
	if len(res.Message.ActionTallies) != 1 || res.Message.Blocks[0].Text.Type != model.TextMarkdown {
		t.Fatalf("tallies %v blocks %v", res.Message.ActionTallies, res.Message.Blocks)
	}
	if e := f.state.lastEntry("wh"); e.Kind != model.InteractionClick || e.Result != model.InteractionOK || e.ActionID != "use_date" {
		t.Fatalf("history = %+v", e)
	}
}

func TestClick_EmailOnlyWhenSharedAndDropsTalliesOfButtonsGone(t *testing.T) {
	f := newIxFixture(t)
	f.wh.EmailSharing = true
	f.app.reply = `{"replace_original": true, "text": "done"}`
	res, err := f.click("u-1")
	if err != nil || f.app.got[0].User.Email != "virpal@ex.test" {
		t.Fatalf("email: %v %+v", err, f.app.got[0].User)
	}
	if res.Message.ActionTallies != nil || res.Message.Blocks != nil {
		t.Fatalf("a card without the ack keeps no tally: %+v", res.Message)
	}
}

func TestClick_AnEmptyOrNonJSONReplyChangesNothing(t *testing.T) {
	f := newIxFixture(t)
	res, err := f.click("u-1")
	if err != nil || res.Notice != "" || res.Message.Version != 0 {
		t.Fatalf("empty reply: %+v %v", res, err)
	}
	f.app.reply = "ok"
	if _, err := f.click("u-1"); err != nil {
		t.Fatalf("plain reply: %v", err)
	}
	if e := f.state.lastEntry("wh"); e.Result != model.InteractionOK || !strings.Contains(e.Error, "isn't a JSON answer") {
		t.Fatalf("history = %+v", e)
	}
	// An answer that only leaves a notice.
	f.app.reply = `{"notice": "` + strings.Repeat("n", 400) + `"}`
	res, _ = f.click("u-1")
	if n := len([]rune(res.Notice)); n != maxNoticeChars || !strings.HasSuffix(res.Notice, "…") || res.Failed {
		t.Fatalf("notice cut to %d", n)
	}
}

func TestClick_AFailingAppCostsANoticeAndPausesAtTheThreshold(t *testing.T) {
	f := newIxFixture(t)
	f.app.status = http.StatusInternalServerError
	for i := 0; i < appFailureThreshold; i++ {
		res, err := f.click("u-1")
		if err != nil || res.Notice != "MeetingMind didn't respond. Try again." || !res.Failed || res.Message.ID != "m1" {
			t.Fatalf("failure %d: %+v %v", i, res, err)
		}
	}
	if e := f.state.lastEntry("wh"); e.Result != model.InteractionFailed || e.Error != "answered 500" || e.Status != 500 {
		t.Fatalf("history = %+v", e)
	}
	if _, err := f.click("u-1"); !errors.Is(err, ErrAppUnavailable) {
		t.Fatalf("paused app: %v", err)
	}
}

func TestClick_TimeoutAndUnreachable(t *testing.T) {
	f := newIxFixture(t)
	f.app.delay = 600 * time.Millisecond
	res, err := f.click("u-1")
	if err != nil || !strings.Contains(res.Notice, "didn't respond") {
		t.Fatalf("slow app: %+v %v", res, err)
	}
	if e := f.state.lastEntry("wh"); e.Result != model.InteractionTimeout {
		t.Fatalf("history = %+v", e)
	}
	f.app.answer(0, "", 0)
	f.server.Close()
	if res, err := f.click("u-1"); err != nil || !strings.Contains(res.Notice, "didn't respond") {
		t.Fatalf("unreachable: %+v %v", res, err)
	}
	if e := f.state.lastEntry("wh"); e.Result != model.InteractionFailed || e.Error == "" {
		t.Fatalf("history = %+v", e)
	}
}

func TestClick_Refusals(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()

	unverified := appMessage()
	unverified.AppButtons = false
	f.messages.messages["ch1#m1"] = unverified
	if _, err := f.click("u-1"); !errors.Is(err, ErrAppNotSetUp) {
		t.Fatalf("message posted without the token: %v", err)
	}
	f.messages.messages["ch1#m1"] = appMessage()

	f.wh.InteractivityURL = ""
	if _, err := f.click("u-1"); !errors.Is(err, ErrAppNotSetUp) {
		t.Fatalf("no request url: %v", err)
	}
	f.wh.InteractivityURL = f.server.URL

	f.wh.AdminPaused = true
	if _, err := f.click("u-1"); !errors.Is(err, ErrAppUnavailable) || !strings.Contains(err.Error(), "paused by an admin") {
		t.Fatalf("admin pause: %v", err)
	}
	f.wh.AdminPaused = false

	f.limiter.deny = true
	if _, err := f.click("u-1"); !errors.Is(err, ErrClickRateLimited) {
		t.Fatalf("rate limit: %v", err)
	}
	f.limiter.deny = false

	f.svc.inFlight["wh"] = maxAppClicksInFlight
	if _, err := f.click("u-1"); !errors.Is(err, ErrAppBusy) {
		t.Fatalf("busy: %v", err)
	}
	f.svc.release("wh")
	if _, err := f.click("u-1"); err != nil {
		t.Fatalf("room again: %v", err)
	}

	delete(f.hooks.items, "wh")
	if _, err := f.click("u-1"); !errors.Is(err, ErrAppNotSetUp) {
		t.Fatalf("webhook gone: %v", err)
	}
	// Without the interaction service, an app button is not set up.
	bare, messages, memberships, _, _ := setupMessageService()
	memberships.memberships["ch1#u-1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-1"}
	messages.messages["ch1#m1"] = appMessage()
	if _, err := bare.Act(ctx, "u-1", "ch1", ParentChannel, "m1", "b1", "use_date"); !errors.Is(err, ErrAppNotSetUp) {
		t.Fatalf("no clicker: %v", err)
	}
}

func TestClick_StateFailuresDontStopAClick(t *testing.T) {
	f := newIxFixture(t)
	f.state.mintErr = errors.New("redis down")
	f.state.stateErr = errors.New("redis down")
	f.app.reply = `{"notice":"hi"}`
	res, err := f.click("u-1")
	if err != nil || res.Notice != "hi" || f.app.got[0].ResponseURL != "" {
		t.Fatalf("click without state: %+v %v (url %q)", res, err, f.app.got[0].ResponseURL)
	}
	f.app.status = http.StatusBadGateway
	if res, err := f.click("u-1"); err != nil || !strings.Contains(res.Notice, "didn't respond") {
		t.Fatalf("failure without state: %+v %v", res, err)
	}
}

func TestClick_PausedForFailingLogsThePause(t *testing.T) {
	f := newIxFixture(t)
	f.state.failures["wh"] = appFailureThreshold - 1
	f.app.status = http.StatusServiceUnavailable
	if _, err := f.click("u-1"); err != nil {
		t.Fatalf("click: %v", err)
	}
	if f.state.paused["wh"] != appFailurePause {
		t.Fatalf("paused for %v", f.state.paused["wh"])
	}
}

func TestClick_AnAnswerThatPostsANewMessageLeavesTheCard(t *testing.T) {
	f := newIxFixture(t)
	f.app.reply = `{"text": "Synced to Cliff Hub", "root_id": "m1"}`
	res, err := f.click("u-1")
	if err != nil || res.Message.ID != "m1" || res.Message.Body != "Platform sync" || res.Failed {
		t.Fatalf("the clicked card should come back as it was: %+v %v", res, err)
	}
	var reply *model.Message
	for _, m := range f.messages.messages {
		if m.ParentMessageID == "m1" {
			reply = m
		}
	}
	if reply == nil || reply.Body != "Synced to Cliff Hub" {
		t.Fatalf("no thread reply posted: %+v", reply)
	}
}

func TestClick_AnAnswerExCantShowLeavesTheCard(t *testing.T) {
	f := newIxFixture(t)
	f.app.reply = `{"replace_original": true, "blocks": [{"type":"header"}]}`
	res, err := f.click("u-1")
	if err != nil || res.Notice != "MeetingMind's answer couldn't be shown." || !res.Failed || res.Message.Body != "Platform sync" {
		t.Fatalf("bad answer: %+v %v", res, err)
	}
	if e := f.state.lastEntry("wh"); !strings.Contains(e.Error, "a header needs text") {
		t.Fatalf("history = %+v", e)
	}
}

func TestClick_AppNameFallsBackToTheTitle(t *testing.T) {
	f := newIxFixture(t)
	f.wh.Username = "webhook"
	f.app.status = 500
	res, _ := f.click("u-1")
	if res.Notice != "MeetingMind didn't respond. Try again." {
		t.Fatalf("notice = %q", res.Notice)
	}
}

// ---- answers

func (f *ixFixture) rec() model.ResponseURLRecord {
	return model.ResponseURLRecord{WebhookID: "wh", ParentID: "ch1", ParentType: ParentChannel, MessageID: "m1", UserID: "u-1"}
}

func TestApply_DeletePostAndVersionChecks(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	v := 5
	if _, err := f.svc.apply(ctx, f.wh, f.rec(), AppResponse{DeleteOriginal: true, IfVersion: &v}); !errors.Is(err, ErrAppVersionConflict) {
		t.Fatalf("stale delete: %v", err)
	}
	if _, err := f.svc.apply(ctx, f.wh, f.rec(), AppResponse{ReplaceOriginal: true, Text: "x", IfVersion: &v}); !errors.Is(err, ErrAppVersionConflict) {
		t.Fatalf("stale replace: %v", err)
	}
	// A new message, as the same bot, in a thread under the card.
	posted, err := f.svc.apply(ctx, f.wh, f.rec(), AppResponse{Text: "Synced to Cliff Hub", RootID: "m1"})
	if err != nil || posted.ID == "m1" || posted.ParentMessageID != "m1" || posted.WebhookUsername != "MeetingMind" || !posted.AppButtons {
		t.Fatalf("new message: %+v %v", posted, err)
	}
	if out, err := f.svc.apply(ctx, f.wh, f.rec(), AppResponse{Notice: "only a notice"}); err != nil || out != nil {
		t.Fatalf("notice only: %+v %v", out, err)
	}
	zero := 0
	gone, err := f.svc.apply(ctx, f.wh, f.rec(), AppResponse{DeleteOriginal: true, IfVersion: &zero})
	if err != nil || !gone.Deleted {
		t.Fatalf("delete: %+v %v", gone, err)
	}
	// Gone now: every answer about it is "not found".
	for _, resp := range []AppResponse{{DeleteOriginal: true}, {ReplaceOriginal: true, Text: "x"}, {Text: "y"}} {
		if _, err := f.svc.apply(ctx, f.wh, f.rec(), resp); !errors.Is(err, apperr.ErrNotFound) {
			t.Fatalf("%+v on a deleted message: %v", resp, err)
		}
	}
}

func TestApply_OnlyTheAppsOwnMessage(t *testing.T) {
	f := newIxFixture(t)
	other := appMessage()
	other.WebhookID = "someone-else"
	f.messages.messages["ch1#m1"] = other
	if _, err := f.svc.apply(context.Background(), f.wh, f.rec(), AppResponse{ReplaceOriginal: true, Text: "mine now"}); !errors.Is(err, apperr.ErrNotFound) {
		t.Fatalf("another app's message: %v", err)
	}
}

func TestApply_ReplaceRetriesRacesButNotStaleVersions(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	f.messages.forcedConflicts = actionAttempts - 1
	if m, err := f.svc.apply(ctx, f.wh, f.rec(), AppResponse{ReplaceOriginal: true, Text: "won"}); err != nil || m.Body != "won" {
		t.Fatalf("after lost races: %+v %v", m, err)
	}
	f.messages.forcedConflicts = actionAttempts
	if _, err := f.svc.apply(ctx, f.wh, f.rec(), AppResponse{ReplaceOriginal: true, Text: "lost"}); !errors.Is(err, ErrAppVersionConflict) {
		t.Fatalf("every race lost: %v", err)
	}
	// With if_version the app asked for exactly that version: one lost race
	// is a conflict, not a retry.
	f.messages.forcedConflicts = 1
	v := 1
	if _, err := f.svc.apply(ctx, f.wh, f.rec(), AppResponse{ReplaceOriginal: true, Text: "x", IfVersion: &v}); !errors.Is(err, ErrAppVersionConflict) {
		t.Fatalf("if_version race: %v", err)
	}
	f.messages.forcedConflicts = 0
	f.messages.updateErr = errors.New("dynamo down")
	if _, err := f.svc.apply(ctx, f.wh, f.rec(), AppResponse{ReplaceOriginal: true, Text: "x"}); err == nil || errors.Is(err, ErrAppVersionConflict) {
		t.Fatalf("store failure: %v", err)
	}
	f.messages.updateErr = nil
	if _, err := f.svc.apply(ctx, f.wh, f.rec(), AppResponse{ReplaceOriginal: true}); !errors.Is(err, apperr.ErrValidation) {
		t.Fatalf("replace with nothing: %v", err)
	}
	if _, err := f.svc.apply(ctx, f.wh, f.rec(), AppResponse{Blocks: model.Blocks{{Type: model.BlockHeader}}}); !errors.Is(err, ErrInvalidBlocks) {
		t.Fatalf("new message with bad blocks: %v", err)
	}
	f.messages.updateErr = errors.New("dynamo down")
	if _, err := f.svc.apply(ctx, f.wh, f.rec(), AppResponse{DeleteOriginal: true}); err == nil {
		t.Fatal("delete store failure")
	}
}

func TestApply_ReplaceTellsActivityWhenTheTextChanged(t *testing.T) {
	f := newIxFixture(t)
	activity := &ixActivity{}
	f.msgs.SetActivityRecorder(activity)
	if _, err := f.svc.apply(context.Background(), f.wh, f.rec(), AppResponse{ReplaceOriginal: true, Text: "Platform sync"}); err != nil {
		t.Fatalf("same text: %v", err)
	}
	if _, err := f.svc.apply(context.Background(), f.wh, f.rec(), AppResponse{ReplaceOriginal: true, Text: "Reviewed"}); err != nil {
		t.Fatalf("new text: %v", err)
	}
	if activity.edited != 1 {
		t.Fatalf("activity told %d times, want 1", activity.edited)
	}
}

// ixActivity counts the edits the Activity feed is told about.
type ixActivity struct{ edited int }

func (r *ixActivity) RecordReaction(context.Context, *model.Message, string, string, string) {}
func (r *ixActivity) MessagesDeleted(context.Context, string, string, []string)              {}
func (r *ixActivity) MessageEdited(context.Context, *model.Message, string)                  { r.edited++ }
func (r *ixActivity) MarkParentRead(context.Context, string, string, string, time.Time)      {}

// ---- response_url

func TestRespond(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	url := f.svc.mintResponseURL(ctx, f.rec())
	token := url[strings.LastIndex(url, "/")+1:]

	if err := f.svc.Respond(ctx, token, AppResponse{ReplaceOriginal: true, Text: "Reviewed by Virpal", Notice: "Thanks"}); err != nil {
		t.Fatalf("respond: %v", err)
	}
	if m := f.messages.messages["ch1#m1"]; m.Body != "Reviewed by Virpal" {
		t.Fatalf("message = %q", m.Body)
	}
	var notice *events.Event
	for _, p := range f.pub.published {
		if p.event.Type == events.EventInteractionNotice {
			notice = p.event
			if p.channel != "user:u-1" {
				t.Fatalf("notice sent to %q", p.channel)
			}
		}
	}
	if notice == nil || !strings.Contains(string(notice.Data), `"text":"Thanks"`) {
		t.Fatalf("notice event = %+v", notice)
	}
	if e := f.state.lastEntry("wh"); e.Kind != model.InteractionResponseURL || e.Result != model.InteractionOK {
		t.Fatalf("history = %+v", e)
	}
	// Four more uses, then it's spent.
	for i := 0; i < responseURLUses-1; i++ {
		if err := f.svc.Respond(ctx, token, AppResponse{}); err != nil {
			t.Fatalf("use %d: %v", i+2, err)
		}
	}
	if err := f.svc.Respond(ctx, token, AppResponse{}); !errors.Is(err, ErrResponseURLUsedUp) {
		t.Fatalf("sixth use: %v", err)
	}
	if err := f.svc.Respond(ctx, "unknown", AppResponse{}); !errors.Is(err, ErrResponseURLExpired) {
		t.Fatalf("unknown token: %v", err)
	}
}

func TestRespond_Failures(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	mint := func() string {
		url := f.svc.mintResponseURL(ctx, f.rec())
		return url[strings.LastIndex(url, "/")+1:]
	}
	bad := mint()
	if err := f.svc.Respond(ctx, bad, AppResponse{ReplaceOriginal: true, Blocks: model.Blocks{{Type: model.BlockHeader}}}); !errors.Is(err, ErrInvalidBlocks) {
		t.Fatalf("bad answer: %v", err)
	}
	if e := f.state.lastEntry("wh"); e.Result != model.InteractionFailed {
		t.Fatalf("history = %+v", e)
	}
	orphan := mint()
	delete(f.hooks.items, "wh")
	if err := f.svc.Respond(ctx, orphan, AppResponse{}); !errors.Is(err, ErrResponseURLExpired) {
		t.Fatalf("app gone: %v", err)
	}
	f.state.useErr = errors.New("redis down")
	if err := f.svc.Respond(ctx, "any", AppResponse{}); err == nil {
		t.Fatal("state failure")
	}
}

// ---- setup

func member(id string) WebhookActor { return WebhookActor{ID: id, Role: model.SystemRoleMember} }

var admin = WebhookActor{ID: "u-admin", Role: model.SystemRoleAdmin}

func TestSetup_TokensAndSecretsRotateWithOverlap(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	f.svc.now = func() time.Time { return now }
	f.wh.SecretVersion = 0

	first, wh, err := f.svc.RotateBotToken(ctx, member("u-1"), "wh", false)
	if err != nil || !strings.HasPrefix(first, botTokenPrefix) || !wh.HasBotToken || wh.PrevBotTokenHash != "" {
		t.Fatalf("first token: %q %+v %v", first, wh, err)
	}
	second, wh, _ := f.svc.RotateBotToken(ctx, member("u-1"), "wh", false)
	if !botTokenMatches(wh, first, now) || !botTokenMatches(wh, second, now) {
		t.Fatal("both tokens work during the overlap")
	}
	if botTokenMatches(wh, first, now.Add(rotationOverlap+time.Second)) {
		t.Fatal("the old token outlived its overlap")
	}
	third, wh, _ := f.svc.RotateBotToken(ctx, member("u-1"), "wh", true)
	if botTokenMatches(wh, second, now) || !botTokenMatches(wh, third, now) || botTokenMatches(wh, "", now) {
		t.Fatal("revoke now")
	}

	s1, wh, err := f.svc.RotateSigningSecret(ctx, member("u-1"), "wh", false)
	if err != nil || !strings.HasPrefix(s1, signingSecretPrefix) || wh.SecretVersion != 1 || wh.PrevSecretUntil != nil || !wh.HasSigningSecret {
		t.Fatalf("first secret: %+v %v", wh, err)
	}
	s2, wh, _ := f.svc.RotateSigningSecret(ctx, member("u-1"), "wh", false)
	header := f.svc.signer.SignatureHeader(wh, 1, []byte("x"), now)
	if s1 == s2 || len(strings.Split(header, ",")) != 2 {
		t.Fatalf("overlap signs twice: %q", header)
	}
	if h := f.svc.signer.SignatureHeader(wh, 1, []byte("x"), now.Add(rotationOverlap+time.Second)); strings.Contains(h, ",") {
		t.Fatalf("after the overlap one signature: %q", h)
	}
	_, wh, _ = f.svc.RotateSigningSecret(ctx, member("u-1"), "wh", true)
	if wh.PrevSecretUntil != nil || wh.SecretVersion != 3 {
		t.Fatalf("revoke now: %+v", wh)
	}

	// Someone else's webhook reads as missing; a guest manages none.
	if _, _, err := f.svc.RotateBotToken(ctx, member("u-9"), "wh", false); err == nil {
		t.Fatal("stranger rotated a token")
	}
	if _, _, err := f.svc.RotateSigningSecret(ctx, WebhookActor{ID: "g", Role: model.SystemRoleGuest}, "wh", false); err == nil {
		t.Fatal("guest rotated a secret")
	}
	f.hooks.updateErr = errors.New("dynamo down")
	if _, _, err := f.svc.RotateBotToken(ctx, member("u-1"), "wh", false); err == nil {
		t.Fatal("save failure")
	}
	if _, _, err := f.svc.RotateSigningSecret(ctx, member("u-1"), "wh", false); err == nil {
		t.Fatal("save failure")
	}
}

func TestSetup_AdminOnlySwitches(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	if _, err := f.svc.SetEmailSharing(ctx, member("u-1"), "wh", true); !errors.Is(err, apperr.ErrForbidden) {
		t.Fatalf("owner shares emails: %v", err)
	}
	if wh, err := f.svc.SetEmailSharing(ctx, admin, "wh", true); err != nil || !wh.EmailSharing {
		t.Fatalf("admin: %+v %v", wh, err)
	}
	if _, err := f.svc.SetAdminPaused(ctx, member("u-1"), "wh", true); !errors.Is(err, apperr.ErrForbidden) {
		t.Fatalf("owner pauses: %v", err)
	}
	if wh, err := f.svc.SetAdminPaused(ctx, admin, "wh", true); err != nil || !wh.AdminPaused {
		t.Fatalf("admin pause: %+v %v", wh, err)
	}
	if _, err := f.svc.SetEmailSharing(ctx, admin, "missing", true); err == nil {
		t.Fatal("missing webhook")
	}
	if _, err := f.svc.SetAdminPaused(ctx, admin, "missing", true); err == nil {
		t.Fatal("missing webhook")
	}
}

func TestSetup_RequestURL(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	if wh, err := f.svc.SetRequestURL(ctx, member("u-1"), "wh", "  "); err != nil || wh.InteractivityURL != "" {
		t.Fatalf("clear: %+v %v", wh, err)
	}
	if _, err := f.svc.SetRequestURL(ctx, member("u-1"), "missing", ""); err == nil {
		t.Fatal("missing webhook")
	}
	// Development: any http(s) address.
	if wh, err := f.svc.SetRequestURL(ctx, member("u-1"), "wh", "http://localhost:9000/ex"); err != nil || wh.InteractivityURL != "http://localhost:9000/ex" {
		t.Fatalf("dev: %+v %v", wh, err)
	}
	for _, raw := range []string{"ftp://x.test", "https://user:pw@x.test", "https://", "https://x.test/" + strings.Repeat("a", maxRequestURLChars), "%zz"} {
		if _, err := f.svc.SetRequestURL(ctx, member("u-1"), "wh", raw); !errors.Is(err, apperr.ErrValidation) {
			t.Errorf("%q: %v", raw, err)
		}
	}

	// Production: https on the public internet, or 10.x under the internal
	// domains.
	f.svc.allowPrivate = false
	f.svc.internalDomains = []string{"digitaltolk.net"}
	ips := map[string][]net.IP{
		"app.example.com":             {net.ParseIP("93.184.216.34")},
		"cliffhub.digitaltolk.net":    {net.ParseIP("10.20.1.5")},
		"lan.digitaltolk.net":         {net.ParseIP("192.168.1.5")},
		"metadata.example.com":        {net.ParseIP("169.254.169.254")},
		"mixed.example.com":           {net.ParseIP("93.184.216.34"), net.ParseIP("127.0.0.1")},
		"internal-v6.digitaltolk.net": {net.ParseIP("::ffff:10.1.2.3")},
	}
	f.svc.lookupIP = func(_ context.Context, host string) ([]net.IP, error) {
		if got, ok := ips[host]; ok {
			return got, nil
		}
		return nil, fmt.Errorf("no such host")
	}
	for raw, ok := range map[string]bool{
		"https://app.example.com/ex":          true,
		"https://cliffhub.digitaltolk.net/ix": true,
		"https://internal-v6.digitaltolk.net": true,
		"http://app.example.com/ex":           false,
		"https://lan.digitaltolk.net/ix":      false,
		"https://metadata.example.com/":       false,
		"https://mixed.example.com/":          false,
		"https://nowhere.example.com/":        false,
	} {
		_, err := f.svc.SetRequestURL(ctx, member("u-1"), "wh", raw)
		if (err == nil) != ok {
			t.Errorf("%s: err = %v, want ok=%v", raw, err, ok)
		}
	}
}

func TestSetup_StatusAndTest(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	f.state.paused["wh"] = 90 * time.Second
	f.state.history["wh"] = []model.InteractionEntry{{Kind: model.InteractionClick, Result: model.InteractionOK}}
	st, err := f.svc.Status(ctx, member("u-1"), "wh")
	if err != nil || st.PausedFor != 90 || len(st.Interactions) != 1 || !st.Webhook.HasSigningSecret {
		t.Fatalf("status: %+v %v", st, err)
	}
	f.state.stateErr = errors.New("redis down")
	if st, err := f.svc.Status(ctx, member("u-1"), "wh"); err != nil || st.PausedFor != 0 || len(st.Interactions) != 0 {
		t.Fatalf("status without state: %+v %v", st, err)
	}
	f.state.stateErr = nil
	if _, err := f.svc.Status(ctx, member("u-9"), "wh"); err == nil {
		t.Fatal("stranger's status")
	}

	f.app.reply = strings.Repeat("r", 700)
	res, err := f.svc.SendTest(ctx, member("u-1"), "wh")
	if err != nil || !res.OK || res.Status != 200 || len([]rune(res.Reply)) != 500 {
		t.Fatalf("test: %+v %v", res, err)
	}
	if p := f.app.got[len(f.app.got)-1]; !p.Test || p.User.ID != "u-1" || p.Message.ID != "test" {
		t.Fatalf("test payload = %+v", p)
	}
	f.app.status, f.app.reply = http.StatusUnauthorized, ""
	if res, err := f.svc.SendTest(ctx, member("u-1"), "wh"); err != nil || res.OK || res.Error != "answered 401" || res.Reply != "" {
		t.Fatalf("failed test: %+v %v", res, err)
	}
	if e := f.state.lastEntry("wh"); e.Kind != model.InteractionTest || e.Result != model.InteractionFailed {
		t.Fatalf("history = %+v", e)
	}
	f.wh.SecretVersion = 0
	if _, err := f.svc.SendTest(ctx, member("u-1"), "wh"); !errors.Is(err, apperr.ErrValidation) {
		t.Fatalf("no secret: %v", err)
	}
	if _, err := f.svc.SendTest(ctx, member("u-9"), "wh"); err == nil {
		t.Fatal("stranger's test")
	}
}

func TestSend_BadURLAndBodyCutShort(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	f.wh.InteractivityURL = "http://bad host/"
	if _, _, _, err := f.svc.send(ctx, f.wh, blockActionsPayload{}); err == nil {
		t.Fatal("an unusable URL must fail")
	}
	// A reply that promises more than it sends.
	short := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(100))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("partial"))
	}))
	defer short.Close()
	f.wh.InteractivityURL = short.URL
	if _, status, _, err := f.svc.send(ctx, f.wh, blockActionsPayload{}); err == nil || status != 200 {
		t.Fatalf("cut short: %d %v", status, err)
	}
}

func TestAppSigner(t *testing.T) {
	s := NewAppSigner([]byte("k"))
	first := s.Secret("wh", 1)
	if first != NewAppSigner([]byte("k")).Secret("wh", 1) || first == s.Secret("wh", 2) || first == s.Secret("other", 1) {
		t.Fatal("secrets must be stable per webhook and version")
	}
	if NewAppSigner([]byte("other key")).Secret("wh", 1) == s.Secret("wh", 1) {
		t.Fatal("secrets must depend on the server key")
	}
	wh := &model.IncomingWebhook{ID: "wh", SecretVersion: 1}
	if h := s.SignatureHeader(wh, 1700000000, []byte(`{"a":1}`), time.Now()); !strings.HasPrefix(h, "v0=") || strings.Contains(h, ",") {
		t.Fatalf("header = %q", h)
	}
	if botTokenMatches(&model.IncomingWebhook{}, "x", time.Now()) {
		t.Fatal("no token issued")
	}
}

func TestClick_ARedirectIsTheAppsAnswerAndNotFollowed(t *testing.T) {
	f := newIxFixture(t)
	followed := false
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { followed = true }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	f.wh.InteractivityURL = redirect.URL
	res, err := f.click("u-1")
	if err != nil || !strings.Contains(res.Notice, "didn't respond") || followed {
		t.Fatalf("redirect: %+v %v followed=%v", res, err, followed)
	}
	if e := f.state.lastEntry("wh"); e.Error != "answered 307" {
		t.Fatalf("history = %+v", e)
	}
}

func TestClick_WhoAndWhereWithoutDirectories(t *testing.T) {
	f := newIxFixture(t)
	f.svc.webhooks.users = nil
	conv := appMessage()
	f.messages.messages["ch1#m1"] = conv
	if _, err := f.click("u-1"); err != nil {
		t.Fatalf("click: %v", err)
	}
	if p := f.app.got[0]; p.User.Name != "" || p.User.ID != "u-1" {
		t.Fatalf("user without a directory = %+v", p.User)
	}
	if got := f.svc.parentName(context.Background(), "dm-1", ParentConversation); got != "" {
		t.Fatalf("conversation name = %q", got)
	}
	if got := f.svc.parentName(context.Background(), "gone", ParentChannel); got != "" {
		t.Fatalf("missing channel name = %q", got)
	}
}

func TestInteractionService_ResolvesHostsForReal(t *testing.T) {
	f := newIxFixture(t)
	ips, err := NewInteractionService(f.msgs, f.svc.webhooks, f.state, f.limiter, f.pub, InteractionConfig{}).lookupIP(context.Background(), "localhost")
	if err != nil || len(ips) == 0 {
		t.Fatalf("localhost: %v %v", ips, err)
	}
}

func TestIncomingWebhook_BotTokenGuardsAppButtons(t *testing.T) {
	ctx := context.Background()
	svc, messages := blocksWebhookFixture(nil)
	token, hash := newBotToken()
	wh := svc.store.(*fakeWebhookStore).items["wh"]
	wh.BotTokenHash = hash
	appButton := model.Blocks{{Type: model.BlockActions, Elements: []model.BlockElement{btn("take", "Take it")}}}
	cardButton := []model.MessageAttachment{{Blocks: model.Blocks{{Type: model.BlockSection, Text: plain("t"), Accessory: &model.BlockElement{Type: model.ElementButton, Text: plain("Go")}}}}}

	if _, err := svc.ExecuteMessage(ctx, "wh", IncomingWebhookPayload{Text: "t", Blocks: appButton}); !errors.Is(err, ErrBotTokenRequired) {
		t.Fatalf("app button without a token: %v", err)
	}
	if _, err := svc.ExecuteMessage(ctx, "wh", IncomingWebhookPayload{Text: "t", Attachments: cardButton}); !errors.Is(err, ErrBotTokenRequired) {
		t.Fatalf("app button in a card without a token: %v", err)
	}
	if _, err := svc.ExecuteMessage(ctx, "wh", IncomingWebhookPayload{Text: "t", BotToken: "exb_wrong"}); !errors.Is(err, ErrInvalidBotToken) {
		t.Fatalf("wrong token: %v", err)
	}
	msg, err := svc.ExecuteMessage(ctx, "wh", IncomingWebhookPayload{Text: "t", Blocks: appButton, BotToken: token})
	if err != nil || !messages.messages["ch-1#"+msg.ID].AppButtons {
		t.Fatalf("with the token: %v", err)
	}
	// Links and built-ins need no token, and the message's app buttons stay
	// off without one.
	link := model.BlockElement{Type: model.ElementButton, Text: plain("Open"), URL: "https://ex.test"}
	ack := btn("ack", "Ack")
	ack.ExAction = model.ExActionAck
	plainMsg, err := svc.ExecuteMessage(ctx, "wh", IncomingWebhookPayload{Text: "t", Blocks: model.Blocks{
		{Type: model.BlockSection, Text: plain("s"), Accessory: &link},
		{Type: model.BlockActions, Elements: []model.BlockElement{link, ack}},
	}, Attachments: []model.MessageAttachment{{Text: "card"}}})
	if err != nil || messages.messages["ch-1#"+plainMsg.ID].AppButtons {
		t.Fatalf("no app buttons: %v", err)
	}
}

func TestIncomingWebhook_ListSurfacesStoreErrorsAndPresents(t *testing.T) {
	store := &fakeWebhookStore{items: map[string]*model.IncomingWebhook{"wh": {ID: "wh", CreatedBy: "u-1", BotTokenHash: "h", SecretVersion: 2}}}
	svc := NewIncomingWebhookService(store, fakeWebhookChannels{}, nil, nil, "")
	list, err := svc.List(context.Background(), member("u-1"))
	if err != nil || len(list) != 1 || !list[0].HasBotToken || !list[0].HasSigningSecret {
		t.Fatalf("list: %+v %v", list, err)
	}
	store.listErr = errors.New("dynamo down")
	if _, err := svc.List(context.Background(), member("u-1")); err == nil {
		t.Fatal("store error")
	}
}
