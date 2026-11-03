package model

import (
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
)

// A webhook's templates survive DynamoDB as they were saved.
func TestIncomingWebhook_TemplatesRoundTripThroughDynamo(t *testing.T) {
	in := IncomingWebhook{ID: "wh", Kind: WebhookKindRich, Templates: []MessageTemplate{
		{Key: "deploy", Payload: []byte(`{"text":"Deployed {{version}}"}`), UpdatedAt: time.Unix(1767254400, 0).UTC()},
	}}
	av, err := attributevalue.MarshalMap(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out IncomingWebhook
	if err := attributevalue.UnmarshalMap(av, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got := out.Template("deploy"); got == nil || string(got.Payload) != `{"text":"Deployed {{version}}"}` || !got.UpdatedAt.Equal(in.Templates[0].UpdatedAt) {
		t.Fatalf("round trip = %+v", out.Templates)
	}
	if out.Template("missing") != nil {
		t.Fatal("found a template that isn't there")
	}
}

// Only a webhook created rich is rich: every webhook stored before kinds
// existed has none, and stays classic.
func TestIncomingWebhook_IsRich(t *testing.T) {
	if (&IncomingWebhook{}).IsRich() || !(&IncomingWebhook{Kind: WebhookKindRich}).IsRich() {
		t.Fatal("IsRich must hold for rich webhooks only")
	}
}
