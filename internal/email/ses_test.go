package email

import (
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sesv2"
	"github.com/wneessen/go-mail"
)

// fakeSES records SendEmail calls in place of the real SES API.
type fakeSES struct {
	mu    sync.Mutex
	calls []*sesv2.SendEmailInput
	err   error
}

func (f *fakeSES) SendEmail(_ context.Context, in *sesv2.SendEmailInput, _ ...func(*sesv2.Options)) (*sesv2.SendEmailOutput, error) {
	if f.err != nil {
		return nil, f.err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, in)
	return &sesv2.SendEmailOutput{MessageId: aws.String("ses-msg-1")}, nil
}

func (f *fakeSES) last() *sesv2.SendEmailInput {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.calls) == 0 {
		return nil
	}
	return f.calls[len(f.calls)-1]
}

func newSESSenderWithAPI(api SESAPI, configSet string) *SESSender {
	return &SESSender{api: api, from: "Ex <noreply@ex.example.com>", configurationSet: configSet}
}

// SES receives the same MIME the SMTP transport would send — one
// body-construction path, so the two can't drift.
func TestSESSender_Send(t *testing.T) {
	api := &fakeSES{}
	sender := newSESSenderWithAPI(api, "")

	if err := sender.Send(context.Background(), testMessage()); err != nil {
		t.Fatalf("Send = %v", err)
	}
	in := api.last()
	if in == nil {
		t.Fatal("SendEmail was never called")
	}
	if in.Content == nil || in.Content.Raw == nil {
		t.Fatal("message was not sent as raw MIME")
	}
	raw := string(in.Content.Raw.Data)
	if !strings.Contains(raw, "Auto-Submitted: auto-generated") {
		t.Errorf("raw MIME is missing our headers:\n%s", raw)
	}
	text, html := decodeAlternative(t, raw)
	if text != "plain body" || html != "<p>html body</p>" {
		t.Errorf("parts = (%q, %q), want the plain and html bodies", text, html)
	}
	if aws.ToString(in.FromEmailAddress) != "Ex <noreply@ex.example.com>" {
		t.Errorf("FromEmailAddress = %q", aws.ToString(in.FromEmailAddress))
	}
	if in.Destination == nil || len(in.Destination.ToAddresses) != 1 ||
		in.Destination.ToAddresses[0] != "guest@example.com" {
		t.Errorf("Destination = %+v, want the single recipient", in.Destination)
	}
	if in.ConfigurationSetName != nil {
		t.Errorf("ConfigurationSetName = %q, want unset", aws.ToString(in.ConfigurationSetName))
	}
}

// A configuration set is how SES publishes bounce/complaint events, so it must
// reach the API when configured.
func TestSESSender_ConfigurationSet(t *testing.T) {
	api := &fakeSES{}
	sender := newSESSenderWithAPI(api, "ex-transactional")

	if err := sender.Send(context.Background(), testMessage()); err != nil {
		t.Fatalf("Send = %v", err)
	}
	if got := aws.ToString(api.last().ConfigurationSetName); got != "ex-transactional" {
		t.Errorf("ConfigurationSetName = %q, want ex-transactional", got)
	}
}

// A rejected send must surface: SES is the only delivery path when it is the
// configured transport.
func TestSESSender_APIError(t *testing.T) {
	api := &fakeSES{err: errors.New("MessageRejected: email address is not verified")}
	sender := newSESSenderWithAPI(api, "")

	err := sender.Send(context.Background(), testMessage())
	if err == nil || !strings.Contains(err.Error(), "ses send") {
		t.Fatalf("err = %v, want a wrapped ses send failure", err)
	}
}

func TestSESSender_InvalidRecipient(t *testing.T) {
	api := &fakeSES{}
	sender := newSESSenderWithAPI(api, "")

	msg := testMessage()
	msg.To = "not an address"
	if err := sender.Send(context.Background(), msg); err == nil ||
		!strings.Contains(err.Error(), "invalid recipient") {
		t.Fatalf("err = %v, want an invalid-recipient error", err)
	}
	if len(api.calls) != 0 {
		t.Error("a malformed recipient still reached the SES API")
	}
}

func TestNewSESSender(t *testing.T) {
	ctx := context.Background()

	t.Run("no region is opt-out, not an error to shout about", func(t *testing.T) {
		_, err := NewSESSender(ctx, SESConfig{From: "noreply@example.com"})
		if !errors.Is(err, ErrNotConfigured) {
			t.Fatalf("err = %v, want ErrNotConfigured", err)
		}
	})

	t.Run("builds with the default credential chain", func(t *testing.T) {
		s, err := NewSESSender(ctx, SESConfig{Region: "eu-north-1", From: "noreply@example.com"})
		if err != nil {
			t.Fatalf("NewSESSender: %v", err)
		}
		if s.api == nil {
			t.Error("no SES client was constructed")
		}
	})

	t.Run("malformed from address fails fast", func(t *testing.T) {
		_, err := NewSESSender(ctx, SESConfig{Region: "eu-north-1", From: "not an address"})
		if err == nil {
			t.Fatal("expected a malformed sender to be rejected at construction")
		}
	})

	t.Run("config load failure surfaces", func(t *testing.T) {
		restore := loadAWSConfig
		loadAWSConfig = func(context.Context, ...func(*awsconfig.LoadOptions) error) (aws.Config, error) {
			return aws.Config{}, errors.New("no credentials")
		}
		defer func() { loadAWSConfig = restore }()

		_, err := NewSESSender(ctx, SESConfig{Region: "eu-north-1", From: "noreply@example.com"})
		if err == nil || !strings.Contains(err.Error(), "ses load config") {
			t.Fatalf("err = %v, want a wrapped config-load failure", err)
		}
	})
}

// A render failure must abort the send rather than hand SES a truncated
// message. Rendering into a buffer cannot fail in production, so the seam is
// what makes the handling testable.
func TestSESSender_RenderFailure(t *testing.T) {
	api := &fakeSES{}
	sender := newSESSenderWithAPI(api, "")
	restore := renderMessage
	renderMessage = func(*mail.Msg, io.Writer) error { return errors.New("render exploded") }
	defer func() { renderMessage = restore }()

	err := sender.Send(context.Background(), testMessage())
	if err == nil || !strings.Contains(err.Error(), "render message") {
		t.Fatalf("err = %v, want a wrapped render failure", err)
	}
	if len(api.calls) != 0 {
		t.Error("a message that failed to render was still sent")
	}
}
