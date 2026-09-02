package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// setupInviteMail wires a mailer onto the auth service and returns it.
func setupInviteMail(t *testing.T) (*authTestEnv, *mockMailer) {
	t.Helper()
	env := setupAuthService()
	mailer := &mockMailer{}
	env.svc.SetMailer(mailer, "https://ex.example.com")
	env.users.users["u-inviter"] = &model.User{
		ID: "u-inviter", Email: "admin@example.com", DisplayName: "Ada Admin",
		SystemRole: model.SystemRoleAdmin, AuthProvider: model.AuthProviderOIDC,
	}
	return env, mailer
}

// The invitation is actually delivered now — the dialog's "Invitation sent"
// used to be a claim nothing backed.
func TestCreateInvite_SendsEmail(t *testing.T) {
	env, mailer := setupInviteMail(t)

	inv, err := env.svc.CreateInvite(context.Background(), "u-inviter", "New.Guest@Example.com", nil)
	if err != nil {
		t.Fatalf("CreateInvite = %v", err)
	}
	if len(mailer.sent) != 1 {
		t.Fatalf("emails sent = %d, want 1", len(mailer.sent))
	}
	msg := mailer.last()
	if msg.To != "new.guest@example.com" {
		t.Errorf("email To = %q, want the normalized address", msg.To)
	}
	wantLink := "https://ex.example.com/invite/" + inv.Token
	if !strings.Contains(msg.Text, wantLink) {
		t.Errorf("invite email is missing the accept link %q: %q", wantLink, msg.Text)
	}
	if !strings.Contains(msg.HTML, wantLink) {
		t.Errorf("invite email HTML is missing the accept link: %q", msg.HTML)
	}
	if !strings.Contains(msg.Text, "Ada Admin") {
		t.Errorf("invite email should name the inviter: %q", msg.Text)
	}
}

// Mail is optional: with no SMTP configured the invite is still created and
// its link still returned for the inviter to copy.
func TestCreateInvite_NoMailerStillCreatesInvite(t *testing.T) {
	env := setupAuthService()

	inv, err := env.svc.CreateInvite(context.Background(), "u-inviter", "guest@example.com", nil)
	if err != nil {
		t.Fatalf("CreateInvite = %v", err)
	}
	if inv.Token == "" {
		t.Error("no invite token minted")
	}
}

// A mail failure must not fail the invite — the link is already usable.
func TestCreateInvite_MailFailureIsNotFatal(t *testing.T) {
	env, mailer := setupInviteMail(t)
	mailer.err = errors.New("relay refused")

	if _, err := env.svc.CreateInvite(context.Background(), "u-inviter", "guest@example.com", nil); err != nil {
		t.Fatalf("a mail failure must not fail invite creation: %v", err)
	}
}

// An unresolvable inviter yields a nameless invitation rather than blocking it.
func TestCreateInvite_UnknownInviterSendsGenericEmail(t *testing.T) {
	env, mailer := setupInviteMail(t)

	if _, err := env.svc.CreateInvite(context.Background(), "ghost", "guest@example.com", nil); err != nil {
		t.Fatalf("CreateInvite = %v", err)
	}
	msg := mailer.last()
	if !strings.Contains(msg.Text, "You have been invited") {
		t.Errorf("expected the generic invitation wording: %q", msg.Text)
	}
}

func TestCreateInvite_InviterLookupFailureSendsGenericEmail(t *testing.T) {
	env, mailer := setupInviteMail(t)
	env.users.getUserErr = errors.New("dynamo down")

	if _, err := env.svc.CreateInvite(context.Background(), "u-inviter", "guest@example.com", nil); err != nil {
		t.Fatalf("CreateInvite = %v", err)
	}
	if len(mailer.sent) != 1 {
		t.Fatalf("emails sent = %d, want 1 even when the inviter lookup fails", len(mailer.sent))
	}
}
