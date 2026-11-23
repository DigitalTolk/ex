package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

type stubPeopleRanking struct {
	ids      []string
	err      error
	gotUser  string
	gotLimit int
}

func (s *stubPeopleRanking) FrequentPeople(_ context.Context, userID string, limit int) ([]string, error) {
	s.gotUser, s.gotLimit = userID, limit
	return s.ids, s.err
}

func TestUserHandler_ListFrequentPeople(t *testing.T) {
	setup := func() (*UserHandler, *stubPeopleRanking, *auth.JWTManager) {
		people := &stubPeopleRanking{}
		svc := service.NewUserService(newMockUserStore(), nil, nil, nil)
		svc.SetPeopleRanking(people)
		return NewUserHandler(svc, nil), people, auth.NewJWTManager("people-test-secret", 15*time.Minute, 720*time.Hour)
	}
	get := func(t *testing.T, h *UserHandler, jwtMgr *auth.JWTManager, url string) *httptest.ResponseRecorder {
		t.Helper()
		u := &model.User{ID: "u1", SystemRole: model.SystemRoleMember}
		req := httptest.NewRequest(http.MethodGet, url, nil)
		req.Header.Set("Authorization", "Bearer "+tokenFor(t, jwtMgr, u))
		rec := httptest.NewRecorder()
		middleware.Auth(jwtMgr)(http.HandlerFunc(h.ListFrequentPeople)).ServeHTTP(rec, req)
		return rec
	}

	t.Run("unauthorized without claims", func(t *testing.T) {
		h, _, _ := setup()
		rec := httptest.NewRecorder()
		h.ListFrequentPeople(rec, httptest.NewRequest(http.MethodGet, "/api/v1/users/me/frequent-people", nil))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status=%d, want 401", rec.Code)
		}
	})

	t.Run("returns the caller's ranking, honouring limit", func(t *testing.T) {
		h, people, jwtMgr := setup()
		people.ids = []string{"u-2", "u-3"}
		rec := get(t, h, jwtMgr, "/api/v1/users/me/frequent-people?limit=2")
		if rec.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		var got []string
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || !slices.Equal(got, people.ids) {
			t.Fatalf("got %v (%v)", got, err)
		}
		if people.gotUser != "u1" || people.gotLimit != 2 {
			t.Fatalf("asked for %q limit %d", people.gotUser, people.gotLimit)
		}
	})

	t.Run("a missing or bad limit asks for the whole cap", func(t *testing.T) {
		h, people, jwtMgr := setup()
		people.ids = []string{}
		for _, url := range []string{"/api/v1/users/me/frequent-people", "/api/v1/users/me/frequent-people?limit=abc"} {
			if rec := get(t, h, jwtMgr, url); rec.Code != http.StatusOK || people.gotLimit != service.MaxFrequentPeople {
				t.Fatalf("%s: status=%d limit=%d", url, rec.Code, people.gotLimit)
			}
		}
	})

	t.Run("surfaces a store error as 500", func(t *testing.T) {
		h, people, jwtMgr := setup()
		people.err = errors.New("redis down")
		if rec := get(t, h, jwtMgr, "/api/v1/users/me/frequent-people"); rec.Code != http.StatusInternalServerError {
			t.Fatalf("status=%d, want 500", rec.Code)
		}
	})
}
