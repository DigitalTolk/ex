//go:build integration

package email

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

// End-to-end coverage against a REAL mail server.
//
// The unit tests drive a scripted fake that speaks just enough SMTP to assert
// our wiring. This suite goes further: Mailpit is a genuine SMTP server with a
// real MIME parser, so it proves the messages we actually put on the wire are
// well-formed mail — headers, multipart structure, transfer encodings, and
// non-ASCII subjects — rather than something only our own parser accepts.
//
// The whole path runs for real: templates → go-mail → SMTP → server → API
// read-back.

var (
	mailpitSMTPHost string
	mailpitSMTPPort string
	mailpitAPI      string
	mailpitReady    bool
)

func TestMain(m *testing.M) {
	ctx := context.Background()

	req := testcontainers.ContainerRequest{
		Image:        "axllent/mailpit:latest",
		ExposedPorts: []string{"1025/tcp", "8025/tcp"},
		WaitingFor: wait.ForHTTP("/readyz").WithPort("8025/tcp").
			WithStartupTimeout(60 * time.Second),
	}
	container, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: req,
		Started:          true,
	})
	if err != nil {
		// No Docker available — let individual tests skip themselves.
		log.Printf("email integration tests will skip: docker unavailable: %v", err)
		os.Exit(m.Run())
	}

	host, herr := container.Host(ctx)
	smtpPort, perr := container.MappedPort(ctx, "1025")
	apiPort, aerr := container.MappedPort(ctx, "8025")
	if herr == nil && perr == nil && aerr == nil {
		mailpitSMTPHost = host
		mailpitSMTPPort = smtpPort.Port()
		mailpitAPI = fmt.Sprintf("http://%s:%s", host, apiPort.Port())
		mailpitReady = true
	}

	code := m.Run()
	_ = container.Terminate(ctx)
	os.Exit(code)
}

// mailpitMessage is the subset of Mailpit's message API this suite asserts on.
type mailpitMessage struct {
	ID      string `json:"ID"`
	Subject string `json:"Subject"`
	From    struct {
		Name    string `json:"Name"`
		Address string `json:"Address"`
	} `json:"From"`
	To []struct {
		Address string `json:"Address"`
	} `json:"To"`
	Text string `json:"Text"`
	HTML string `json:"HTML"`
}

func newMailpitSender(t *testing.T, from string) *SMTPSender {
	t.Helper()
	if !mailpitReady {
		t.Skip("skipping: Docker / Mailpit not available")
	}
	// No credentials and no TLS: Mailpit accepts plain SMTP by default, which
	// is exactly the "trusted local relay" deployment the opportunistic TLS
	// policy exists to support.
	sender, err := NewSMTPSender(mailpitSMTPHost, mailpitSMTPPort, "", "", from)
	if err != nil {
		t.Fatalf("NewSMTPSender: %v", err)
	}
	return sender
}

// resetMailpit clears the mailbox so each test reads only its own message.
func resetMailpit(t *testing.T) {
	t.Helper()
	req, err := http.NewRequest(http.MethodDelete, mailpitAPI+"/api/v1/messages", nil)
	if err != nil {
		t.Fatalf("build delete request: %v", err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("clear mailbox: %v", err)
	}
	_ = res.Body.Close()
}

// latestMessage polls Mailpit until a message arrives, then returns it fully
// parsed by the SERVER — so these assertions reflect what a real mail client
// would see, not what our own code produced.
func latestMessage(t *testing.T) mailpitMessage {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		var list struct {
			Messages []struct {
				ID string `json:"ID"`
			} `json:"messages"`
		}
		if getJSON(t, mailpitAPI+"/api/v1/messages", &list); len(list.Messages) > 0 {
			var msg mailpitMessage
			getJSON(t, mailpitAPI+"/api/v1/message/"+list.Messages[0].ID, &msg)
			return msg
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("no message arrived at Mailpit within the deadline")
	return mailpitMessage{}
}

func getJSON(t *testing.T, url string, dest any) {
	t.Helper()
	res, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("GET %s: status %d", url, res.StatusCode)
	}
	if err := json.NewDecoder(res.Body).Decode(dest); err != nil {
		t.Fatalf("decode %s: %v", url, err)
	}
}

// A real password-reset email, end to end: rendered from the production
// template, sent over SMTP, and read back as a real mail server parsed it.
func TestMailpit_PasswordResetEmail(t *testing.T) {
	sender := newMailpitSender(t, "Ex <noreply@ex.example.com>")
	resetMailpit(t)

	const link = "https://ex.example.com/reset-password/tok-e2e-123"
	if err := sender.Send(context.Background(), PasswordResetMessage("guest@example.com", link, 1, true)); err != nil {
		t.Fatalf("Send: %v", err)
	}

	msg := latestMessage(t)
	if msg.From.Address != "noreply@ex.example.com" {
		t.Errorf("From = %q, want noreply@ex.example.com", msg.From.Address)
	}
	if msg.From.Name != "Ex" {
		t.Errorf("From display name = %q, want Ex", msg.From.Name)
	}
	if len(msg.To) != 1 || msg.To[0].Address != "guest@example.com" {
		t.Errorf("To = %+v, want the single guest recipient", msg.To)
	}
	if msg.Subject != "Reset your password" {
		t.Errorf("Subject = %q", msg.Subject)
	}
	// The link is the entire point of the email: if it doesn't survive
	// encoding and transport intact, the guest cannot recover their account.
	if !strings.Contains(msg.Text, link) {
		t.Errorf("plain-text body lost the reset link:\n%s", msg.Text)
	}
	if !strings.Contains(msg.HTML, link) {
		t.Errorf("HTML body lost the reset link:\n%s", msg.HTML)
	}
	if !strings.Contains(msg.Text, "An administrator") {
		t.Errorf("admin-initiated wording missing:\n%s", msg.Text)
	}
	// Both alternatives must arrive — a text-only client must still be able
	// to act on the mail.
	if msg.Text == "" || msg.HTML == "" {
		t.Error("expected a multipart/alternative message with both bodies")
	}
}

func TestMailpit_InviteEmail(t *testing.T) {
	sender := newMailpitSender(t, "Ex <noreply@ex.example.com>")
	resetMailpit(t)

	const link = "https://ex.example.com/invite/tok-e2e-456"
	if err := sender.Send(context.Background(), InviteMessage("newguest@example.com", "Ada Admin", link)); err != nil {
		t.Fatalf("Send: %v", err)
	}

	msg := latestMessage(t)
	if len(msg.To) != 1 || msg.To[0].Address != "newguest@example.com" {
		t.Errorf("To = %+v", msg.To)
	}
	if !strings.Contains(msg.Text, link) || !strings.Contains(msg.HTML, link) {
		t.Errorf("invite link missing from a body:\ntext=%s\nhtml=%s", msg.Text, msg.HTML)
	}
	if !strings.Contains(msg.Text, "Ada Admin") {
		t.Errorf("inviter name missing:\n%s", msg.Text)
	}
}

// Non-ASCII must survive a real server's header decoder — this is exactly the
// class of bug a hand-rolled encoder ships and a hand-rolled parser hides.
func TestMailpit_UnicodeSubjectAndBody(t *testing.T) {
	sender := newMailpitSender(t, "noreply@ex.example.com")
	resetMailpit(t)

	msg := Message{
		To:      "guest@example.com",
		Subject: "Återställ ditt lösenord",
		Text:    "Hej! Återställ ditt lösenord här: https://ex.example.com/x",
		HTML:    "<p>Hej! Återställ ditt lösenord här.</p>",
	}
	if err := sender.Send(context.Background(), msg); err != nil {
		t.Fatalf("Send: %v", err)
	}

	got := latestMessage(t)
	if got.Subject != msg.Subject {
		t.Errorf("Subject = %q, want %q — RFC 2047 round-trip failed", got.Subject, msg.Subject)
	}
	if !strings.Contains(got.Text, "Återställ ditt lösenord") {
		t.Errorf("plain-text body mangled non-ASCII:\n%s", got.Text)
	}
	if !strings.Contains(got.HTML, "Återställ ditt lösenord") {
		t.Errorf("HTML body mangled non-ASCII:\n%s", got.HTML)
	}
}

// A long body must survive line-length limits: a naive encoder produces lines
// over the 998-octet RFC 5322 cap, which strict relays reject outright.
func TestMailpit_LongBodySurvivesLineLimits(t *testing.T) {
	sender := newMailpitSender(t, "noreply@ex.example.com")
	resetMailpit(t)

	long := strings.Repeat("the quick brown fox jumps over the lazy dog ", 200)
	if err := sender.Send(context.Background(), Message{
		To: "guest@example.com", Subject: "Long", Text: long,
	}); err != nil {
		t.Fatalf("Send: %v", err)
	}

	got := latestMessage(t)
	if !strings.Contains(strings.ReplaceAll(got.Text, "\r\n", ""), strings.ReplaceAll(long, "\r\n", "")) {
		t.Errorf("long body did not round-trip intact (len want %d, got %d)", len(long), len(got.Text))
	}
}

// The text-only shape must arrive as a single part, not an empty multipart.
func TestMailpit_TextOnlyMessage(t *testing.T) {
	sender := newMailpitSender(t, "noreply@ex.example.com")
	resetMailpit(t)

	if err := sender.Send(context.Background(), Message{
		To: "guest@example.com", Subject: "Text only", Text: "just plain",
	}); err != nil {
		t.Fatalf("Send: %v", err)
	}

	got := latestMessage(t)
	if strings.TrimSpace(got.Text) != "just plain" {
		t.Errorf("Text = %q, want %q", got.Text, "just plain")
	}
	if got.HTML != "" {
		t.Errorf("HTML = %q, want empty for a text-only message", got.HTML)
	}
}

// The admin "send test mail" diagnostic, end to end. This one matters most:
// its whole purpose is to tell an admin the settings work, so it must not be
// the message that quietly renders wrong. The non-ASCII line is deliberate —
// it proves encoding survives the real transport.
func TestMailpit_AdminTestMessage(t *testing.T) {
	sender := newMailpitSender(t, "Ex <noreply@ex.example.com>")
	resetMailpit(t)

	if err := sender.Send(context.Background(), TestMessage("admin@example.com", "smtp")); err != nil {
		t.Fatalf("Send: %v", err)
	}

	msg := latestMessage(t)
	if len(msg.To) != 1 || msg.To[0].Address != "admin@example.com" {
		t.Errorf("To = %+v", msg.To)
	}
	if msg.Subject != "Test message from your workspace" {
		t.Errorf("Subject = %q", msg.Subject)
	}
	if !strings.Contains(msg.Text, "via smtp") {
		t.Errorf("test message should name the transport it went through:\n%s", msg.Text)
	}
	// Both alternatives, so the diagnostic exercises the same multipart shape
	// a real invite or reset does.
	if msg.Text == "" || msg.HTML == "" {
		t.Error("expected a multipart/alternative message with both bodies")
	}
	for _, want := range []string{"Återställ", "æøå", "日本語"} {
		if !strings.Contains(msg.Text, want) {
			t.Errorf("plain-text body mangled %q:\n%s", want, msg.Text)
		}
		if !strings.Contains(msg.HTML, want) {
			t.Errorf("HTML body mangled %q:\n%s", want, msg.HTML)
		}
	}
}
