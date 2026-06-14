package handler

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
)

// TestChannelHandlerFull_BrowsePublic_ListError covers the BrowsePublic
// non-search error arm: the public-channel scan fails → 500.
func TestChannelHandlerFull_BrowsePublic_ListError(t *testing.T) {
	env := setupChannelHandlerFull(t)
	env.channels.listPublicErr = errors.New("dynamo down")
	user := &model.User{ID: "u-bp-err", Email: "bp@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.BrowsePublic))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels/browse", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d, want 500; body=%s", rec.Code, rec.Body.String())
	}
}

// --- conversation.go: GetOrCreateDM error arms -----------------------------

// createConvReq POSTs a Create body as the given user.
func createConvReq(t *testing.T, env *convHandlerEnv, userID, body string) *httptest.ResponseRecorder {
	t.Helper()
	user := &model.User{ID: userID, Email: userID + "@test.com", SystemRole: model.SystemRoleMember}
	token := makeTokenForUser(env.jwtMgr, user)
	handler := middleware.Auth(env.jwtMgr)(http.HandlerFunc(env.handler.Create))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/conversations", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

// TestConversationHandler_Create_SelfDMError drives the DM-type self-DM
// GetOrCreateDM error arm: a non-NotFound store error surfaces as 400 dm_error.
func TestConversationHandler_Create_SelfDMError(t *testing.T) {
	env := setupConversationHandlerFull(t)
	env.convs.getErr = errors.New("dynamo down")
	rec := createConvReq(t, env, "u-sdm", `{"type":"dm","participantIDs":["u-sdm"]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}

// TestConversationHandler_Create_GroupSelfDMError drives the group-type
// self-only GetOrCreateDM error arm.
func TestConversationHandler_Create_GroupSelfDMError(t *testing.T) {
	env := setupConversationHandlerFull(t)
	env.convs.getErr = errors.New("dynamo down")
	rec := createConvReq(t, env, "u-gsdm", `{"type":"group","participantIDs":["u-gsdm"]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}

// TestConversationHandler_Create_GroupSingleOtherDMError drives the group-type
// single-other-collapses-to-DM GetOrCreateDM error arm.
func TestConversationHandler_Create_GroupSingleOtherDMError(t *testing.T) {
	env := setupConversationHandlerFull(t)
	env.convs.getErr = errors.New("dynamo down")
	rec := createConvReq(t, env, "u-gso", `{"type":"group","participantIDs":["u-other"]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}
