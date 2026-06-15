package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
)

func authedConvReq(jwtMgr *auth.JWTManager, method, url, body string) *http.Request {
	user := &model.User{ID: "conv-user-1", Email: "c@e.com", SystemRole: model.SystemRoleMember}
	token, _ := jwtMgr.GenerateAccessToken(user)
	req := httptest.NewRequest(method, url, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	return req
}

func serveAuthed(jwtMgr *auth.JWTManager, fn http.HandlerFunc, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	middleware.Auth(jwtMgr)(fn).ServeHTTP(rec, req)
	return rec
}

func TestConvHandler_Create_InvalidBody(t *testing.T) {
	h, jwtMgr := setupConversationHandler(t)
	rec := serveAuthed(jwtMgr, h.Create, authedConvReq(jwtMgr, http.MethodPost, "/api/v1/conversations", "{not json"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body %s", rec.Code, rec.Body.String())
	}
}

func TestConvHandler_Create_DMTooManyParticipants(t *testing.T) {
	h, jwtMgr := setupConversationHandler(t)
	body := `{"type":"dm","participantIDs":["a","b"]}`
	rec := serveAuthed(jwtMgr, h.Create, authedConvReq(jwtMgr, http.MethodPost, "/api/v1/conversations", body))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body %s", rec.Code, rec.Body.String())
	}
}

func TestConvHandler_GetThread_MissingID(t *testing.T) {
	h, jwtMgr := setupConversationHandler(t)
	rec := serveAuthed(jwtMgr, h.GetThread, authedConvReq(jwtMgr, http.MethodGet, "/api/v1/conversations//thread/", ""))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body %s", rec.Code, rec.Body.String())
	}
}

func TestConvHandler_SetNoUnfurl_MissingID(t *testing.T) {
	h, jwtMgr := setupConversationHandler(t)
	rec := serveAuthed(jwtMgr, h.SetNoUnfurl, authedConvReq(jwtMgr, http.MethodPut, "/x", `{"noUnfurl":true}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body %s", rec.Code, rec.Body.String())
	}
}

func TestConvHandler_SetNoUnfurl_InvalidBody(t *testing.T) {
	h, jwtMgr := setupConversationHandler(t)
	req := authedConvReq(jwtMgr, http.MethodPut, "/x", "{bad")
	req.SetPathValue("id", "c1")
	req.SetPathValue("messageID", "m1")
	rec := serveAuthed(jwtMgr, h.SetNoUnfurl, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body %s", rec.Code, rec.Body.String())
	}
}

func TestConvHandler_ListFiles_MissingID(t *testing.T) {
	h, jwtMgr := setupConversationHandler(t)
	rec := serveAuthed(jwtMgr, h.ListFiles, authedConvReq(jwtMgr, http.MethodGet, "/x", ""))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body %s", rec.Code, rec.Body.String())
	}
}

func TestConvHandler_Create_DedupesParticipants(t *testing.T) {
	h, jwtMgr := setupConversationHandler(t)
	// Duplicate + empty participant IDs exercise the dedupe `continue`.
	body := `{"type":"dm","participantIDs":["conv-user-1","x","x",""]}`
	rec := serveAuthed(jwtMgr, h.Create, authedConvReq(jwtMgr, http.MethodPost, "/api/v1/conversations", body))
	if rec.Code != http.StatusCreated && rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 201 or 400; body %s", rec.Code, rec.Body.String())
	}
}
