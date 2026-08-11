package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/email"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
)

// recordingMailer captures what the admin diagnostic actually sends.
type recordingMailer struct {
	mu   sync.Mutex
	sent []email.Message
	err  error
}

func (m *recordingMailer) Send(_ context.Context, msg email.Message) error {
	if m.err != nil {
		return m.err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sent = append(m.sent, msg)
	return nil
}

func (m *recordingMailer) last() email.Message {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.sent) == 0 {
		return email.Message{}
	}
	return m.sent[len(m.sent)-1]
}

func adminUser() *model.User {
	return &model.User{ID: "u-admin", Email: "admin@example.com", SystemRole: model.SystemRoleAdmin}
}

// callAdmin drives an admin handler through the auth middleware as the given user.
func callAdmin(h http.HandlerFunc, jwtMgr *auth.JWTManager, caller *model.User, method, path, body string) *httptest.ResponseRecorder {
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+makeTokenForUser(jwtMgr, caller))
	rec := httptest.NewRecorder()
	middleware.Auth(jwtMgr)(h).ServeHTTP(rec, req)
	return rec
}

func TestAdminHandler_EmailStatus(t *testing.T) {
	t.Run("reports the configured transport", func(t *testing.T) {
		h, jwtMgr := setupAdminHandler(t)
		h.SetMailer(&recordingMailer{}, "ses", "Ex <noreply@example.com>")

		rec := callAdmin(h.EmailStatus, jwtMgr, adminUser(), http.MethodGet, "/api/v1/admin/email", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
		}
		var got struct {
			Configured bool   `json:"configured"`
			Provider   string `json:"provider"`
			From       string `json:"from"`
		}
		if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		if !got.Configured || got.Provider != "ses" || got.From != "Ex <noreply@example.com>" {
			t.Errorf("status = %+v, want the wired SES settings", got)
		}
	})

	// An admin must be able to tell "mail is off" from "mail is broken".
	t.Run("reports an unconfigured transport", func(t *testing.T) {
		h, jwtMgr := setupAdminHandler(t)

		rec := callAdmin(h.EmailStatus, jwtMgr, adminUser(), http.MethodGet, "/api/v1/admin/email", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d", rec.Code)
		}
		var got struct {
			Configured bool `json:"configured"`
		}
		if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		if got.Configured {
			t.Error("configured = true with no mailer wired")
		}
	})

	t.Run("members are forbidden", func(t *testing.T) {
		h, jwtMgr := setupAdminHandler(t)
		h.SetMailer(&recordingMailer{}, "smtp", "noreply@example.com")
		member := &model.User{ID: "u-m", Email: "m@example.com", SystemRole: model.SystemRoleMember}

		rec := callAdmin(h.EmailStatus, jwtMgr, member, http.MethodGet, "/api/v1/admin/email", "")
		if rec.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want 403", rec.Code)
		}
	})
}

func TestAdminHandler_SendTestEmail(t *testing.T) {
	t.Run("sends to an explicit recipient", func(t *testing.T) {
		h, jwtMgr := setupAdminHandler(t)
		mailer := &recordingMailer{}
		h.SetMailer(mailer, "smtp", "noreply@example.com")

		rec := callAdmin(h.SendTestEmail, jwtMgr, adminUser(), http.MethodPost,
			"/api/v1/admin/email/test", `{"to":"ops@example.com"}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
		}
		msg := mailer.last()
		if msg.To != "ops@example.com" {
			t.Errorf("To = %q, want the explicit recipient", msg.To)
		}
		if msg.Subject == "" || msg.Text == "" || msg.HTML == "" {
			t.Error("the test message should exercise the same shape a real email does")
		}
		if !strings.Contains(msg.Text, "smtp") {
			t.Errorf("the test message should name the transport: %q", msg.Text)
		}
	})

	// Defaulting to the caller keeps a misconfigured server from being used to
	// mail arbitrary strangers.
	t.Run("defaults to the calling admin", func(t *testing.T) {
		h, jwtMgr := setupAdminHandler(t)
		mailer := &recordingMailer{}
		h.SetMailer(mailer, "smtp", "noreply@example.com")

		rec := callAdmin(h.SendTestEmail, jwtMgr, adminUser(), http.MethodPost,
			"/api/v1/admin/email/test", `{}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
		}
		if got := mailer.last().To; got != "admin@example.com" {
			t.Errorf("To = %q, want the caller's own address", got)
		}
		var body struct {
			Sent bool   `json:"sent"`
			To   string `json:"to"`
		}
		if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if !body.Sent || body.To != "admin@example.com" {
			t.Errorf("response = %+v, want a confirmed send to the caller", body)
		}
	})

	// The transport's own error is the entire point: an admin cannot fix the
	// settings without it.
	t.Run("surfaces the transport error verbatim", func(t *testing.T) {
		h, jwtMgr := setupAdminHandler(t)
		h.SetMailer(&recordingMailer{err: errors.New("dial tcp 10.0.0.1:587: connect: connection refused")},
			"smtp", "noreply@example.com")

		rec := callAdmin(h.SendTestEmail, jwtMgr, adminUser(), http.MethodPost,
			"/api/v1/admin/email/test", `{}`)
		if rec.Code != http.StatusBadGateway {
			t.Fatalf("status = %d, want 502", rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "connection refused") {
			t.Errorf("the transport error was swallowed: %s", rec.Body.String())
		}
	})

	t.Run("reports an unconfigured transport", func(t *testing.T) {
		h, jwtMgr := setupAdminHandler(t)

		rec := callAdmin(h.SendTestEmail, jwtMgr, adminUser(), http.MethodPost,
			"/api/v1/admin/email/test", `{}`)
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, want 503", rec.Code)
		}
	})

	t.Run("malformed body", func(t *testing.T) {
		h, jwtMgr := setupAdminHandler(t)
		h.SetMailer(&recordingMailer{}, "smtp", "noreply@example.com")

		rec := callAdmin(h.SendTestEmail, jwtMgr, adminUser(), http.MethodPost,
			"/api/v1/admin/email/test", `{`)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
	})

	// A token with no email and no explicit recipient has nowhere to send.
	t.Run("no recipient available", func(t *testing.T) {
		h, jwtMgr := setupAdminHandler(t)
		h.SetMailer(&recordingMailer{}, "smtp", "noreply@example.com")
		caller := &model.User{ID: "u-admin-noemail", SystemRole: model.SystemRoleAdmin}

		rec := callAdmin(h.SendTestEmail, jwtMgr, caller, http.MethodPost,
			"/api/v1/admin/email/test", `{"to":"   "}`)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
	})

	t.Run("members are forbidden", func(t *testing.T) {
		h, jwtMgr := setupAdminHandler(t)
		mailer := &recordingMailer{}
		h.SetMailer(mailer, "smtp", "noreply@example.com")
		member := &model.User{ID: "u-m", Email: "m@example.com", SystemRole: model.SystemRoleMember}

		rec := callAdmin(h.SendTestEmail, jwtMgr, member, http.MethodPost,
			"/api/v1/admin/email/test", `{}`)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want 403", rec.Code)
		}
		if len(mailer.sent) != 0 {
			t.Error("a non-admin caused mail to be sent")
		}
	})
}
