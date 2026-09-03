package service

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func TestChanCov_CreateWithID(t *testing.T) {
	svc, _, _, _, _ := setupChannelService()
	ctx := context.Background()

	// Caller-derived identity: the channel lands with exactly the given ID.
	ch, err := svc.CreateWithID(ctx, "u-1", "ch-derived-1", "proj-acme", model.ChannelTypePublic, "project channel")
	if err != nil {
		t.Fatalf("CreateWithID: %v", err)
	}
	if ch.ID != "ch-derived-1" {
		t.Fatalf("id not honored: %+v", ch)
	}

	if _, err := svc.CreateWithID(ctx, "u-1", "", "nameless", model.ChannelTypePublic, ""); !errors.Is(err, ErrValidation) {
		t.Fatalf("empty id: want ErrValidation, got %v", err)
	}
}
