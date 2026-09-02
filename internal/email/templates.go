package email

import (
	"fmt"
	"html"
	"strings"
)

// The transactional templates live here so wording and markup stay in one
// place. They are intentionally plain: no images, no tracking pixels, no
// external stylesheets — corporate mail clients strip most of it anyway, and
// a link that renders everywhere beats a design that renders in Gmail only.

// InviteMessage builds the workspace-invitation email.
func InviteMessage(to, inviterName, acceptURL string) Message {
	who := strings.TrimSpace(inviterName)
	intro := "You have been invited to join the workspace."
	if who != "" {
		intro = fmt.Sprintf("%s has invited you to join the workspace.", who)
	}
	return Message{
		To:      to,
		Subject: "You have been invited to join the workspace",
		Text: intro + "\n\n" +
			"Set up your account here:\n" + acceptURL + "\n\n" +
			"This invitation expires in 72 hours.\n" +
			"If you were not expecting it, you can ignore this email.\n",
		HTML: page(
			"You have been invited",
			"<p>"+html.EscapeString(intro)+"</p>",
			button(acceptURL, "Set up your account"),
			"<p class=\"muted\">This invitation expires in 72 hours. "+
				"If you were not expecting it, you can ignore this email.</p>",
		),
	}
}

// PasswordResetMessage builds the password-reset email. byAdmin distinguishes
// an administrator-initiated reset from a self-service request so the
// recipient can tell whether they are the one who asked.
func PasswordResetMessage(to, resetURL string, ttlHours int, byAdmin bool) Message {
	intro := "We received a request to reset your password."
	if byAdmin {
		intro = "An administrator has started a password reset for your account."
	}
	expiry := fmt.Sprintf("This link can be used once and expires in %d hour%s.",
		ttlHours, plural(ttlHours))
	return Message{
		To:      to,
		Subject: "Reset your password",
		Text: intro + "\n\n" +
			"Choose a new password here:\n" + resetURL + "\n\n" +
			expiry + "\n" +
			"If you did not expect this, you can ignore this email — your current password stays active.\n",
		HTML: page(
			"Reset your password",
			"<p>"+html.EscapeString(intro)+"</p>",
			button(resetURL, "Choose a new password"),
			"<p class=\"muted\">"+html.EscapeString(expiry)+" "+
				"If you did not expect this, you can ignore this email &mdash; "+
				"your current password stays active.</p>",
		),
	}
}

// TestMessage builds the admin diagnostic email. Its job is to prove the
// whole path works, so it deliberately exercises the same shape a real
// notification does: a multipart body with both alternatives, and non-ASCII
// text that only survives correct header/body encoding.
func TestMessage(to, provider string) Message {
	via := strings.TrimSpace(provider)
	if via == "" {
		via = "the configured transport"
	}
	intro := fmt.Sprintf(
		"This is a test message from your workspace, delivered via %s.", via)
	confirm := "If you are reading this, invitations and password-reset links " +
		"will reach their recipients."
	// Non-ASCII on purpose: a transport that mangles this would also mangle
	// real names and subjects, and that is exactly what a test should catch.
	encoding := "Encoding check: Återställ — æøå — 日本語"
	return Message{
		To:      to,
		Subject: "Test message from your workspace",
		Text:    intro + "\n\n" + confirm + "\n\n" + encoding + "\n",
		HTML: page(
			"Email is working",
			"<p>"+html.EscapeString(intro)+"</p>",
			"<p>"+html.EscapeString(confirm)+"</p>",
			"<p class=\"muted\">"+html.EscapeString(encoding)+"</p>",
		),
	}
}

// plural returns the suffix for a count, so "1 hour" doesn't read "1 hours".
func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// button renders a link as a tappable block. Anchor-with-background rather
// than a real button element: mail clients drop <button> but keep <a>.
func button(url, label string) string {
	safe := html.EscapeString(url)
	return `<p><a class="btn" href="` + safe + `">` + html.EscapeString(label) + `</a></p>` +
		`<p class="muted">Or paste this address into your browser:<br>` +
		`<a href="` + safe + `">` + safe + `</a></p>`
}

// page wraps body fragments in a minimal, inline-styled document. The palette
// mirrors the app's light-theme tokens (see CLAUDE.md) — mail has no dark-mode
// class hook, so it commits to the light surface deliberately.
func page(title string, body ...string) string {
	return `<!doctype html><html><head><meta charset="utf-8">` +
		`<meta name="viewport" content="width=device-width">` +
		`<title>` + html.EscapeString(title) + `</title><style>` +
		`body{margin:0;padding:24px;background:#F5F5F5;` +
		`font-family:Figtree,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;` +
		`font-size:14px;line-height:20px;color:#231F20}` +
		`.card{max-width:480px;margin:0 auto;background:#FFFFFF;border:1px solid #E9E9E9;` +
		`border-radius:8px;padding:24px}` +
		`h1{font-size:20px;line-height:30px;margin:0 0 16px}` +
		`p{margin:0 0 16px}` +
		`.muted{color:#7B7979;font-size:12px;line-height:16px}` +
		`.btn{display:inline-block;background:#231F20;color:#FFFFFF;text-decoration:none;` +
		`padding:10px 20px;border-radius:8px;font-weight:600}` +
		`a{color:#231F20}` +
		`</style></head><body><div class="card"><h1>` +
		html.EscapeString(title) + `</h1>` + strings.Join(body, "") +
		`</div></body></html>`
}
