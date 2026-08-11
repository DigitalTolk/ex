package email

import (
	"strings"
	"testing"
)

func TestInviteMessage(t *testing.T) {
	const link = "https://ex.example.com/invite/tok-123"

	t.Run("names the inviter when known", func(t *testing.T) {
		msg := InviteMessage("guest@example.com", "Ada Admin", link)
		if msg.To != "guest@example.com" {
			t.Errorf("To = %q", msg.To)
		}
		if msg.Subject == "" {
			t.Error("invitation has no subject")
		}
		for _, body := range []string{msg.Text, msg.HTML} {
			if !strings.Contains(body, link) {
				t.Errorf("body is missing the accept link: %q", body)
			}
			if !strings.Contains(body, "Ada Admin") {
				t.Errorf("body does not name the inviter: %q", body)
			}
		}
	})

	t.Run("falls back to a generic intro", func(t *testing.T) {
		for _, name := range []string{"", "   "} {
			msg := InviteMessage("guest@example.com", name, link)
			if strings.Contains(msg.Text, " has invited") {
				t.Errorf("expected the nameless wording for %q: %q", name, msg.Text)
			}
			if !strings.Contains(msg.Text, "You have been invited") {
				t.Errorf("missing the generic wording: %q", msg.Text)
			}
		}
	})
}

func TestPasswordResetMessage(t *testing.T) {
	const link = "https://ex.example.com/reset-password/tok-123"

	t.Run("admin-initiated says so", func(t *testing.T) {
		msg := PasswordResetMessage("guest@example.com", link, 1, true)
		if !strings.Contains(msg.Text, "An administrator") {
			t.Errorf("admin reset should say an admin started it: %q", msg.Text)
		}
		// Singular, not "1 hours".
		if !strings.Contains(msg.Text, "expires in 1 hour.") {
			t.Errorf("expiry wording = %q", msg.Text)
		}
	})

	t.Run("self-service does not blame an admin", func(t *testing.T) {
		msg := PasswordResetMessage("guest@example.com", link, 2, false)
		if strings.Contains(msg.Text, "administrator") {
			t.Errorf("self-service reset should not mention an admin: %q", msg.Text)
		}
		if !strings.Contains(msg.Text, "expires in 2 hours.") {
			t.Errorf("plural expiry wording = %q", msg.Text)
		}
	})

	t.Run("both bodies carry the link", func(t *testing.T) {
		msg := PasswordResetMessage("guest@example.com", link, 1, false)
		for _, body := range []string{msg.Text, msg.HTML} {
			if !strings.Contains(body, link) {
				t.Errorf("body is missing the reset link: %q", body)
			}
		}
		// A recipient who did not ask for this must be told their current
		// password still works, so a stray email doesn't read as a breach.
		if !strings.Contains(msg.Text, "current password stays active") {
			t.Errorf("missing the reassurance line: %q", msg.Text)
		}
	})
}

// A URL is interpolated into HTML, so it must be escaped — otherwise a
// crafted base URL could inject markup into the email.
func TestTemplatesEscapeHTML(t *testing.T) {
	evil := `https://ex.example.com/reset-password/"><script>alert(1)</script>`
	msg := PasswordResetMessage("guest@example.com", evil, 1, false)
	if strings.Contains(msg.HTML, "<script>") {
		t.Errorf("unescaped markup made it into the HTML body: %q", msg.HTML)
	}
	if !strings.Contains(msg.HTML, "&lt;script&gt;") {
		t.Errorf("expected the markup to be escaped: %q", msg.HTML)
	}

	invite := InviteMessage("guest@example.com", `<b>Ada</b>`, "https://ex.example.com/invite/t")
	if strings.Contains(invite.HTML, "<b>Ada</b>") {
		t.Errorf("unescaped inviter name made it into the HTML body: %q", invite.HTML)
	}
}

// The rendered page must be a self-contained document; mail clients drop
// anything that depends on an external stylesheet.
func TestPageIsSelfContained(t *testing.T) {
	html := PasswordResetMessage("guest@example.com", "https://ex.example.com/x", 1, false).HTML
	for _, want := range []string{"<!doctype html>", "<style>", "</html>"} {
		if !strings.Contains(html, want) {
			t.Errorf("rendered page is missing %q", want)
		}
	}
	if strings.Contains(html, "<link") || strings.Contains(html, "<img") {
		t.Errorf("page pulls external resources: %q", html)
	}
}

func TestTestMessage(t *testing.T) {
	t.Run("names the transport it went through", func(t *testing.T) {
		msg := TestMessage("admin@example.com", "ses")
		if msg.To != "admin@example.com" {
			t.Errorf("To = %q", msg.To)
		}
		if !strings.Contains(msg.Text, "via ses") {
			t.Errorf("body should name the transport: %q", msg.Text)
		}
		// The diagnostic must exercise the same multipart shape a real
		// notification does, or it proves less than it appears to.
		if msg.Text == "" || msg.HTML == "" {
			t.Error("expected both a text and an HTML body")
		}
		// Non-ASCII is the point: a transport that mangles this would mangle
		// real names and subjects too.
		for _, want := range []string{"Återställ", "æøå", "日本語"} {
			if !strings.Contains(msg.Text, want) {
				t.Errorf("text body is missing the encoding check %q", want)
			}
		}
	})

	t.Run("falls back when the transport is unnamed", func(t *testing.T) {
		for _, provider := range []string{"", "   "} {
			msg := TestMessage("admin@example.com", provider)
			if !strings.Contains(msg.Text, "the configured transport") {
				t.Errorf("provider %q should yield the generic wording: %q", provider, msg.Text)
			}
		}
	})
}
