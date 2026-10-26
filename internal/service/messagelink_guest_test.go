package service

import (
	"context"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func newGuestAwareMessageLinkService() *MessageLinkService {
	svc := newTestMessageLinkService()
	svc.users = fakeMLUsers{byID: map[string]*model.User{
		"u-author":     {ID: "u-author", DisplayName: "Günter"},
		"stranger":     {ID: "stranger", SystemRole: model.SystemRoleMember},
		"guest-viewer": {ID: "guest-viewer", SystemRole: model.SystemRoleGuest},
	}}
	return svc
}

// Regression: a guest only sees the channels they were invited to, yet a
// pasted link to a public channel they never joined unfurled its message.
func TestMessageLinkPreviewHidesPublicChannelsFromNonMemberGuests(t *testing.T) {
	svc := newGuestAwareMessageLinkService()
	p, internal := svc.Preview(context.Background(), "guest-viewer", "https://ex.test/channel/public#msg-pm1")
	if !internal || p != nil {
		t.Fatalf("guest preview of an unjoined public channel = %+v (internal=%v), want none", p, internal)
	}
	// A member of the workspace still sees public channels before joining.
	if p, _ := svc.Preview(context.Background(), "stranger", "https://ex.test/channel/public#msg-pm1"); p == nil {
		t.Fatal("a member must still preview a public channel")
	}
}

// A guest who belongs to the channel sees it; a viewer whose role can't be
// read is treated like a guest (fail closed).
func TestMessageLinkPreviewGuestMembershipAndUnknownViewer(t *testing.T) {
	svc := newGuestAwareMessageLinkService()
	svc.memberships = fakeMLMemberships{members: map[string]bool{"ch-pub#guest-viewer": true}}
	if p, _ := svc.Preview(context.Background(), "guest-viewer", "https://ex.test/channel/public#msg-pm1"); p == nil {
		t.Fatal("a guest member must preview their own channel")
	}
	if p, internal := svc.Preview(context.Background(), "nobody", "https://ex.test/channel/public#msg-pm1"); !internal || p != nil {
		t.Fatalf("unknown viewer preview = %+v, want none", p)
	}
}
