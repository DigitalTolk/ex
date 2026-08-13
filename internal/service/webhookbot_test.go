package service

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// useLoopbackWebhookClient points the package webhook client at a plain dialer so
// tests can reach httptest's 127.0.0.1 server. The production safeDialContext
// SSRF boundary is exercised separately by TestSafeDialContext_* in unfurl_test.go.
func useLoopbackWebhookClient(t *testing.T) {
	t.Helper()
	orig := botWebhookClient.Transport
	botWebhookClient.Transport = &http.Transport{}
	t.Cleanup(func() { botWebhookClient.Transport = orig })
}

func TestWebhookBotHandler_PostsSignedEventAndReturnsReply(t *testing.T) {
	useLoopbackWebhookClient(t)
	var gotSig, gotUserID, gotText string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		gotSig = r.Header.Get("X-Ex-Signature")
		ts := r.Header.Get("X-Ex-Timestamp")
		var in struct {
			UserID string `json:"user_id"`
			Text   string `json:"text"`
		}
		_ = json.Unmarshal(body, &in)
		gotUserID, gotText = in.UserID, in.Text

		// Verify the timestamp-bound signature the way a real bot would:
		// HMAC over "<timestamp>:<body>".
		if ts == "" {
			t.Error("expected an X-Ex-Timestamp header")
		}
		mac := hmac.New(sha256.New, []byte("s3cr3t"))
		mac.Write([]byte(ts))
		mac.Write([]byte(":"))
		mac.Write(body)
		if want := "sha256=" + hex.EncodeToString(mac.Sum(nil)); want != gotSig {
			t.Errorf("signature mismatch: got %q want %q", gotSig, want)
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"text": "hello from the bot"})
	}))
	defer srv.Close()

	h := webhookBotHandler{target: BotWebhookTarget{URL: srv.URL, Secret: "s3cr3t", Name: "Jira"}}
	reply, err := h.Handle(context.Background(), BotEvent{
		BotUserID: "bot_jira", AskerID: "u-1", ParentID: "ch-1", ParentType: ParentChannel, Prompt: "deploy staging",
	})
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if reply.Text != "hello from the bot" {
		t.Errorf("reply.Text = %q", reply.Text)
	}
	if gotUserID != "u-1" {
		t.Errorf("attested user_id = %q, want u-1", gotUserID)
	}
	if gotText != "deploy staging" {
		t.Errorf("text = %q", gotText)
	}
	if gotSig == "" {
		t.Error("expected an X-Ex-Signature header")
	}
}

func TestValidateCallbackURL(t *testing.T) {
	ok := []string{
		"https://bot.example.com/hook",
		"https://hooks.example.com:8443/x",
		"https://93.184.216.34/hook", // public literal IP
	}
	for _, u := range ok {
		if err := validateCallbackURL(u); err != nil {
			t.Errorf("validateCallbackURL(%q) = %v, want nil", u, err)
		}
	}
	bad := []string{
		"http://bot.example.com/hook",  // not https
		"https://127.0.0.1/hook",       // loopback
		"https://10.0.0.5/hook",        // private
		"https://192.168.1.1/hook",     // private
		"https://169.254.169.254/meta", // cloud metadata (link-local)
		"https:///nohost",              // missing host
		"ftp://bot.example.com",        // wrong scheme
	}
	for _, u := range bad {
		if err := validateCallbackURL(u); err == nil {
			t.Errorf("validateCallbackURL(%q) = nil, want rejection", u)
		}
	}
}

func TestWebhookBotHandler_EphemeralNotPosted(t *testing.T) {
	useLoopbackWebhookClient(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"response_type": "ephemeral", "text": "only for you"})
	}))
	defer srv.Close()

	h := webhookBotHandler{target: BotWebhookTarget{URL: srv.URL}}
	reply, err := h.Handle(context.Background(), BotEvent{BotUserID: "bot_x", AskerID: "u-1", ParentID: "ch-1", ParentType: ParentChannel, Prompt: "hi"})
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	// The reply carries the text but is flagged ephemeral; the DISPATCHER is what
	// declines to post it (an ephemeral in-channel post has no meaning in ex).
	if !reply.Ephemeral {
		t.Error("reply.Ephemeral = false, want true")
	}
}

func TestWebhookBotHandler_MattermostTransportSendsFormFields(t *testing.T) {
	useLoopbackWebhookClient(t)
	var got map[string]string
	var contentType, gotSig string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		contentType = r.Header.Get("Content-Type")
		gotSig = r.Header.Get("X-Ex-Signature")
		_ = r.ParseForm()
		got = map[string]string{}
		for k := range r.PostForm {
			got[k] = r.PostForm.Get(k)
		}
		// A real MM receiver answers with MM's reply shape.
		_ = json.NewEncoder(w).Encode(map[string]any{
			"response_type": "in_channel",
			"text":          "deploying",
			"username":      "Deploy Bot",
		})
	}))
	defer srv.Close()

	h := webhookBotHandler{
		target: BotWebhookTarget{
			URL:       srv.URL,
			Secret:    "mm-token",
			Name:      "Deployer",
			Transport: model.BotTransportMattermost,
		},
		resolver: stubMMResolver{channelSlug: "releases", userName: "anna.smith"},
	}
	reply, err := h.Handle(context.Background(), BotEvent{
		BotUserID: "bot_dep", AskerID: "u-1", ParentID: "ch-1", ParentType: ParentChannel,
		MessageID: "msg-9", Prompt: "deploy web", TriggerWord: "deploy",
	})
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}

	if contentType != "application/x-www-form-urlencoded" {
		t.Errorf("Content-Type = %q, want form encoding", contentType)
	}
	// The exact field names an existing Mattermost receiver parses.
	want := map[string]string{
		"token":        "mm-token",
		"team_id":      MMSyntheticTeamID,
		"team_domain":  MMSyntheticTeamDomain,
		"channel_id":   "ch-1",
		"channel_name": "releases",
		"user_id":      "u-1",
		"user_name":    "anna.smith",
		"post_id":      "msg-9",
		"text":         "deploy web",
		"trigger_word": "deploy",
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("form[%q] = %q, want %q", k, got[k], v)
		}
	}
	// Real MM sends epoch milliseconds (verified live against MM 11.9), so a
	// receiver parsing this field must see a ms-scale value, not seconds.
	if ts, err := strconv.ParseInt(got["timestamp"], 10, 64); err != nil || ts < 1_000_000_000_000 {
		t.Errorf("form[timestamp] = %q, want epoch milliseconds", got["timestamp"])
	}
	// The MM transport must NOT also send ex's signature header: a receiver
	// configured for MM verifies the body token, and sending both would advertise
	// an authentication path that isn't the one in use.
	if gotSig != "" {
		t.Errorf("MM transport sent X-Ex-Signature = %q, want none", gotSig)
	}
	if reply.Text != "deploying" || reply.Username != "Deploy Bot" || reply.Ephemeral {
		t.Errorf("reply = %+v, want in-channel text with a username override", reply)
	}
}

// stubMMResolver is a BotContextResolver with fixed answers.
type stubMMResolver struct {
	channelName string
	channelSlug string
	userName    string
}

func (s stubMMResolver) ChannelContext(context.Context, string, string) (string, string, string) {
	return s.channelName, s.channelSlug, mmChannelTypeOpen
}

func (s stubMMResolver) UserContext(context.Context, string) (string, string) {
	return s.userName, s.userName
}
