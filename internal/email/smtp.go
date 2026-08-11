package email

import (
	"context"
	"crypto/tls"
	"fmt"
	"strconv"
	"time"

	"github.com/wneessen/go-mail"
)

// smtpTimeout bounds the whole SMTP conversation so a black-holed relay
// cannot pin an HTTP request open for the caller's full timeout.
const smtpTimeout = 10 * time.Second

// SMTPSender delivers mail through any SMTP relay.
type SMTPSender struct {
	client *mail.Client
	from   string
}

// NewSMTPSender builds a sender from raw config values. An empty host yields
// ErrNotConfigured so the caller can wire a nil Sender and run without mail.
//
// Port selects the transport the way relays conventionally do: 465 is SMTPS
// (TLS from the first byte), anything else starts in the clear and upgrades
// via STARTTLS when the server advertises it. TLS is opportunistic rather
// than mandatory so a trusted local relay (or a dev container such as
// Mailpit) still works — matching what the port already implies.
func NewSMTPSender(host, port, username, password, from string) (*SMTPSender, error) {
	if host == "" {
		return nil, ErrNotConfigured
	}
	if port == "" {
		port = "587"
	}
	portNum, err := strconv.Atoi(port)
	if err != nil {
		return nil, fmt.Errorf("email: invalid SMTP port %q: %w", port, err)
	}

	opts := []mail.Option{
		mail.WithPort(portNum),
		mail.WithTimeout(smtpTimeout),
		mail.WithTLSPolicy(mail.TLSOpportunistic),
	}
	if portNum == 465 {
		opts = append(opts, mail.WithSSL())
	}
	if username != "" {
		opts = append(opts,
			mail.WithSMTPAuth(mail.SMTPAuthPlain),
			mail.WithUsername(username),
			mail.WithPassword(password),
		)
	}

	client, err := mail.NewClient(host, opts...)
	if err != nil {
		return nil, fmt.Errorf("email: smtp client: %w", err)
	}
	// Fail fast on a malformed sender rather than at the first send.
	if _, err := build(from, Message{To: "probe@example.com"}); err != nil {
		return nil, err
	}
	return &SMTPSender{client: client, from: from}, nil
}

// Send delivers one message over SMTP.
func (s *SMTPSender) Send(ctx context.Context, msg Message) error {
	m, err := build(s.from, msg)
	if err != nil {
		return err
	}
	if err := s.client.DialAndSendWithContext(ctx, m); err != nil {
		return fmt.Errorf("email: smtp send: %w", err)
	}
	return nil
}

// setTLSConfig points the client at a specific TLS configuration. Production
// uses the library defaults (verify against the system roots); tests inject a
// config trusting their throwaway CA.
func (s *SMTPSender) setTLSConfig(cfg *tls.Config) error {
	return s.client.SetTLSConfig(cfg)
}
