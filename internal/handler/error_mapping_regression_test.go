package handler

import (
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// errAWSOutage is what the AWS SDK hands back when DynamoDB itself fails.
var errAWSOutage = errors.New("operation error DynamoDB: GetItem, https response error StatusCode: 500, RequestID: R1, api error InternalServerError: Internal server error")

// Archiving a channel during a DynamoDB outage is the server's failure: a
// generic, logged 500. It used to answer 403 archive_error carrying the AWS
// error text — telling an owner they may not archive their own channel, and
// handing them the SDK's internals.
func TestArchive_StoreOutageIsAGeneric500(t *testing.T) {
	env := setupChannelHandlerFull(t)
	env.channels.channels["ch-1"] = &model.Channel{ID: "ch-1", Name: "one", Slug: "one", Type: model.ChannelTypePublic}
	env.memberships.memberships["ch-1#u-owner"] = &model.ChannelMembership{ChannelID: "ch-1", UserID: "u-owner", Role: model.ChannelRoleOwner}
	env.channels.getErr = errAWSOutage

	rec := serveAs(env, "u-owner", env.handler.Archive, http.MethodPost, "/api/v1/channels/ch-1/archive", ``, map[string]string{"id": "ch-1"})
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body = %s", rec.Code, rec.Body.String())
	}
	if body := rec.Body.String(); strings.Contains(body, "DynamoDB") || strings.Contains(body, "RequestID") {
		t.Fatalf("the AWS error text reached the client: %s", body)
	}
}

// A refusal the service types keeps its status and its readable reason: the
// general channel can't be archived (403, with the why).
func TestArchive_GeneralIsARefusalWithItsReason(t *testing.T) {
	env := setupChannelHandlerFull(t)
	general := store.DeriveID("channel:general")
	rec := serveAs(env, "u-owner", env.handler.Archive, http.MethodPost, "/api/v1/channels/"+general+"/archive", ``, map[string]string{"id": general})
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "cannot archive the general channel") {
		t.Fatalf("status = %d body = %s, want 403 with the reason", rec.Code, rec.Body.String())
	}
}

// Opening a thread whose root does not exist is a 404 — the thread handlers
// mapped every error to 403, so a deleted-and-purged root read as "no access".
func TestGetThread_MissingRootIs404(t *testing.T) {
	env := setupChannelHandlerFull(t)
	env.memberships.memberships["ch-1#u-1"] = &model.ChannelMembership{ChannelID: "ch-1", UserID: "u-1", Role: model.ChannelRoleMember}

	rec := serveAs(env, "u-1", env.handler.GetThread, http.MethodGet, "/api/v1/channels/ch-1/messages/gone/thread", ``,
		map[string]string{"id": "ch-1", "msgId": "gone"})
	if rec.Code != http.StatusNotFound || errorCode(t, rec) != "not_found" {
		t.Fatalf("status = %d body = %s, want 404 not_found", rec.Code, rec.Body.String())
	}

	// A non-member still gets the 403: the access check runs first.
	rec = serveAs(env, "u-stranger", env.handler.GetThread, http.MethodGet, "/api/v1/channels/ch-1/messages/gone/thread", ``,
		map[string]string{"id": "ch-1", "msgId": "gone"})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("non-member status = %d, want 403", rec.Code)
	}
}
