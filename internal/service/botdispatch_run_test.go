package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
)

// The asynchronous half of bot dispatch: running a turn off the send path and
// posting the reply back. Dispatch is detached so it never adds send latency,
// so every assertion here waits for convergence rather than reading immediately.

// recordingBotHandler captures the event it was handed and returns a programmed
// reply. It also signals arrival, so tests wait on a channel instead of sleeping.
type recordingBotHandler struct {
	reply BotReply
	err   error
	owns  bool

	mu     sync.Mutex
	got    BotEvent
	called chan struct{}
}

func newRecordingBotHandler(reply BotReply) *recordingBotHandler {
	return &recordingBotHandler{reply: reply, called: make(chan struct{}, 4)}
}

func (h *recordingBotHandler) OwnsThread(context.Context, string) bool { return h.owns }

func (h *recordingBotHandler) Handle(_ context.Context, ev BotEvent) (BotReply, error) {
	h.mu.Lock()
	h.got = ev
	h.mu.Unlock()
	select {
	case h.called <- struct{}{}:
	default:
	}
	return h.reply, h.err
}

func (h *recordingBotHandler) event(t *testing.T) BotEvent {
	t.Helper()
	select {
	case <-h.called:
	case <-time.After(3 * time.Second):
		t.Fatal("the bot handler was never called")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.got
}

func (h *recordingBotHandler) notCalled(t *testing.T) {
	t.Helper()
	select {
	case <-h.called:
		t.Fatal("the bot handler ran when it should not have")
	case <-time.After(250 * time.Millisecond):
	}
}

// syncMessageStore makes the shared mock safe for the detached dispatch
// goroutine to write to while the test polls it.
type syncMessageStore struct {
	mu sync.Mutex
	*mockMessageStore
}

func (s *syncMessageStore) CreateMessage(ctx context.Context, m *model.Message) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.mockMessageStore.CreateMessage(ctx, m)
}

func (s *syncMessageStore) GetMessage(ctx context.Context, parentID, id string) (*model.Message, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.mockMessageStore.GetMessage(ctx, parentID, id)
}

func (s *syncMessageStore) UpdateMessage(ctx context.Context, m *model.Message) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.mockMessageStore.UpdateMessage(ctx, m)
}

func (s *syncMessageStore) ListMessages(ctx context.Context, parentID, before string, limit int) ([]*model.Message, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.mockMessageStore.ListMessages(ctx, parentID, before, limit)
}

func (s *syncMessageStore) ListThreadReplies(ctx context.Context, rootID string) ([]*model.Message, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.mockMessageStore.ListThreadReplies(ctx, rootID)
}

// snapshot copies the stored messages under the lock.
func (s *syncMessageStore) snapshot() []*model.Message {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*model.Message, 0, len(s.messages))
	for _, m := range s.messages {
		copied := *m
		out = append(out, &copied)
	}
	return out
}

// dispatchEnv is a MessageService with an accessible channel and a registered
// in-process bot.
type dispatchEnv struct {
	svc       *MessageService
	messages  *syncMessageStore
	publisher *mockPublisher
	handler   *recordingBotHandler
}

func setupDispatch(t *testing.T, reply BotReply) *dispatchEnv {
	t.Helper()
	messages := &syncMessageStore{mockMessageStore: newMockMessageStore()}
	memberships := newMockMembershipStore()
	publisher := newMockPublisher()
	svc := NewMessageService(messages, memberships, newMockConversationStore(), publisher, newMockBroker())
	svc.SetParentIndex(newMockParentIndex())
	if err := memberships.AddMember(context.Background(),
		&model.ChannelMembership{ChannelID: "ch1", UserID: "u1"}, &model.UserChannel{}); err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	handler := newRecordingBotHandler(reply)
	svc.RegisterBot(BotConfig{
		UserID: "bot_cliffy", Handle: "cliffy", Username: "Cliffy", IconEmoji: "robot", Handler: handler,
	})
	return &dispatchEnv{svc: svc, messages: messages, publisher: publisher, handler: handler}
}

// waitForDispatchIdle blocks until no dispatch turn is in flight, by taking every
// slot of the package-wide concurrency semaphore — a slot is only released when a
// turn's goroutine exits. That makes it a real completion barrier: after it
// returns, nothing is still mutating the messages the turn posted, so the
// assertions below read a settled store rather than racing the writer.
func waitForDispatchIdle(t *testing.T) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	held := 0
	defer func() {
		for i := 0; i < held; i++ {
			<-botDispatchSem
		}
	}()
	for held < botDispatchMaxConcurrent {
		select {
		case botDispatchSem <- struct{}{}:
			held++
		case <-deadline:
			t.Fatal("a bot dispatch turn never finished")
		}
	}
}

// waitForBotMessage waits for dispatch to settle, then returns the bot's post.
func (e *dispatchEnv) waitForBotMessage(t *testing.T) *model.Message {
	t.Helper()
	waitForDispatchIdle(t)
	for _, m := range e.messages.snapshot() {
		if m.AuthorID == "bot_cliffy" {
			return m
		}
	}
	t.Fatal("the bot never posted a reply")
	return nil
}

func (e *dispatchEnv) assertNoBotMessage(t *testing.T) {
	t.Helper()
	waitForDispatchIdle(t)
	for _, m := range e.messages.snapshot() {
		if m.AuthorID == "bot_cliffy" {
			t.Fatalf("the bot posted %q when it should have stayed silent", m.Body)
		}
	}
}

func humanMessage(id, body string) *model.Message {
	return &model.Message{ID: id, ParentID: "ch1", AuthorID: "u1", Body: body, CreatedAt: time.Now()}
}

func TestMaybeDispatchToBots_PostsReplyAsTheBot(t *testing.T) {
	env := setupDispatch(t, BotReply{Text: "on it"})
	msg := humanMessage("m1", "@cliffy make a task")
	if err := env.messages.CreateMessage(context.Background(), msg); err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	env.svc.maybeDispatchToBots(context.Background(), msg, ParentChannel)

	ev := env.handler.event(t)
	if ev.BotUserID != "bot_cliffy" || ev.AskerID != "u1" || ev.ParentID != "ch1" ||
		ev.MessageID != "m1" || ev.Prompt != "make a task" || ev.RootMessageID != "m1" {
		t.Errorf("event = %+v, want the mention-stripped prompt and the asker", ev)
	}

	reply := env.waitForBotMessage(t)
	if reply.Body != "on it" {
		t.Errorf("reply body = %q", reply.Body)
	}
	// Threaded under the message that addressed it, and rendered with the bot's
	// registered identity.
	if reply.ParentMessageID != "m1" {
		t.Errorf("ParentMessageID = %q, want the thread root", reply.ParentMessageID)
	}
	if reply.WebhookUsername != "Cliffy" || reply.WebhookIconEmoji != "robot" {
		t.Errorf("identity = %q/%q, want the bot's registered display", reply.WebhookUsername, reply.WebhookIconEmoji)
	}
}

// A reply may override the display identity for one post (MM's response fields),
// but the AUTHOR is always the bot itself.
func TestMaybeDispatchToBots_ReplyIdentityOverrides(t *testing.T) {
	env := setupDispatch(t, BotReply{
		Text: "deployed", Username: "Deploy Bot", IconURL: "https://cdn.example.com/d.png",
	})
	msg := humanMessage("m1", "@cliffy deploy")
	if err := env.messages.CreateMessage(context.Background(), msg); err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	env.svc.maybeDispatchToBots(context.Background(), msg, ParentChannel)

	reply := env.waitForBotMessage(t)
	if reply.AuthorID != "bot_cliffy" {
		t.Errorf("AuthorID = %q, want the bot regardless of the override", reply.AuthorID)
	}
	if reply.WebhookUsername != "Deploy Bot" || reply.WebhookAvatarURL != "https://cdn.example.com/d.png" {
		t.Errorf("override not applied: %q/%q", reply.WebhookUsername, reply.WebhookAvatarURL)
	}
	// An icon_url override replaces the emoji rather than rendering both.
	if reply.WebhookIconEmoji != "" {
		t.Errorf("IconEmoji = %q, want it cleared by the icon_url override", reply.WebhookIconEmoji)
	}
}

func TestMaybeDispatchToBots_AttachmentsAndActions(t *testing.T) {
	env := setupDispatch(t, BotReply{
		Attachments: []model.MessageAttachment{{
			Text: "PR #12",
			Actions: []model.MessageAction{{
				Name: "Approve", Integration: &model.ActionIntegration{URL: "https://hooks.example.com/act"},
			}},
		}},
	})
	msg := humanMessage("m1", "@cliffy review")
	if err := env.messages.CreateMessage(context.Background(), msg); err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	env.svc.maybeDispatchToBots(context.Background(), msg, ParentChannel)

	reply := env.waitForBotMessage(t)
	if len(reply.MessageAttachments) != 1 {
		t.Fatalf("attachments = %+v", reply.MessageAttachments)
	}
	// Actions go through PrepareActions on the way out, so the id is minted.
	actions := reply.MessageAttachments[0].Actions
	if len(actions) != 1 || actions[0].ID == "" {
		t.Errorf("actions = %+v, want a prepared action with an id", actions)
	}
}

func TestMaybeDispatchToBots_HandlerFailurePostsAnApology(t *testing.T) {
	// A silent failure would look like the bot ignored the person.
	env := setupDispatch(t, BotReply{})
	env.handler.err = errors.New("agent exploded")
	msg := humanMessage("m1", "@cliffy hello")
	if err := env.messages.CreateMessage(context.Background(), msg); err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	env.svc.maybeDispatchToBots(context.Background(), msg, ParentChannel)

	reply := env.waitForBotMessage(t)
	if !strings.Contains(reply.Body, "couldn't respond") {
		t.Errorf("reply = %q, want a user-facing apology", reply.Body)
	}
}

func TestMaybeDispatchToBots_SilentCases(t *testing.T) {
	t.Run("an empty reply posts nothing", func(t *testing.T) {
		env := setupDispatch(t, BotReply{Text: "   "})
		msg := humanMessage("m1", "@cliffy hi")
		if err := env.messages.CreateMessage(context.Background(), msg); err != nil {
			t.Fatalf("CreateMessage: %v", err)
		}
		env.svc.maybeDispatchToBots(context.Background(), msg, ParentChannel)
		env.handler.event(t)
		env.assertNoBotMessage(t)
	})

	t.Run("an ephemeral reply is dropped, not broadcast", func(t *testing.T) {
		// It was addressed to the asker alone; a channel post is the opposite.
		env := setupDispatch(t, BotReply{Text: "only for you", Ephemeral: true})
		msg := humanMessage("m1", "@cliffy hi")
		if err := env.messages.CreateMessage(context.Background(), msg); err != nil {
			t.Fatalf("CreateMessage: %v", err)
		}
		env.svc.maybeDispatchToBots(context.Background(), msg, ParentChannel)
		env.handler.event(t)
		env.assertNoBotMessage(t)
	})

	t.Run("nothing addressed to a bot never runs a turn", func(t *testing.T) {
		env := setupDispatch(t, BotReply{Text: "hi"})
		msg := humanMessage("m1", "just talking to the team")
		env.svc.maybeDispatchToBots(context.Background(), msg, ParentChannel)
		env.handler.notCalled(t)
	})

	t.Run("an asker with no access cannot make the bot speak", func(t *testing.T) {
		// postBotReply access-checks the asker, so a bot can't be driven to post
		// where the person addressing it cannot.
		env := setupDispatch(t, BotReply{Text: "on it"})
		msg := humanMessage("m1", "@cliffy hi")
		msg.AuthorID = "stranger"
		if err := env.messages.CreateMessage(context.Background(), msg); err != nil {
			t.Fatalf("CreateMessage: %v", err)
		}
		env.svc.maybeDispatchToBots(context.Background(), msg, ParentChannel)
		env.handler.event(t)
		env.assertNoBotMessage(t)
	})
}

func TestMaybeDispatchToBots_ThreadContinuation(t *testing.T) {
	t.Run("a reply in a thread the bot owns reaches it without a mention", func(t *testing.T) {
		env := setupDispatch(t, BotReply{Text: "still here"})
		env.handler.owns = true
		msg := humanMessage("m2", "yes, do it")
		msg.ParentMessageID = "root1"
		if err := env.messages.CreateMessage(context.Background(), msg); err != nil {
			t.Fatalf("CreateMessage: %v", err)
		}
		env.svc.maybeDispatchToBots(context.Background(), msg, ParentChannel)

		ev := env.handler.event(t)
		if ev.Prompt != "yes, do it" || ev.RootMessageID != "root1" {
			t.Errorf("event = %+v, want the raw text under the thread root", ev)
		}
	})

	t.Run("a reply in a thread no bot owns runs nothing", func(t *testing.T) {
		env := setupDispatch(t, BotReply{Text: "hi"})
		env.handler.owns = false
		msg := humanMessage("m2", "unrelated chatter")
		msg.ParentMessageID = "root1"
		env.svc.maybeDispatchToBots(context.Background(), msg, ParentChannel)
		env.handler.notCalled(t)
	})
}

// A bare mention still gives the handler something to act on.
func TestMaybeDispatchToBots_BareMentionGetsAPrompt(t *testing.T) {
	env := setupDispatch(t, BotReply{Text: "hello"})
	msg := humanMessage("m1", "@cliffy")
	if err := env.messages.CreateMessage(context.Background(), msg); err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	env.svc.maybeDispatchToBots(context.Background(), msg, ParentChannel)
	if ev := env.handler.event(t); ev.Prompt != bareMentionPrompt {
		t.Errorf("Prompt = %q, want the bare-mention stand-in", ev.Prompt)
	}
}

// An external bot the directory no longer resolves must not dispatch — this is
// what makes a retired bot fail closed.
func TestMaybeDispatchToBots_UnresolvableExternalBot(t *testing.T) {
	env := setupDispatch(t, BotReply{Text: "hi"})
	svc, messages := env.svc, env.messages
	svc.SetBotDirectory(fakeBotDir{known: map[string]BotWebhookTarget{}})
	msg := humanMessage("m1", "@[bot_gone|Helper] status?")
	if err := messages.CreateMessage(context.Background(), msg); err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	svc.maybeDispatchToBots(context.Background(), msg, ParentChannel)

	waitForDispatchIdle(t)
	if got := len(messages.snapshot()); got != 1 {
		t.Errorf("messages = %d, want only the original — a retired bot must not reply", got)
	}
}

// The dispatcher is bounded: beyond the concurrency cap events are dropped with a
// warning rather than piling up goroutines that each hold an LLM call.
func TestMaybeDispatchToBots_ConcurrencyCap(t *testing.T) {
	for i := 0; i < botDispatchMaxConcurrent; i++ {
		botDispatchSem <- struct{}{}
	}
	t.Cleanup(func() {
		for i := 0; i < botDispatchMaxConcurrent; i++ {
			<-botDispatchSem
		}
	})

	env := setupDispatch(t, BotReply{Text: "hi"})
	msg := humanMessage("m1", "@cliffy hi")
	env.svc.maybeDispatchToBots(context.Background(), msg, ParentChannel)
	env.handler.notCalled(t)
}

// "<Bot> is typing…" is broadcast while the turn runs and refreshed until it
// finishes (the client indicator expires after a few seconds).
func TestBotTyping(t *testing.T) {
	svc, _, _, _, publisher := setupMessageService()
	cfg := BotConfig{UserID: "bot_cliffy", Username: "Cliffy"}

	stop := svc.botTyping(context.Background(), cfg, "ch1", ParentChannel, "root1")
	stop()
	stop() // idempotent: the caller may stop on both the success and error paths

	publisher.mu.Lock()
	defer publisher.mu.Unlock()
	var typing *events.Event
	for _, p := range publisher.published {
		if p.event != nil && p.event.Type == events.EventTyping {
			typing = p.event
		}
	}
	if typing == nil {
		t.Fatal("no typing event was published")
	}
	var payload map[string]any
	if err := json.Unmarshal(typing.Data, &payload); err != nil {
		t.Fatalf("decode typing payload: %v", err)
	}
	if payload["userID"] != "bot_cliffy" || payload["parentMessageID"] != "root1" {
		t.Errorf("payload = %+v, want the bot at the thread level", payload)
	}
}

// Without a publisher there is nothing to broadcast to; stopping must still be safe.
func TestBotTyping_NoPublisher(t *testing.T) {
	svc := &MessageService{}
	stop := svc.botTyping(context.Background(), BotConfig{UserID: "bot_x"}, "ch1", ParentChannel, "")
	stop()
}

func TestBotThreadHistory(t *testing.T) {
	ctx := context.Background()

	t.Run("builds roles from authorship and excludes the current message", func(t *testing.T) {
		env := setupDispatch(t, BotReply{Text: "hi"})
		seed := []*model.Message{
			{ID: "root1", ParentID: "ch1", AuthorID: "u1", Body: "first question", CreatedAt: time.Now()},
			{ID: "r1", ParentID: "ch1", AuthorID: "bot_cliffy", Body: "an answer", ParentMessageID: "root1", CreatedAt: time.Now()},
			{ID: "r2", ParentID: "ch1", AuthorID: "u1", Body: "follow-up", ParentMessageID: "root1", CreatedAt: time.Now()},
			// Excluded: system noise and the message being handled right now.
			{ID: "r3", ParentID: "ch1", AuthorID: "u1", Body: "joined", ParentMessageID: "root1", System: true, CreatedAt: time.Now()},
			{ID: "current", ParentID: "ch1", AuthorID: "u1", Body: "the new one", ParentMessageID: "root1", CreatedAt: time.Now()},
			{ID: "blank", ParentID: "ch1", AuthorID: "u1", Body: "   ", ParentMessageID: "root1", CreatedAt: time.Now()},
		}
		for _, m := range seed {
			if err := env.messages.CreateMessage(ctx, m); err != nil {
				t.Fatalf("CreateMessage: %v", err)
			}
		}

		history := env.svc.botThreadHistory(ctx, "bot_cliffy", "u1", "ch1", ParentChannel, "root1", "current")
		var texts []string
		for _, h := range history {
			texts = append(texts, h.Role+":"+h.Text)
		}
		joined := strings.Join(texts, "|")
		if !strings.Contains(joined, "assistant:an answer") {
			t.Errorf("history = %v, want the bot's turn marked assistant", texts)
		}
		if !strings.Contains(joined, "user:follow-up") {
			t.Errorf("history = %v, want the human's turn marked user", texts)
		}
		for _, unwanted := range []string{"the new one", "joined"} {
			if strings.Contains(joined, unwanted) {
				t.Errorf("history = %v, must exclude %q", texts, unwanted)
			}
		}
	})

	t.Run("no thread root yields no history", func(t *testing.T) {
		env := setupDispatch(t, BotReply{Text: "hi"})
		if got := env.svc.botThreadHistory(ctx, "bot_cliffy", "u1", "ch1", ParentChannel, "", "m1"); got != nil {
			t.Errorf("history = %v, want nil", got)
		}
	})

	t.Run("an unreadable thread yields no history", func(t *testing.T) {
		// Continuity is a nicety; losing it must not fail the turn.
		env := setupDispatch(t, BotReply{Text: "hi"})
		if got := env.svc.botThreadHistory(ctx, "bot_cliffy", "stranger", "ch1", ParentChannel, "root1", "m1"); got != nil {
			t.Errorf("history = %v, want nil for a chat the asker can't read", got)
		}
	})

	t.Run("history is bounded", func(t *testing.T) {
		env := setupDispatch(t, BotReply{Text: "hi"})
		if err := env.messages.CreateMessage(ctx,
			&model.Message{ID: "root2", ParentID: "ch1", AuthorID: "u1", Body: "start", CreatedAt: time.Now()}); err != nil {
			t.Fatalf("CreateMessage: %v", err)
		}
		for i := 0; i < 40; i++ {
			if err := env.messages.CreateMessage(ctx, &model.Message{
				ID:       "h" + string(rune('a'+i%26)) + string(rune('a'+i/26)),
				ParentID: "ch1", AuthorID: "u1", Body: "turn", ParentMessageID: "root2", CreatedAt: time.Now(),
			}); err != nil {
				t.Fatalf("CreateMessage: %v", err)
			}
		}
		history := env.svc.botThreadHistory(ctx, "bot_cliffy", "u1", "ch1", ParentChannel, "root2", "none")
		if len(history) > 24 {
			t.Errorf("history = %d turns, want it capped", len(history))
		}
	})
}

// The indicator is re-broadcast while the turn runs, so it doesn't lapse on the
// client mid-answer.
func TestBotTyping_RefreshesUntilStopped(t *testing.T) {
	orig := botTypingRefreshInterval
	botTypingRefreshInterval = 5 * time.Millisecond
	t.Cleanup(func() { botTypingRefreshInterval = orig })

	svc, _, _, _, publisher := setupMessageService()
	stop := svc.botTyping(context.Background(), BotConfig{UserID: "bot_cliffy"}, "ch1", ParentChannel, "")

	count := func() int {
		publisher.mu.Lock()
		defer publisher.mu.Unlock()
		n := 0
		for _, p := range publisher.published {
			if p.event != nil && p.event.Type == events.EventTyping {
				n++
			}
		}
		return n
	}
	deadline := time.Now().Add(3 * time.Second)
	for count() < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	stop()
	if got := count(); got < 2 {
		t.Errorf("typing events = %d, want the indicator refreshed at least once", got)
	}
}

// A cancelled context stops the refresh loop even if the caller never does.
func TestBotTyping_StopsOnContextCancel(t *testing.T) {
	orig := botTypingRefreshInterval
	botTypingRefreshInterval = 5 * time.Millisecond
	t.Cleanup(func() { botTypingRefreshInterval = orig })

	svc, _, _, _, _ := setupMessageService()
	ctx, cancel := context.WithCancel(context.Background())
	stop := svc.botTyping(ctx, BotConfig{UserID: "bot_cliffy"}, "ch1", ParentChannel, "")
	cancel()
	time.Sleep(30 * time.Millisecond)
	stop()
}

// An external (outgoing-webhook) bot runs over HTTP through the same dispatch
// path, and a trigger-word invocation passes the message verbatim.
func TestMaybeDispatchToBots_ExternalWebhookBot(t *testing.T) {
	useLoopbackWebhookClient(t)
	var gotText, gotTrigger string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		gotText, gotTrigger = r.PostForm.Get("text"), r.PostForm.Get("trigger_word")
		_ = json.NewEncoder(w).Encode(map[string]string{"text": "deploying now"})
	}))
	defer srv.Close()

	env := setupDispatch(t, BotReply{})
	env.svc.SetBotDirectory(fakeBotDir{known: map[string]BotWebhookTarget{
		"bot_ext": {URL: srv.URL, Secret: "mm-token", Name: "Deployer", Transport: model.BotTransportMattermost},
	}})
	env.svc.SetBotTriggerIndex(fakeTriggerIndex{words: map[string]triggerEntry{
		"deploy": {botUserID: "bot_ext", when: model.BotTriggerWhenStartsWith},
	}})

	msg := humanMessage("m1", "deploy web to prod")
	if err := env.messages.CreateMessage(context.Background(), msg); err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	env.svc.maybeDispatchToBots(context.Background(), msg, ParentChannel)
	waitForDispatchIdle(t)

	// MM's contract sends the full text alongside trigger_word; receivers parse
	// their arguments out of it.
	if gotText != "deploy web to prod" || gotTrigger != "deploy" {
		t.Errorf("payload text=%q trigger=%q, want the verbatim message", gotText, gotTrigger)
	}
	var posted *model.Message
	for _, m := range env.messages.snapshot() {
		if m.AuthorID == "bot_ext" {
			posted = m
		}
	}
	if posted == nil || posted.Body != "deploying now" {
		t.Fatalf("posted = %+v, want the external bot's reply", posted)
	}
	if posted.WebhookUsername != "Deployer" {
		t.Errorf("username = %q, want the directory's name", posted.WebhookUsername)
	}
}

// A bracket-mention of an external bot strips the mention from the prompt, where a
// trigger-word invocation passes the message verbatim (covered above).
func TestMaybeDispatchToBots_ExternalBracketMentionStripsTheMention(t *testing.T) {
	useLoopbackWebhookClient(t)
	var gotText string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Text string `json:"text"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		gotText = in.Text
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	env := setupDispatch(t, BotReply{})
	env.svc.SetBotDirectory(fakeBotDir{known: map[string]BotWebhookTarget{
		"bot_ext": {URL: srv.URL, Name: "Helper"},
	}})

	msg := humanMessage("m1", "@[bot_ext|Helper] status please")
	if err := env.messages.CreateMessage(context.Background(), msg); err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	env.svc.maybeDispatchToBots(context.Background(), msg, ParentChannel)
	waitForDispatchIdle(t)

	if gotText != "status please" {
		t.Errorf("text = %q, want the mention stripped", gotText)
	}
}
