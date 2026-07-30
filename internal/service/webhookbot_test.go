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
	"testing"
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
	if reply != "hello from the bot" {
		t.Errorf("reply = %q", reply)
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
	if reply != "" {
		t.Errorf("ephemeral reply should not be posted; got %q", reply)
	}
}
