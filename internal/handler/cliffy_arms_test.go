package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// The Cliffy HTTP surface: session, revoke, the caller/limiter/bridge-error
// helpers, and the transcript enrichment that gives the agent channel context.

func cliffyRequest(method, path, body string, userID, email string) *http.Request {
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, path, nil)
	} else {
		req = httptest.NewRequest(method, path, strings.NewReader(body))
	}
	if userID != "" || email != "" {
		req = req.WithContext(middleware.ContextWithClaims(req.Context(),
			&model.TokenClaims{UserID: userID, Email: email}))
	}
	return req
}

// --- caller ---------------------------------------------------------------

// Cliffy acts as the signed-in user, so it needs both an id and an email (the
// bridge mints by email). Missing either means it cannot act for them.
func TestCliffyCaller_RequiresIdentityAndEmail(t *testing.T) {
	h := &CliffyHandler{}
	for _, tc := range []struct{ userID, email string }{
		{"", ""},
		{"u1", ""},
		{"", "u1@example.com"},
	} {
		rec := httptest.NewRecorder()
		req := cliffyRequest(http.MethodPost, "/api/v1/cliffy/session", "", tc.userID, tc.email)
		if _, _, ok := h.caller(rec, req); ok {
			t.Errorf("caller(%q, %q) = ok, want a refusal", tc.userID, tc.email)
		}
		if rec.Code != http.StatusForbidden {
			t.Errorf("status = %d, want 403", rec.Code)
		}
	}

	rec := httptest.NewRecorder()
	req := cliffyRequest(http.MethodPost, "/api/v1/cliffy/session", "", "u1", "u1@example.com")
	userID, email, ok := h.caller(rec, req)
	if !ok || userID != "u1" || email != "u1@example.com" {
		t.Errorf("caller = (%q, %q, %v), want the resolved identity", userID, email, ok)
	}
}

// --- allow ----------------------------------------------------------------

func TestCliffyAllow(t *testing.T) {
	req := cliffyRequest(http.MethodPost, "/x", "", "u1", "u1@example.com")

	t.Run("no limiter allows", func(t *testing.T) {
		if !(&CliffyHandler{}).allow(httptest.NewRecorder(), req, "k", 1, time.Minute) {
			t.Error("want allowed with no limiter")
		}
	})

	t.Run("a limiter error fails open", func(t *testing.T) {
		// A Redis blip must not take Cliffy down entirely.
		h := &CliffyHandler{limiter: fakeLimiter{allow: false, err: errors.New("redis down")}}
		if !h.allow(httptest.NewRecorder(), req, "k", 1, time.Minute) {
			t.Error("want allowed when the limiter errors")
		}
	})

	t.Run("over budget writes 429", func(t *testing.T) {
		h := &CliffyHandler{limiter: fakeLimiter{allow: false}}
		rec := httptest.NewRecorder()
		if h.allow(rec, req, "k", 1, time.Minute) {
			t.Error("want blocked when over budget")
		}
		if rec.Code != http.StatusTooManyRequests {
			t.Errorf("status = %d, want 429", rec.Code)
		}
	})

	t.Run("within budget allows", func(t *testing.T) {
		h := &CliffyHandler{limiter: fakeLimiter{allow: true}}
		if !h.allow(httptest.NewRecorder(), req, "k", 1, time.Minute) {
			t.Error("want allowed")
		}
	})
}

// --- writeBridgeError -----------------------------------------------------

func TestWriteBridgeError(t *testing.T) {
	h := &CliffyHandler{}

	if rec := httptest.NewRecorder(); h.writeBridgeError(rec, nil) {
		t.Error("a nil error should write nothing and let the caller continue")
	}

	// No CliffHub account is definitive (403), anything else is transient (502) —
	// the client shows a different message for each.
	rec := httptest.NewRecorder()
	if !h.writeBridgeError(rec, service.ErrCliffyNoAccount) {
		t.Error("want a response written")
	}
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", rec.Code)
	}

	rec = httptest.NewRecorder()
	if !h.writeBridgeError(rec, errors.New("mint exploded")) {
		t.Error("want a response written")
	}
	if rec.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", rec.Code)
	}
}

// --- CreateSession --------------------------------------------------------

func TestCreateSession(t *testing.T) {
	t.Run("reports availability and expiry without the token", func(t *testing.T) {
		env := setupCliffyTurn(t, &stubAgent{})
		env.handler.webBase = "https://cliffhub.example"
		rec := httptest.NewRecorder()
		env.handler.CreateSession(rec, cliffyRequest(http.MethodPost, "/api/v1/cliffy/session", "", "u1", "u1@example.com"))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
		}
		var got map[string]any
		if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		if got["ok"] != true || got["expires_at"] == nil {
			t.Errorf("body = %+v, want ok + expiry", got)
		}
		if got["cliffhub_base"] != "https://cliffhub.example" {
			t.Errorf("cliffhub_base = %v", got["cliffhub_base"])
		}
		// The bridged token must never leave ex's backend.
		if strings.Contains(rec.Body.String(), "minted-tok") {
			t.Error("the response leaked the bridged CliffHub token")
		}
	})

	t.Run("an unlinked account is a 403", func(t *testing.T) {
		env := setupCliffyTurn(t, &stubAgent{mintStatus: http.StatusForbidden})
		rec := httptest.NewRecorder()
		env.handler.CreateSession(rec, cliffyRequest(http.MethodPost, "/x", "", "u1", "u1@example.com"))
		if rec.Code != http.StatusForbidden {
			t.Errorf("status = %d, want 403", rec.Code)
		}
	})

	t.Run("an unauthenticated caller is refused", func(t *testing.T) {
		env := setupCliffyTurn(t, &stubAgent{})
		rec := httptest.NewRecorder()
		env.handler.CreateSession(rec, cliffyRequest(http.MethodPost, "/x", "", "", ""))
		if rec.Code != http.StatusForbidden {
			t.Errorf("status = %d, want 403", rec.Code)
		}
	})
}

// --- Revoke ---------------------------------------------------------------

// Revoke is best-effort: ex logout must succeed even when CliffHub can't be
// reached, so it always answers 200.
func TestRevoke(t *testing.T) {
	t.Run("succeeds for a signed-in caller", func(t *testing.T) {
		env := setupCliffyTurn(t, &stubAgent{})
		rec := httptest.NewRecorder()
		env.handler.Revoke(rec, cliffyRequest(http.MethodPost, "/x", "", "u1", "u1@example.com"))
		if rec.Code != http.StatusOK {
			t.Errorf("status = %d, want 200", rec.Code)
		}
	})

	t.Run("a failing revoke still answers 200", func(t *testing.T) {
		env := setupCliffyTurn(t, &stubAgent{})
		env.srv.Close() // CliffHub unreachable
		rec := httptest.NewRecorder()
		env.handler.Revoke(rec, cliffyRequest(http.MethodPost, "/x", "", "u1", "u1@example.com"))
		if rec.Code != http.StatusOK {
			t.Errorf("status = %d, want 200 — logout must not be blocked", rec.Code)
		}
	})

	t.Run("no caller is a no-op", func(t *testing.T) {
		env := setupCliffyTurn(t, &stubAgent{})
		rec := httptest.NewRecorder()
		env.handler.Revoke(rec, cliffyRequest(http.MethodPost, "/x", "", "", ""))
		if rec.Code != http.StatusOK {
			t.Errorf("status = %d, want 200", rec.Code)
		}
	})
}

// --- buildTranscript / enrichWithTranscript -------------------------------

// fakeConvReader lists a fixed set of messages.
type fakeConvReader struct {
	msgs []*model.Message
	err  error
}

func (f fakeConvReader) List(context.Context, string, string, string, string, int) ([]*model.Message, bool, error) {
	return f.msgs, false, f.err
}

func TestBuildTranscript(t *testing.T) {
	ctx := context.Background()

	t.Run("no reader yields nothing", func(t *testing.T) {
		if got := (&CliffyHandler{}).buildTranscript(ctx, "u1", service.ParentChannel, "ch1"); got != nil {
			t.Errorf("got %+v, want nil", got)
		}
	})

	t.Run("a list failure or empty scope yields nothing", func(t *testing.T) {
		h := &CliffyHandler{convReader: fakeConvReader{err: errors.New("boom")}}
		if got := h.buildTranscript(ctx, "u1", service.ParentChannel, "ch1"); got != nil {
			t.Errorf("got %+v, want nil on error", got)
		}
		h = &CliffyHandler{convReader: fakeConvReader{}}
		if got := h.buildTranscript(ctx, "u1", service.ParentChannel, "ch1"); got != nil {
			t.Errorf("got %+v, want nil for an empty scope", got)
		}
	})

	t.Run("resolves names, orders oldest-first, and skips noise", func(t *testing.T) {
		// List is newest-first, so the transcript must be reversed for the agent.
		h := &CliffyHandler{
			convReader: fakeConvReader{msgs: []*model.Message{
				{ID: "m4", AuthorID: "u2", Body: "newest"},
				{ID: "m3", AuthorID: "", Body: "from a webhook", WebhookUsername: "Build Bot"},
				{ID: "m2", AuthorID: "u9", Body: "unknown author"},
				{ID: "m1", AuthorID: "u1", Body: "oldest"},
				// Skipped: system events and blank bodies carry no meaning.
				{ID: "s1", AuthorID: "u1", Body: "joined", System: true},
				{ID: "s2", AuthorID: "u1", Body: "   "},
			}},
			users: fakeCliffyNames{"u1": "Anna", "u2": "Bo"},
		}
		got := h.buildTranscript(ctx, "u1", service.ParentChannel, "ch1")
		if len(got) != 4 {
			t.Fatalf("got %d entries, want 4: %+v", len(got), got)
		}
		if got[0]["text"] != "oldest" || got[3]["text"] != "newest" {
			t.Errorf("order = %+v, want oldest-first", got)
		}
		if got[0]["author"] != "Anna" || got[3]["author"] != "Bo" {
			t.Errorf("authors = %q/%q, want resolved names", got[0]["author"], got[3]["author"])
		}
		// A webhook post uses its display name; an unresolvable author is anonymous.
		if got[2]["author"] != "Build Bot" {
			t.Errorf("webhook author = %q", got[2]["author"])
		}
		if got[1]["author"] != "Someone" {
			t.Errorf("unknown author = %q, want the anonymous fallback", got[1]["author"])
		}
	})

	t.Run("long messages are truncated by runes, not bytes", func(t *testing.T) {
		// Byte-slicing would split a multi-byte glyph into invalid UTF-8.
		long := strings.Repeat("é", cliffyTranscriptMsgChars+50)
		h := &CliffyHandler{convReader: fakeConvReader{msgs: []*model.Message{
			{ID: "m1", AuthorID: "u1", Body: long},
		}}}
		got := h.buildTranscript(ctx, "u1", service.ParentChannel, "ch1")
		if len(got) != 1 {
			t.Fatalf("got %+v", got)
		}
		text := got[0]["text"]
		if !strings.HasSuffix(text, "…") {
			t.Errorf("text = %q, want an ellipsis", text)
		}
		if !utf8ValidString(text) {
			t.Error("truncation produced invalid UTF-8")
		}
	})

	t.Run("a name lookup failure falls back to anonymous", func(t *testing.T) {
		h := &CliffyHandler{
			convReader: fakeConvReader{msgs: []*model.Message{{ID: "m1", AuthorID: "u1", Body: "hi"}}},
			users:      failingCliffyUsers{},
		}
		got := h.buildTranscript(ctx, "u1", service.ParentChannel, "ch1")
		if len(got) != 1 || got[0]["author"] != "Someone" {
			t.Errorf("got %+v, want the anonymous fallback", got)
		}
	})
}

// fakeCliffyNames resolves ex user ids to display names.
type fakeCliffyNames map[string]string

func (f fakeCliffyNames) GetUsers(_ context.Context, ids []string) (map[string]*model.User, error) {
	out := map[string]*model.User{}
	for _, id := range ids {
		if name, ok := f[id]; ok {
			out[id] = &model.User{ID: id, DisplayName: name}
		}
	}
	return out, nil
}

func TestEnrichWithTranscript(t *testing.T) {
	ctx := context.Background()
	reader := fakeConvReader{msgs: []*model.Message{{ID: "m1", AuthorID: "u1", Body: "hello there"}}}

	t.Run("injects the transcript into the agent context", func(t *testing.T) {
		h := &CliffyHandler{convReader: reader, users: fakeCliffyNames{"u1": "Anna"}}
		body := []byte(`{"messages":[],"context":{"scope":{"type":"channel","id":"ch1"}}}`)
		out := h.enrichWithTranscript(ctx, "u1", body)

		var parsed struct {
			Context struct {
				Messages []map[string]string `json:"messages"`
			} `json:"context"`
		}
		if err := json.Unmarshal(out, &parsed); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if len(parsed.Context.Messages) != 1 || parsed.Context.Messages[0]["author"] != "Anna" {
			t.Errorf("context.messages = %+v, want the transcript", parsed.Context.Messages)
		}
	})

	t.Run("returns the body unchanged when there is nothing to add", func(t *testing.T) {
		// Every one of these must be safe: enrichment is best-effort context.
		cases := map[string][]byte{
			"no reader":         []byte(`{"context":{"scope":{"type":"channel","id":"ch1"}}}`),
			"unparsable body":   []byte(`not json`),
			"no context object": []byte(`{"messages":[]}`),
			"no scope":          []byte(`{"context":{}}`),
			"blank scope id":    []byte(`{"context":{"scope":{"type":"channel","id":""}}}`),
			"bad scope type":    []byte(`{"context":{"scope":{"type":"team","id":"t1"}}}`),
			"empty transcript":  []byte(`{"context":{"scope":{"type":"channel","id":"ch1"}}}`),
		}
		for name, body := range cases {
			h := &CliffyHandler{convReader: reader}
			switch name {
			case "no reader":
				h.convReader = nil
			case "empty transcript":
				h.convReader = fakeConvReader{}
			}
			if got := string(h.enrichWithTranscript(ctx, "u1", body)); got != string(body) {
				t.Errorf("%s: body changed to %s", name, got)
			}
		}
	})
}

// --- Chat / ProxyAPI remaining arms ---------------------------------------

func TestChat_UnreadableBodyAndUpstreamFailure(t *testing.T) {
	t.Run("an unreachable agent is a 502", func(t *testing.T) {
		env := setupCliffyTurn(t, &stubAgent{})
		agentURL := env.handler.agentURL
		env.srv.Close()
		env.handler.agentURL = agentURL
		rec := httptest.NewRecorder()
		env.handler.Chat(rec, cliffyRequest(http.MethodPost, "/x", `{"messages":[]}`, "u1", "u1@example.com"))
		if rec.Code != http.StatusBadGateway {
			t.Errorf("status = %d, want 502", rec.Code)
		}
	})

	t.Run("an unbuildable agent URL is a 502", func(t *testing.T) {
		env := setupCliffyTurn(t, &stubAgent{})
		env.handler.agentURL = "http://exa mple.com/\x7f"
		rec := httptest.NewRecorder()
		env.handler.Chat(rec, cliffyRequest(http.MethodPost, "/x", `{"messages":[]}`, "u1", "u1@example.com"))
		if rec.Code != http.StatusBadGateway {
			t.Errorf("status = %d, want 502", rec.Code)
		}
	})

	t.Run("the per-day budget is enforced separately", func(t *testing.T) {
		// Two dimensions: per-minute and per-day. The daily cap stands in for real
		// token accounting on the agent loop.
		env := setupCliffyTurn(t, &stubAgent{})
		env.handler.limiter = dayOnlyLimiter{}
		rec := httptest.NewRecorder()
		env.handler.Chat(rec, cliffyRequest(http.MethodPost, "/x", `{"messages":[]}`, "u1", "u1@example.com"))
		if rec.Code != http.StatusTooManyRequests {
			t.Errorf("status = %d, want 429 from the daily cap", rec.Code)
		}
	})
}

// dayOnlyLimiter allows the per-minute key and blocks the per-day one.
type dayOnlyLimiter struct{}

func (dayOnlyLimiter) AllowRequest(_ context.Context, key string, _ int, _ time.Duration) (bool, error) {
	return !strings.Contains(key, ":day:"), nil
}

func TestProxyAPI_RemainingArms(t *testing.T) {
	t.Run("an unconfigured API origin is a 503", func(t *testing.T) {
		env := setupCliffyTurn(t, &stubAgent{})
		env.handler.apiOrigin = ""
		rec := httptest.NewRecorder()
		env.handler.ProxyAPI(rec, cliffyRequest(http.MethodPost, "/x", `{}`, "u1", "u1@example.com"))
		if rec.Code != http.StatusServiceUnavailable {
			t.Errorf("status = %d, want 503", rec.Code)
		}
	})

	t.Run("an unauthenticated caller is refused", func(t *testing.T) {
		env := setupCliffyTurn(t, &stubAgent{})
		rec := httptest.NewRecorder()
		env.handler.ProxyAPI(rec, cliffyRequest(http.MethodPost, "/x", `{}`, "", ""))
		if rec.Code != http.StatusForbidden {
			t.Errorf("status = %d, want 403", rec.Code)
		}
	})

	t.Run("a malformed body is a 400", func(t *testing.T) {
		env := setupCliffyTurn(t, &stubAgent{})
		rec := httptest.NewRecorder()
		env.handler.ProxyAPI(rec, cliffyRequest(http.MethodPost, "/x", `{`, "u1", "u1@example.com"))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", rec.Code)
		}
	})

	t.Run("over budget is a 429", func(t *testing.T) {
		env := setupCliffyTurn(t, &stubAgent{})
		env.handler.limiter = fakeLimiter{allow: false}
		rec := httptest.NewRecorder()
		env.handler.ProxyAPI(rec, cliffyRequest(http.MethodPost, "/x", `{}`, "u1", "u1@example.com"))
		if rec.Code != http.StatusTooManyRequests {
			t.Errorf("status = %d, want 429", rec.Code)
		}
	})

	t.Run("an unlinked account is a 403", func(t *testing.T) {
		env := setupCliffyTurn(t, &stubAgent{mintStatus: http.StatusForbidden})
		rec := httptest.NewRecorder()
		env.handler.ProxyAPI(rec, cliffyRequest(http.MethodPost, "/x",
			`{"method":"POST","path":"api/work/tasks"}`, "u1", "u1@example.com"))
		if rec.Code != http.StatusForbidden {
			t.Errorf("status = %d, want 403 (body %s)", rec.Code, rec.Body.String())
		}
	})

	t.Run("an unreachable API is a 502", func(t *testing.T) {
		env := setupCliffyTurn(t, &stubAgent{})
		// Mint first so the bridge caches a token, then take CliffHub down.
		if _, _, err := env.handler.bridge.TokenFor(context.Background(), "u1", "u1@example.com"); err != nil {
			t.Fatalf("TokenFor: %v", err)
		}
		env.srv.Close()
		rec := httptest.NewRecorder()
		env.handler.ProxyAPI(rec, cliffyRequest(http.MethodPost, "/x",
			`{"method":"POST","path":"api/work/tasks"}`, "u1", "u1@example.com"))
		if rec.Code != http.StatusBadGateway {
			t.Errorf("status = %d, want 502 (body %s)", rec.Code, rec.Body.String())
		}
	})
}

func TestShare_RemainingArms(t *testing.T) {
	env := setupCliffyTurn(t, &stubAgent{})

	t.Run("an unauthenticated caller is refused", func(t *testing.T) {
		env.handler.poster = fakePosterOK{}
		rec := httptest.NewRecorder()
		env.handler.Share(rec, cliffyRequest(http.MethodPost, "/x", `{}`, "", ""))
		if rec.Code != http.StatusForbidden {
			t.Errorf("status = %d, want 403", rec.Code)
		}
	})

	t.Run("a malformed body is a 400", func(t *testing.T) {
		env.handler.poster = fakePosterOK{}
		rec := httptest.NewRecorder()
		env.handler.Share(rec, cliffyRequest(http.MethodPost, "/x", `{`, "u1", "u1@example.com"))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", rec.Code)
		}
	})

	t.Run("nothing to share is a 400", func(t *testing.T) {
		env.handler.poster = fakePosterOK{}
		rec := httptest.NewRecorder()
		env.handler.Share(rec, cliffyRequest(http.MethodPost, "/x",
			`{"scope_type":"channel","scope_id":"ch1","text":"  "}`, "u1", "u1@example.com"))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
		}
	})

	t.Run("an attachment alone is shareable", func(t *testing.T) {
		poster := &recordingPoster{}
		env.handler.poster = poster
		rec := httptest.NewRecorder()
		env.handler.Share(rec, cliffyRequest(http.MethodPost, "/x",
			`{"scope_type":"channel","scope_id":"ch1","attachment":{"title":"CORE-1","title_link":"https://cliffhub.example/tasks/1","text":"Ship it","color":"#0a0"}}`,
			"u1", "u1@example.com"))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
		}
		if len(poster.attachments) != 1 || poster.attachments[0].Title != "CORE-1" {
			t.Errorf("attachments = %+v, want the card", poster.attachments)
		}
	})

	t.Run("a post failure is a 502", func(t *testing.T) {
		env.handler.poster = failingPoster{err: errors.New("dynamo down")}
		rec := httptest.NewRecorder()
		env.handler.Share(rec, cliffyRequest(http.MethodPost, "/x",
			`{"scope_type":"channel","scope_id":"ch1","text":"hi"}`, "u1", "u1@example.com"))
		if rec.Code != http.StatusBadGateway {
			t.Errorf("status = %d, want 502", rec.Code)
		}
	})
}

type fakePosterOK struct{}

func (fakePosterOK) SendBotCard(context.Context, string, string, string, string, string, string, string, string, []model.MessageAttachment) (*model.Message, error) {
	return &model.Message{ID: "m1"}, nil
}

type recordingPoster struct{ attachments []model.MessageAttachment }

func (p *recordingPoster) SendBotCard(_ context.Context, _, _, _, _, _, _, _, _ string, atts []model.MessageAttachment) (*model.Message, error) {
	p.attachments = atts
	return &model.Message{ID: "m1"}, nil
}

type failingPoster struct{ err error }

func (f failingPoster) SendBotCard(context.Context, string, string, string, string, string, string, string, string, []model.MessageAttachment) (*model.Message, error) {
	return nil, f.err
}

// streamCopy pumps the upstream body to the client; a writer that is not a
// Flusher must still receive everything.
func TestStreamCopy(t *testing.T) {
	rec := httptest.NewRecorder()
	streamCopy(rec, strings.NewReader("data: one\n\ndata: two\n\n"))
	if got := rec.Body.String(); !strings.Contains(got, "one") || !strings.Contains(got, "two") {
		t.Errorf("body = %q, want both events", got)
	}
}

func utf8ValidString(s string) bool {
	for _, r := range s {
		if r == '�' {
			return false
		}
	}
	return true
}

// --- doCliffhubWrite: the shared write path -------------------------------

func TestDoCliffhubWrite_Arms(t *testing.T) {
	ctx := context.Background()

	t.Run("an unconfigured API origin is refused", func(t *testing.T) {
		env := setupCliffyTurn(t, &stubAgent{})
		env.handler.apiOrigin = ""
		_, err := env.handler.doCliffhubWrite(ctx, "u1", "u1@example.com", "test", cliffhubWriteInput{
			Method: "POST", Path: "api/work/tasks",
		})
		if !errors.Is(err, errCliffyNotConfigured) {
			t.Fatalf("err = %v, want errCliffyNotConfigured", err)
		}
	})

	t.Run("only write methods are allowed", func(t *testing.T) {
		// Reads run inside the agent turn; this passthrough must not become a
		// general-purpose proxy.
		env := setupCliffyTurn(t, &stubAgent{})
		for _, m := range []string{http.MethodGet, http.MethodHead, http.MethodOptions, "", "TRACE"} {
			_, err := env.handler.doCliffhubWrite(ctx, "u1", "u1@example.com", "test", cliffhubWriteInput{
				Method: m, Path: "api/work/tasks",
			})
			if !errors.Is(err, errCliffyBadMethod) {
				t.Errorf("method %q: err = %v, want errCliffyBadMethod", m, err)
			}
		}
	})

	t.Run("the path must be an app api/ path, never a URL or another host", func(t *testing.T) {
		env := setupCliffyTurn(t, &stubAgent{})
		for _, p := range []string{
			"https://evil.example/api/x", // absolute URL
			"//evil.example/api/x",       // scheme-relative
			"other/tasks",                // outside api/
			"",                           // nothing
			"api/\x7fbad",                // unparsable once joined to the origin
		} {
			_, err := env.handler.doCliffhubWrite(ctx, "u1", "u1@example.com", "test", cliffhubWriteInput{
				Method: "POST", Path: p,
			})
			if !errors.Is(err, errCliffyBadPath) {
				t.Errorf("path %q: err = %v, want errCliffyBadPath", p, err)
			}
		}
	})

	t.Run("query parameters are forwarded", func(t *testing.T) {
		var gotQuery string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case strings.HasSuffix(r.URL.Path, "/mint"):
				_ = json.NewEncoder(w).Encode(map[string]any{
					"token": "tok", "expires_at": time.Now().Add(time.Hour),
				})
			default:
				gotQuery = r.URL.RawQuery
				w.WriteHeader(http.StatusCreated)
			}
		}))
		defer srv.Close()
		bridge, err := service.NewCliffyBridge(service.CliffyBridgeConfig{
			Secret: testBridgeSecret, MintURL: srv.URL + "/api/ai/bridge/mint", HTTPClient: srv.Client(),
		})
		if err != nil {
			t.Fatalf("NewCliffyBridge: %v", err)
		}
		h := NewCliffyHandler(CliffyHandlerConfig{Bridge: bridge, APIOrigin: srv.URL})
		h.client = srv.Client()

		if _, err := h.doCliffhubWrite(ctx, "u1", "u1@example.com", "test", cliffhubWriteInput{
			Method: "POST", Path: "api/work/tasks", Query: map[string]string{"project": "core"},
		}); err != nil {
			t.Fatalf("doCliffhubWrite: %v", err)
		}
		if !strings.Contains(gotQuery, "project=core") {
			t.Errorf("query = %q, want the forwarded parameter", gotQuery)
		}
	})

	t.Run("a bridge failure is returned", func(t *testing.T) {
		env := setupCliffyTurn(t, &stubAgent{mintStatus: http.StatusForbidden})
		_, err := env.handler.doCliffhubWrite(ctx, "u1", "u1@example.com", "test", cliffhubWriteInput{
			Method: "POST", Path: "api/work/tasks",
		})
		if !errors.Is(err, service.ErrCliffyNoAccount) {
			t.Fatalf("err = %v, want the bridge's refusal", err)
		}
	})

	t.Run("an unbuildable request is returned", func(t *testing.T) {
		// A nil context is rejected by http.NewRequestWithContext. The cached token
		// gets us past the bridge so this arm is the one that fires.
		env := setupCliffyTurn(t, &stubAgent{})
		warmBridgeToken(t, env)
		var nilCtx context.Context
		if _, err := env.handler.doCliffhubWrite(nilCtx, "u1", "u1@example.com", "test", cliffhubWriteInput{
			Method: "POST", Path: "api/work/tasks",
		}); err == nil {
			t.Fatal("want a request-construction error")
		}
	})

	t.Run("a transport failure is returned", func(t *testing.T) {
		env := setupCliffyTurn(t, &stubAgent{})
		warmBridgeToken(t, env)
		env.srv.Close()
		if _, err := env.handler.doCliffhubWrite(ctx, "u1", "u1@example.com", "test", cliffhubWriteInput{
			Method: "POST", Path: "api/work/tasks",
		}); err == nil {
			t.Fatal("want a transport error")
		}
	})
}

// ProxyAPI's generic upstream arm: not a bridge failure, just CliffHub being
// unreachable.
func TestProxyAPI_UpstreamFailureIsGeneric(t *testing.T) {
	env := setupCliffyTurn(t, &stubAgent{})
	warmBridgeToken(t, env)
	env.srv.Close()
	rec := httptest.NewRecorder()
	env.handler.ProxyAPI(rec, cliffyRequest(http.MethodPost, "/x",
		`{"method":"POST","path":"api/work/tasks"}`, "u1", "u1@example.com"))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 (body %s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "temporarily unavailable") {
		t.Errorf("body = %s, want the generic upstream message", rec.Body.String())
	}
}

// Chat's remaining arms: an unreadable body, and a transport failure to the agent
// that is not a bridge failure.
func TestChat_UnreadableBody(t *testing.T) {
	env := setupCliffyTurn(t, &stubAgent{})
	req := cliffyRequest(http.MethodPost, "/x", "", "u1", "u1@example.com")
	req.Body = io.NopCloser(failingReader{})
	rec := httptest.NewRecorder()
	env.handler.Chat(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
	}
}

func TestChat_AgentTransportFailure(t *testing.T) {
	// A live mint (cached) but a dead agent: the failure is the agent's, so it is
	// the generic upstream error rather than a bridge refusal.
	env := setupCliffyTurn(t, &stubAgent{})
	warmBridgeToken(t, env)
	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	dead.Close()
	env.handler.agentURL = dead.URL

	rec := httptest.NewRecorder()
	env.handler.Chat(rec, cliffyRequest(http.MethodPost, "/x", `{"messages":[]}`, "u1", "u1@example.com"))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 (body %s)", rec.Code, rec.Body.String())
	}
}

// streamCopy stops when the client goes away rather than spinning on a dead writer.
func TestStreamCopy_ClientDisconnect(t *testing.T) {
	streamCopy(errWriter{}, strings.NewReader(strings.Repeat("data: x\n\n", 100)))
}

// errWriter fails every write, standing in for a client that hung up.
type errWriter struct{ http.ResponseWriter }

func (errWriter) Header() http.Header       { return http.Header{} }
func (errWriter) WriteHeader(int)           {}
func (errWriter) Write([]byte) (int, error) { return 0, errors.New("client gone") }
