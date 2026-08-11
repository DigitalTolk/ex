package service

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

func TestMMUsername(t *testing.T) {
	tests := []struct {
		name        string
		email       string
		displayName string
		userID      string
		want        string
	}{
		{name: "email local part wins", email: "anna.smith@example.com", displayName: "Anna Smith", want: "anna.smith"},
		{name: "uppercase is folded", email: "Anna.Smith@example.com", want: "anna.smith"},
		{
			// Unsupported runes collapse to a single separator rather than vanishing,
			// so the result still reads like the original name.
			name: "non-ascii collapses to separators", displayName: "Anna Ström", want: "anna-str-m",
		},
		{name: "falls back to the display name", displayName: "Build Bot", want: "build-bot"},
		{name: "falls back to the user id", userID: "01hxyz", want: "01hxyz"},
		{
			// Everything unusable → a constant, never an empty user_name field.
			name: "nothing usable yields a placeholder", email: "a@b", displayName: "x", userID: "y", want: "user",
		},
		{
			name:  "over-long input is truncated to MM's limit",
			email: "averyveryverylongusernameindeed@example.com",
			want:  "averyveryverylongusern",
		},
		{name: "separators are trimmed from the edges", displayName: "  --Bot--  ", want: "bot"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := MMUsername(tc.email, tc.displayName, tc.userID); got != tc.want {
				t.Errorf("MMUsername(%q, %q, %q) = %q, want %q", tc.email, tc.displayName, tc.userID, got, tc.want)
			}
		})
	}
}

func TestMMChannelType(t *testing.T) {
	if got := MMChannelTypeFor(ParentConversation); got != mmChannelTypeDirect {
		t.Errorf("conversation → %q, want %q", got, mmChannelTypeDirect)
	}
	if got := MMChannelTypeFor(ParentChannel); got != mmChannelTypeOpen {
		t.Errorf("channel → %q, want %q", got, mmChannelTypeOpen)
	}
	if got := MMChannelTypeForVisibility(model.ChannelTypePrivate); got != mmChannelTypePrivate {
		t.Errorf("private channel → %q, want %q", got, mmChannelTypePrivate)
	}
	if got := MMChannelTypeForVisibility(model.ChannelTypePublic); got != mmChannelTypeOpen {
		t.Errorf("public channel → %q, want %q", got, mmChannelTypeOpen)
	}
}

// A nil resolver must never fail a dispatch — the names are cosmetic, the ids are
// what an integration acts on.
func TestResolveMMContext_NilResolver(t *testing.T) {
	got := resolveMMContext(context.Background(), nil, "ch1", ParentChannel, "u1")
	if got.ChannelName != "" || got.UserName != "" {
		t.Errorf("names = %+v, want empty without a resolver", got)
	}
	if got.ChannelType != mmChannelTypeOpen {
		t.Errorf("ChannelType = %q, want the parent-type default", got.ChannelType)
	}
}

// A resolver that answers with an empty type must not blank out the default.
func TestResolveMMContext_EmptyTypeKeepsDefault(t *testing.T) {
	got := resolveMMContext(context.Background(), blankTypeResolver{}, "conv1", ParentConversation, "")
	if got.ChannelType != mmChannelTypeDirect {
		t.Errorf("ChannelType = %q, want the parent-type default retained", got.ChannelType)
	}
	if got.UserName != "" {
		t.Error("UserContext must not be consulted for an empty user id")
	}
}

type blankTypeResolver struct{}

func (blankTypeResolver) ChannelContext(context.Context, string, string) (string, string, string) {
	return "", "", ""
}
func (blankTypeResolver) UserContext(context.Context, string) (string, string) { return "set", "set" }

// --- MMContextResolver -----------------------------------------------------

type fakeMMChannels struct {
	ch  *model.Channel
	err error
}

func (f fakeMMChannels) GetChannel(context.Context, string) (*model.Channel, error) {
	return f.ch, f.err
}

type fakeMMUsers struct {
	u   *model.User
	err error
}

func (f fakeMMUsers) GetUser(context.Context, string) (*model.User, error) { return f.u, f.err }

func TestMMContextResolver(t *testing.T) {
	ctx := context.Background()

	t.Run("resolves a channel's name, slug, and visibility", func(t *testing.T) {
		r := NewMMContextResolver(fakeMMChannels{ch: &model.Channel{
			Name: "Releases", Slug: "releases", Type: model.ChannelTypePrivate,
		}}, nil)
		name, slug, mmType := r.ChannelContext(ctx, "ch1", ParentChannel)
		if name != "Releases" || slug != "releases" || mmType != mmChannelTypePrivate {
			t.Errorf("got (%q, %q, %q)", name, slug, mmType)
		}
	})

	t.Run("a conversation reports only its type", func(t *testing.T) {
		// ex conversations are identified by their participants, so inventing a name
		// would put participant identities into a payload MM never promises.
		r := NewMMContextResolver(fakeMMChannels{}, nil)
		name, slug, mmType := r.ChannelContext(ctx, "conv1", ParentConversation)
		if name != "" || slug != "" || mmType != mmChannelTypeDirect {
			t.Errorf("got (%q, %q, %q), want only the direct type", name, slug, mmType)
		}
	})

	t.Run("a lookup failure degrades to empty names", func(t *testing.T) {
		r := NewMMContextResolver(fakeMMChannels{err: errors.New("boom")}, fakeMMUsers{err: store.ErrNotFound})
		name, slug, mmType := r.ChannelContext(ctx, "ch1", ParentChannel)
		if name != "" || slug != "" || mmType != mmChannelTypeOpen {
			t.Errorf("got (%q, %q, %q), want empty names and the default type", name, slug, mmType)
		}
		if user, display := r.UserContext(ctx, "u1"); user != "" || display != "" {
			t.Errorf("got (%q, %q), want empty on a failed lookup", user, display)
		}
	})

	t.Run("a nil channel row degrades to empty names", func(t *testing.T) {
		r := NewMMContextResolver(fakeMMChannels{}, fakeMMUsers{})
		name, _, _ := r.ChannelContext(ctx, "ch1", ParentChannel)
		if name != "" {
			t.Errorf("name = %q, want empty for a nil row", name)
		}
		if user, _ := r.UserContext(ctx, "u1"); user != "" {
			t.Errorf("username = %q, want empty for a nil row", user)
		}
	})

	t.Run("nil stores and an empty user id are safe", func(t *testing.T) {
		r := NewMMContextResolver(nil, nil)
		if _, _, mmType := r.ChannelContext(ctx, "ch1", ParentChannel); mmType != mmChannelTypeOpen {
			t.Error("a nil channel store must still report the default type")
		}
		if user, _ := r.UserContext(ctx, ""); user != "" {
			t.Error("an empty user id must not be looked up")
		}
	})

	t.Run("derives the username from the user row", func(t *testing.T) {
		r := NewMMContextResolver(nil, fakeMMUsers{u: &model.User{
			ID: "u1", Email: "anna.smith@example.com", DisplayName: "Anna Smith",
		}})
		user, display := r.UserContext(ctx, "u1")
		if user != "anna.smith" || display != "Anna Smith" {
			t.Errorf("got (%q, %q)", user, display)
		}
	})
}
