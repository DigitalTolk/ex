package service

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func TestChannel_SearchPublic_NilSearcher(t *testing.T) {
	svc, _, _, _, _ := setupChannelService() // no searcher wired
	res, err := svc.SearchPublic(context.Background(), "u1", "query", 10)
	if err != nil || res != nil {
		t.Fatalf("nil searcher should return (nil,nil), got %v %v", res, err)
	}
}

func TestChannel_GuestBrowse_ListError(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	memberships.listChannelsErr = errors.New("boom")
	if _, _, err := svc.guestBrowse(context.Background(), "u1"); err == nil {
		t.Fatal("expected list-channels error")
	}
}

// A guest's directory is their own live public channels, like everyone
// else's: an archived one is found by searching the directory instead.
func TestChannel_GuestBrowse_FiltersToLivePublic(t *testing.T) {
	svc, channels, memberships, _, _ := setupChannelService()
	memberships.userChannels = []*model.UserChannel{
		{UserID: "u1", ChannelID: "pub"},
		{UserID: "u1", ChannelID: "priv"},
		{UserID: "u1", ChannelID: "old"},
	}
	channels.channels["pub"] = &model.Channel{ID: "pub", Type: model.ChannelTypePublic}
	channels.channels["priv"] = &model.Channel{ID: "priv", Type: model.ChannelTypePrivate}
	channels.channels["old"] = &model.Channel{ID: "old", Type: model.ChannelTypePublic, Archived: true}
	out, _, err := svc.guestBrowse(context.Background(), "u1")
	if err != nil {
		t.Fatalf("guestBrowse: %v", err)
	}
	if len(out) != 1 || out[0].ID != "pub" {
		t.Fatalf("expected only the live public channel, got %+v", out)
	}
}
