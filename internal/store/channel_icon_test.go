//go:build integration

package store

import (
	"context"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// An icon patch sets, replaces and removes the channel's icon and touches
// nothing else on the row; a patch without one leaves the icon alone.
func TestChannelStore_PatchChannelIcon(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewChannelStore(db)
	ctx := context.Background()
	ch := makeChannel("ch-icon", "icon", "icon", model.ChannelTypePublic)
	ch.Description = "launches"
	if err := s.CreateChannel(ctx, ch); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := s.IncrementMessageSeq(ctx, ch.ID); err != nil {
		t.Fatalf("IncrementMessageSeq: %v", err)
	}

	str := func(v string) *string { return &v }
	steps := []struct {
		name  string
		patch ChannelPatch
		want  string
	}{
		{name: "set", patch: ChannelPatch{Icon: str("🚀")}, want: "🚀"},
		{name: "replaced by a name", patch: ChannelPatch{Icon: str("tada")}, want: "tada"},
		{name: "kept by a patch of something else", patch: ChannelPatch{Description: str("launch days")}, want: "tada"},
		{name: "removed", patch: ChannelPatch{Icon: str("")}, want: ""},
		{name: "removed again", patch: ChannelPatch{Icon: str("")}, want: ""},
	}
	at := ch.UpdatedAt
	for _, step := range steps {
		at = at.Add(time.Minute)
		step.patch.UpdatedAt = at
		if err := s.PatchChannel(ctx, ch.ID, step.patch); err != nil {
			t.Fatalf("%s: PatchChannel: %v", step.name, err)
		}
		got, err := s.GetChannel(ctx, ch.ID)
		if err != nil {
			t.Fatalf("%s: GetChannel: %v", step.name, err)
		}
		if got.Icon != step.want {
			t.Errorf("%s: icon = %q, want %q", step.name, got.Icon, step.want)
		}
		if got.Name != "icon" || got.Slug != "icon" || got.Type != model.ChannelTypePublic || got.MessageSeq != 1 || !got.UpdatedAt.Equal(at) {
			t.Errorf("%s: channel = %+v, want only the patched fields changed", step.name, got)
		}
	}
	if got, _ := s.GetChannel(ctx, ch.ID); got.Description != "launch days" {
		t.Errorf("description = %q, want it kept through the icon patches", got.Description)
	}
}
