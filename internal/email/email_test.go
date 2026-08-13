package email

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"errors"
	"io"
	"math/big"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"strings"
	"sync"
	"testing"
	"time"
)

// The SMTP tests drive a REAL SMTP conversation against an in-process server
// rather than stubbing the send. MIME assembly and the protocol exchange are
// go-mail's job now, so what these assert is OUR wiring: that the configured
// transport/auth/TLS options reach the relay, and that a relay rejecting at
// any step surfaces as an error rather than a silently dropped invite.

// fakeSMTP is a scriptable SMTP server. failAt names the command verb it
// should reject ("AUTH", "MAIL", "RCPT", "DATA", "BODY"), so a test can
// reproduce a relay failing at any point in the exchange.
type fakeSMTP struct {
	t          *testing.T
	listener   net.Listener
	failAt     string
	noSTARTTLS bool
	requireTLS bool
	tlsConfig  *tls.Config

	mu       sync.Mutex
	received []string // raw DATA payloads
	authSeen bool
	tlsSeen  bool
}

func newFakeSMTP(t *testing.T, opts func(*fakeSMTP)) *fakeSMTP {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	s := &fakeSMTP{t: t, listener: ln, tlsConfig: serverTLSConfig(t)}
	if opts != nil {
		opts(s)
	}
	if s.requireTLS {
		s.listener = tls.NewListener(ln, s.tlsConfig)
	}
	go s.serve()
	t.Cleanup(func() { _ = s.listener.Close() })
	return s
}

func (s *fakeSMTP) addr() (host, port string) {
	host, port, err := net.SplitHostPort(s.listener.Addr().String())
	if err != nil {
		s.t.Fatalf("split addr: %v", err)
	}
	return host, port
}

func (s *fakeSMTP) serve() {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		go s.handle(conn)
	}
}

func (s *fakeSMTP) handle(conn net.Conn) {
	defer func() { _ = conn.Close() }()
	r := bufio.NewReader(conn)
	write := func(line string) bool {
		_, err := io.WriteString(conn, line+"\r\n")
		return err == nil
	}
	if !write("220 fake ESMTP") {
		return
	}
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		verb, _, _ := strings.Cut(strings.TrimRight(line, "\r\n"), " ")
		verb = strings.ToUpper(verb)
		switch verb {
		case "EHLO":
			ext := []string{"250-fake", "250 AUTH PLAIN"}
			if !s.noSTARTTLS && !s.requireTLS {
				ext = []string{"250-fake", "250-STARTTLS", "250 AUTH PLAIN"}
			}
			for _, e := range ext {
				if !write(e) {
					return
				}
			}
		case "STARTTLS":
			if !write("220 go ahead") {
				return
			}
			tlsConn := tls.Server(conn, s.tlsConfig)
			if err := tlsConn.Handshake(); err != nil {
				return
			}
			s.mark(func() { s.tlsSeen = true })
			conn = tlsConn
			r = bufio.NewReader(tlsConn)
			write = func(line string) bool {
				_, err := io.WriteString(tlsConn, line+"\r\n")
				return err == nil
			}
		case "AUTH":
			s.mark(func() { s.authSeen = true })
			if s.failAt == "AUTH" {
				if !write("535 bad credentials") {
					return
				}
				continue
			}
			if !write("235 ok") {
				return
			}
		case "MAIL", "RCPT":
			if s.failAt == verb {
				if !write("550 rejected") {
					return
				}
				continue
			}
			if !write("250 ok") {
				return
			}
		case "DATA":
			if s.failAt == "DATA" {
				if !write("451 not now") {
					return
				}
				continue
			}
			if !write("354 send it") {
				return
			}
			var body strings.Builder
			for {
				dl, err := r.ReadString('\n')
				if err != nil {
					return
				}
				if dl == ".\r\n" {
					break
				}
				body.WriteString(dl)
			}
			s.mark(func() { s.received = append(s.received, body.String()) })
			if s.failAt == "BODY" {
				if !write("554 rejected after data") {
					return
				}
				continue
			}
			if !write("250 queued") {
				return
			}
		case "QUIT":
			_ = write("221 bye")
			return
		default:
			if !write("250 ok") {
				return
			}
		}
	}
}

func (s *fakeSMTP) mark(fn func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn()
}

func (s *fakeSMTP) lastMessage() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.received) == 0 {
		return ""
	}
	return s.received[len(s.received)-1]
}

// serverTLSConfig mints a throwaway self-signed cert for 127.0.0.1.
func serverTLSConfig(t *testing.T) *tls.Config {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "127.0.0.1"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create cert: %v", err)
	}
	return &tls.Config{
		Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}},
		MinVersion:   tls.VersionTLS12,
	}
}

// newSender points a sender at the fake server, trusting its throwaway cert.
func newSender(t *testing.T, s *fakeSMTP, username, password string) *SMTPSender {
	t.Helper()
	host, port := s.addr()
	sender, err := NewSMTPSender(host, port, username, password, "Ex <noreply@ex.example.com>")
	if err != nil {
		t.Fatalf("NewSMTPSender: %v", err)
	}
	// The fake server's cert is self-signed; trust it explicitly rather than
	// disabling verification, so the STARTTLS path is genuinely exercised.
	if err := sender.setTLSConfig(&tls.Config{
		RootCAs: certPool(t, s), ServerName: "127.0.0.1", MinVersion: tls.VersionTLS12,
	}); err != nil {
		t.Fatalf("setTLSConfig: %v", err)
	}
	return sender
}

func certPool(t *testing.T, s *fakeSMTP) *x509.CertPool {
	t.Helper()
	pool := x509.NewCertPool()
	leaf, err := x509.ParseCertificate(s.tlsConfig.Certificates[0].Certificate[0])
	if err != nil {
		t.Fatalf("parse cert: %v", err)
	}
	pool.AddCert(leaf)
	return pool
}

func testMessage() Message {
	return Message{
		To:      "guest@example.com",
		Subject: "Reset your password",
		Text:    "plain body",
		HTML:    "<p>html body</p>",
	}
}

// The happy path: STARTTLS is taken when offered, credentials are presented,
// and the message arrives with both alternatives intact.
func TestSMTPSender_SendOverSTARTTLS(t *testing.T) {
	server := newFakeSMTP(t, nil)
	sender := newSender(t, server, "user", "pass")

	if err := sender.Send(context.Background(), testMessage()); err != nil {
		t.Fatalf("Send = %v", err)
	}
	if !server.tlsSeen {
		t.Error("STARTTLS was offered but not used — credentials would cross in the clear")
	}
	if !server.authSeen {
		t.Error("credentials were configured but never presented")
	}

	raw := server.lastMessage()
	if !strings.Contains(raw, "noreply@ex.example.com") {
		t.Errorf("From header missing:\n%s", raw)
	}
	if !strings.Contains(raw, "guest@example.com") {
		t.Errorf("To header missing:\n%s", raw)
	}
	if !strings.Contains(raw, "Auto-Submitted: auto-generated") {
		t.Errorf("Auto-Submitted header missing (invites would risk auto-responder loops):\n%s", raw)
	}
	text, html := decodeAlternative(t, raw)
	if text != "plain body" {
		t.Errorf("text part = %q, want %q", text, "plain body")
	}
	if html != "<p>html body</p>" {
		t.Errorf("html part = %q, want %q", html, "<p>html body</p>")
	}
}

// Port 465 establishes TLS before the greeting; there is no STARTTLS phase.
func TestSMTPSender_SendOverImplicitTLS(t *testing.T) {
	server := newFakeSMTP(t, func(s *fakeSMTP) { s.requireTLS = true })
	host, port := server.addr()
	sender, err := NewSMTPSender(host, port, "", "", "noreply@ex.example.com")
	if err != nil {
		t.Fatalf("NewSMTPSender: %v", err)
	}
	// Force SMTPS: the fake server listens on an ephemeral port, so it can't
	// literally be 465.
	sender.client.SetSSL(true)
	if err := sender.setTLSConfig(&tls.Config{
		RootCAs: certPool(t, server), ServerName: "127.0.0.1", MinVersion: tls.VersionTLS12,
	}); err != nil {
		t.Fatalf("setTLSConfig: %v", err)
	}

	if err := sender.Send(context.Background(), testMessage()); err != nil {
		t.Fatalf("Send = %v", err)
	}
	if server.lastMessage() == "" {
		t.Error("no message received over implicit TLS")
	}
}

// A server that offers no STARTTLS still gets the message: TLS is
// opportunistic, so a trusted local relay is a legitimate deployment.
func TestSMTPSender_SendWithoutSTARTTLS(t *testing.T) {
	server := newFakeSMTP(t, func(s *fakeSMTP) { s.noSTARTTLS = true })
	sender := newSender(t, server, "", "")

	if err := sender.Send(context.Background(), testMessage()); err != nil {
		t.Fatalf("Send = %v", err)
	}
	if server.tlsSeen {
		t.Error("STARTTLS was used against a server that never offered it")
	}
	if server.authSeen {
		t.Error("AUTH was attempted with no credentials configured")
	}
}

// A text-only message is sent as a single part, not an empty multipart.
func TestSMTPSender_SendTextOnly(t *testing.T) {
	server := newFakeSMTP(t, nil)
	sender := newSender(t, server, "", "")

	msg := testMessage()
	msg.HTML = ""
	if err := sender.Send(context.Background(), msg); err != nil {
		t.Fatalf("Send = %v", err)
	}
	raw := server.lastMessage()
	if strings.Contains(raw, "multipart/alternative") {
		t.Errorf("text-only message was sent as multipart:\n%s", raw)
	}
	if !strings.Contains(raw, "text/plain") {
		t.Errorf("missing text/plain content type:\n%s", raw)
	}
}

// Every step of the exchange is checked: a relay that rejects at any point
// must surface as an error, never as a silently dropped invite.
func TestSMTPSender_ServerFailures(t *testing.T) {
	for _, failAt := range []string{"AUTH", "MAIL", "RCPT", "DATA", "BODY"} {
		t.Run(failAt, func(t *testing.T) {
			server := newFakeSMTP(t, func(s *fakeSMTP) { s.failAt = failAt })
			sender := newSender(t, server, "user", "pass")

			err := sender.Send(context.Background(), testMessage())
			if err == nil {
				t.Fatalf("Send succeeded despite the server rejecting at %s", failAt)
			}
			if !strings.Contains(err.Error(), "smtp send") {
				t.Errorf("err = %v, want it wrapped as an smtp send failure", err)
			}
		})
	}
}

func TestSMTPSender_STARTTLSFailure(t *testing.T) {
	server := newFakeSMTP(t, nil)
	sender := newSender(t, server, "", "")
	// Trust nothing: the STARTTLS handshake must fail verification.
	if err := sender.setTLSConfig(&tls.Config{
		RootCAs: x509.NewCertPool(), ServerName: "127.0.0.1", MinVersion: tls.VersionTLS12,
	}); err != nil {
		t.Fatalf("setTLSConfig: %v", err)
	}

	if err := sender.Send(context.Background(), testMessage()); err == nil {
		t.Fatal("expected the TLS verification failure to surface")
	}
}

func TestSMTPSender_DialFailure(t *testing.T) {
	server := newFakeSMTP(t, nil)
	host, port := server.addr()
	// Close the listener so nothing is accepting on that port.
	_ = server.listener.Close()
	sender, err := NewSMTPSender(host, port, "", "", "noreply@ex.example.com")
	if err != nil {
		t.Fatalf("NewSMTPSender: %v", err)
	}

	if err := sender.Send(context.Background(), testMessage()); err == nil {
		t.Fatal("expected a dial failure")
	}
}

func TestSMTPSender_InvalidRecipient(t *testing.T) {
	server := newFakeSMTP(t, nil)
	sender := newSender(t, server, "", "")

	msg := testMessage()
	msg.To = "not an address"
	if err := sender.Send(context.Background(), msg); err == nil ||
		!strings.Contains(err.Error(), "invalid recipient") {
		t.Fatalf("err = %v, want an invalid-recipient error", err)
	}
}

func TestNewSMTPSender(t *testing.T) {
	t.Run("no host is opt-out, not an error to shout about", func(t *testing.T) {
		_, err := NewSMTPSender("", "587", "", "", "noreply@example.com")
		if !errors.Is(err, ErrNotConfigured) {
			t.Fatalf("err = %v, want ErrNotConfigured", err)
		}
	})

	t.Run("malformed from address fails fast", func(t *testing.T) {
		if _, err := NewSMTPSender("smtp.example.com", "587", "", "", "not an address"); err == nil {
			t.Fatal("expected a malformed SMTP_FROM to be rejected at construction")
		}
	})

	t.Run("non-numeric port", func(t *testing.T) {
		if _, err := NewSMTPSender("smtp.example.com", "not-a-port", "", "", "noreply@example.com"); err == nil {
			t.Fatal("expected a non-numeric port to be rejected")
		}
	})

	t.Run("out-of-range port", func(t *testing.T) {
		_, err := NewSMTPSender("smtp.example.com", "70000", "", "", "noreply@example.com")
		if err == nil || !strings.Contains(err.Error(), "smtp client") {
			t.Fatalf("err = %v, want the client construction to reject the port", err)
		}
	})

	t.Run("empty port defaults to 587", func(t *testing.T) {
		if _, err := NewSMTPSender("smtp.example.com", "", "", "", "noreply@example.com"); err != nil {
			t.Fatalf("NewSMTPSender: %v", err)
		}
	})

	t.Run("port 465 selects implicit TLS", func(t *testing.T) {
		if _, err := NewSMTPSender("smtp.example.com", "465", "", "", "noreply@example.com"); err != nil {
			t.Fatalf("NewSMTPSender: %v", err)
		}
	})

	t.Run("an empty host wins over a bad port", func(t *testing.T) {
		if _, err := NewSMTPSender("", "nonsense", "", "", "noreply@example.com"); !errors.Is(err, ErrNotConfigured) {
			t.Fatalf("err = %v, want ErrNotConfigured", err)
		}
	})
}

// A non-ASCII subject must be RFC 2047 encoded, not sent raw — the library
// owns this, and this test pins that we actually get the behaviour.
func TestSubjectIsEncoded(t *testing.T) {
	server := newFakeSMTP(t, nil)
	sender := newSender(t, server, "", "")
	msg := testMessage()
	msg.Subject = "Återställ ditt lösenord"

	if err := sender.Send(context.Background(), msg); err != nil {
		t.Fatalf("Send = %v", err)
	}
	raw := server.lastMessage()
	if strings.Contains(raw, msg.Subject) {
		t.Error("non-ASCII subject was sent raw instead of RFC 2047 encoded")
	}
	subject := headerValue(t, raw, "Subject")
	got, err := (&mime.WordDecoder{}).DecodeHeader(subject)
	if err != nil {
		t.Fatalf("decode subject: %v", err)
	}
	if got != msg.Subject {
		t.Errorf("decoded subject = %q, want %q", got, msg.Subject)
	}
}

// --- helpers ---

func headerValue(t *testing.T, raw, name string) string {
	t.Helper()
	m, err := mail.ReadMessage(strings.NewReader(raw))
	if err != nil {
		t.Fatalf("parse message: %v", err)
	}
	return m.Header.Get(name)
}

// decodeAlternative pulls the text and html parts out of a multipart message,
// asserting the RFC 2046 ordering (worst alternative first).
func decodeAlternative(t *testing.T, raw string) (text, html string) {
	t.Helper()
	m, err := mail.ReadMessage(strings.NewReader(raw))
	if err != nil {
		t.Fatalf("parse message: %v", err)
	}
	_, params, err := mime.ParseMediaType(m.Header.Get("Content-Type"))
	if err != nil {
		t.Fatalf("parse content type: %v", err)
	}
	mr := multipart.NewReader(m.Body, params["boundary"])
	var order []string
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("next part: %v", err)
		}
		body, err := io.ReadAll(part)
		if err != nil {
			t.Fatalf("read part: %v", err)
		}
		ct := part.Header.Get("Content-Type")
		order = append(order, ct)
		decoded := decodePart(t, string(body), part.Header.Get("Content-Transfer-Encoding"))
		switch {
		case strings.HasPrefix(ct, "text/plain"):
			text = decoded
		case strings.HasPrefix(ct, "text/html"):
			html = decoded
		}
	}
	if len(order) != 2 || !strings.HasPrefix(order[0], "text/plain") {
		t.Errorf("part order = %v, want text/plain before text/html", order)
	}
	return text, html
}

// decodePart undoes whichever transfer encoding the library chose, so these
// tests assert on content rather than on go-mail's encoding policy.
func decodePart(t *testing.T, body, encoding string) string {
	t.Helper()
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "base64":
		out, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(strings.TrimSpace(body), "\r\n", ""))
		if err != nil {
			t.Fatalf("decode base64 part: %v", err)
		}
		return string(out)
	case "quoted-printable":
		out, err := io.ReadAll(quotedprintable.NewReader(strings.NewReader(body)))
		if err != nil {
			t.Fatalf("decode quoted-printable part: %v", err)
		}
		return strings.TrimRight(string(out), "\r\n")
	default:
		return strings.TrimRight(body, "\r\n")
	}
}
