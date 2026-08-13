package email

import (
	"bytes"
	"context"
	"fmt"
	"io"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sesv2"
	"github.com/aws/aws-sdk-go-v2/service/sesv2/types"
	"github.com/wneessen/go-mail"
)

// SESAPI is the slice of the SES v2 client this package uses, so tests can
// substitute a fake without a network round trip. Mirrors the injectable-client
// pattern used by the DynamoDB and S3 stores.
type SESAPI interface {
	SendEmail(ctx context.Context, params *sesv2.SendEmailInput, optFns ...func(*sesv2.Options)) (*sesv2.SendEmailOutput, error)
}

// SESSender delivers mail through Amazon SES's API rather than its SMTP
// endpoint. Preferred on AWS: it authenticates with the ambient IAM identity
// (task role / IRSA / instance profile), so there are no SMTP credentials to
// mint, store, or rotate.
type SESSender struct {
	api              SESAPI
	from             string
	configurationSet string
}

// SESConfig configures the SES transport.
type SESConfig struct {
	// Region is required; SES is a regional service and the sending identity
	// is verified per-region.
	Region string
	// From is the verified sender identity ("noreply@example.com" or
	// "Ex <noreply@example.com>").
	From string
	// ConfigurationSet is optional; when set, SES publishes delivery,
	// bounce, and complaint events for these sends to it.
	ConfigurationSet string
}

// loadAWSConfig is a seam over awsconfig.LoadDefaultConfig so the
// config-load failure branch can be exercised in tests (same idiom as
// internal/storage).
var loadAWSConfig = awsconfig.LoadDefaultConfig

// renderMessage is a seam over (*mail.Msg).WriteTo. Rendering into an
// in-memory buffer cannot fail in production, but the error must still be
// handled rather than dropped — SES would otherwise be handed a truncated
// message. The seam makes that handling testable.
var renderMessage = func(m *mail.Msg, w io.Writer) error {
	_, err := m.WriteTo(w)
	return err
}

// NewSESSender builds an SES-backed sender. An empty region yields
// ErrNotConfigured so the caller can fall back to SMTP or run without mail.
func NewSESSender(ctx context.Context, cfg SESConfig) (*SESSender, error) {
	if cfg.Region == "" {
		return nil, ErrNotConfigured
	}
	// Credentials come from the default chain (env → task role → IRSA →
	// IMDS). Deliberately NOT the S3 static keys: those point at MinIO in
	// local/dev setups, and feeding them to SES would authenticate the wrong
	// service. For local use, set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY.
	awsCfg, err := loadAWSConfig(ctx, awsconfig.WithRegion(cfg.Region))
	if err != nil {
		return nil, fmt.Errorf("email: ses load config: %w", err)
	}
	// Fail fast on a malformed sender rather than at the first send.
	if _, err := build(cfg.From, Message{To: "probe@example.com"}); err != nil {
		return nil, err
	}
	return &SESSender{
		api:              sesv2.NewFromConfig(awsCfg),
		from:             cfg.From,
		configurationSet: cfg.ConfigurationSet,
	}, nil
}

// Send delivers one message through SES.
//
// The MIME is built locally and handed over as a RAW message rather than
// using SES's Simple content type, so SMTP and SES produce byte-identical
// mail and there is only one body-construction path to reason about. That
// shared path is the one the Mailpit end-to-end suite validates against a real
// mail server, so SES inherits the same guarantee.
func (s *SESSender) Send(ctx context.Context, msg Message) error {
	m, err := build(s.from, msg)
	if err != nil {
		return err
	}
	var buf bytes.Buffer
	if err := renderMessage(m, &buf); err != nil {
		return fmt.Errorf("email: render message: %w", err)
	}

	in := &sesv2.SendEmailInput{
		Content:          &types.EmailContent{Raw: &types.RawMessage{Data: buf.Bytes()}},
		Destination:      &types.Destination{ToAddresses: []string{msg.To}},
		FromEmailAddress: aws.String(s.from),
	}
	if s.configurationSet != "" {
		in.ConfigurationSetName = aws.String(s.configurationSet)
	}
	if _, err := s.api.SendEmail(ctx, in); err != nil {
		return fmt.Errorf("email: ses send: %w", err)
	}
	return nil
}
