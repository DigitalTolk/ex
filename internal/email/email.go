// Package email delivers transactional mail (guest invites, password resets).
//
// Two transports share one message-construction path:
//
//   - SMTPSender  — any SMTP relay, via github.com/wneessen/go-mail
//   - SESSender   — Amazon SES natively, via the AWS SDK's sesv2 client
//
// MIME assembly, header encoding, and the SMTP conversation are the library's
// job, not ours: those are exactly the places where a hand-rolled
// implementation quietly gets RFC details wrong (folding, 8-bit bodies,
// non-ASCII headers, STARTTLS downgrade handling).
//
// Mail is a SUPPORTING channel here, not the notification pipeline —
// CLAUDE.md's 100%-delivery contract covers desktop popups and the mobile-push
// fallback, and nothing in this package participates in it. Callers therefore
// treat a send failure as degraded, not fatal: the admin-facing reset flow
// still returns a copyable link when the mail cannot be delivered.
package email

import (
	"context"
	"errors"
	"fmt"

	"github.com/wneessen/go-mail"
)

// ErrNotConfigured reports that no mail transport is configured, so no mail
// can be sent. Callers surface a degraded-but-working path rather than an
// error.
var ErrNotConfigured = errors.New("email: no mail transport is configured")

// Message is one outbound email. Text is required; HTML is optional and, when
// present, is sent as the preferred alternative.
type Message struct {
	To      string
	Subject string
	Text    string
	HTML    string
}

// Sender delivers a Message. Implemented by SMTPSender and SESSender in
// production and by fakes in tests; services hold the interface so the
// transport stays swappable.
type Sender interface {
	Send(ctx context.Context, msg Message) error
}

// build renders a Message into a go-mail message. Both transports go through
// here, so an SMTP relay and SES receive byte-identical MIME.
//
// from accepts both "noreply@example.com" and the display-name form
// "Ex <noreply@example.com>".
func build(from string, msg Message) (*mail.Msg, error) {
	m := mail.NewMsg()
	if err := m.From(from); err != nil {
		return nil, fmt.Errorf("email: invalid from address %q: %w", from, err)
	}
	if err := m.To(msg.To); err != nil {
		return nil, fmt.Errorf("email: invalid recipient %q: %w", msg.To, err)
	}
	m.Subject(msg.Subject)
	m.SetDate()
	m.SetMessageID()
	// Transactional mail must never land in a bulk digest or trigger an
	// auto-responder loop.
	m.SetGenHeader("Auto-Submitted", "auto-generated")

	m.SetBodyString(mail.TypeTextPlain, msg.Text)
	if msg.HTML != "" {
		// Added as the ALTERNATIVE so text/plain stays first: RFC 2046 orders
		// alternatives worst-to-best, and go-mail preserves that ordering.
		m.AddAlternativeString(mail.TypeTextHTML, msg.HTML)
	}
	return m, nil
}
