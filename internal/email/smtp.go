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

// TLSPolicy selects how a plain-port SMTP connection treats STARTTLS.
type TLSPolicy string

const (
	// TLSMandatory requires STARTTLS: a relay that does not offer it (or an
	// on-path attacker stripping it from the EHLO reply) fails the send
	// before any envelope, body, or credential crosses the wire. The
	// default outside development.
	TLSMandatory TLSPolicy = "mandatory"
	// TLSOpportunistic upgrades when the relay offers STARTTLS and falls
	// back to plaintext otherwise — for a trusted local relay or a dev
	// container such as Mailpit. The default in development.
	TLSOpportunistic TLSPolicy = "opportunistic"
	// TLSNone never upgrades, even when STARTTLS is offered.
	TLSNone TLSPolicy = "none"
)

// mailPolicy maps a TLSPolicy onto go-mail's policy enum.
func (p TLSPolicy) mailPolicy() (mail.TLSPolicy, error) {
	switch p {
	case TLSMandatory:
		return mail.TLSMandatory, nil
	case TLSOpportunistic:
		return mail.TLSOpportunistic, nil
	case TLSNone:
		return mail.NoTLS, nil
	default:
		return 0, fmt.Errorf("email: invalid SMTP TLS policy %q: must be %q, %q or %q",
			string(p), TLSMandatory, TLSOpportunistic, TLSNone)
	}
}

// NewSMTPSender builds a sender from raw config values. An empty host yields
// ErrNotConfigured so the caller can wire a nil Sender and run without mail.
//
// Port selects the transport the way relays conventionally do: 465 is SMTPS
// (TLS from the first byte, whatever the policy), anything else starts in
// the clear and applies policy to the STARTTLS upgrade.
func NewSMTPSender(host, port, username, password, from string, policy TLSPolicy) (*SMTPSender, error) {
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
	tlsPolicy, err := policy.mailPolicy()
	if err != nil {
		return nil, err
	}

	opts := []mail.Option{
		mail.WithPort(portNum),
		mail.WithTimeout(smtpTimeout),
		mail.WithTLSPolicy(tlsPolicy),
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
