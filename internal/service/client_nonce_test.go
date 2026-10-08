package service

import (
	"context"
	"testing"
)

func TestClientNonce(t *testing.T) {
	ctx := context.Background()
	if WithClientNonce(ctx, "") != ctx || clientNonce(ctx) != "" {
		t.Fatal("an empty nonce must leave the context alone")
	}
	if got := clientNonce(WithClientNonce(ctx, "n-1")); got != "n-1" {
		t.Fatalf("clientNonce = %q", got)
	}
}
