package msgraph

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// graphServer serves Graph requests with handler, after a token server.
func graphServer(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	tokenSrv, _ := newTokenServer(t, 3600)
	api := httptest.NewServer(handler)
	t.Cleanup(api.Close)
	c := newClient(t, tokenSrv.URL, api.URL)
	c.wait = func(context.Context, time.Duration) error { return nil }
	return c
}

func writeJSONBody(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func TestGroupKind(t *testing.T) {
	cases := map[string][]string{
		"dynamic":  {"Unified", "DynamicMembership"},
		"m365":     {"Unified"},
		"security": nil,
	}
	for want, types := range cases {
		if got := (Group{GroupTypes: types}).Kind(); got != want {
			t.Errorf("Kind(%v) = %q, want %q", types, got, want)
		}
	}
}

func TestSearchGroups(t *testing.T) {
	c := graphServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/groups" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if got := r.Header.Get("ConsistencyLevel"); got != "eventual" {
			t.Errorf("ConsistencyLevel = %q, want eventual", got)
		}
		q := r.URL.Query()
		if got := q.Get("$search"); got != `"displayName:on call"` {
			t.Errorf("$search = %q (quotes and backslashes must be stripped)", got)
		}
		if q.Get("$count") != "true" || q.Get("$top") != "20" || !strings.Contains(q.Get("$select"), "groupTypes") {
			t.Errorf("query = %v", q)
		}
		writeJSONBody(w, map[string]any{"value": []Group{{ID: "g-1", DisplayName: "On call", GroupTypes: []string{"Unified"}}}})
	})
	groups, err := c.SearchGroups(context.Background(), ` on "call\ `)
	if err != nil || len(groups) != 1 || groups[0].ID != "g-1" {
		t.Fatalf("SearchGroups = %+v, %v", groups, err)
	}
}

func TestSearchGroupsError(t *testing.T) {
	c := graphServer(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusForbidden) })
	if _, err := c.SearchGroups(context.Background(), "x"); err == nil {
		t.Fatal("SearchGroups swallowed a 403")
	}
}

func TestGetGroup(t *testing.T) {
	c := graphServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/groups/g-1":
			writeJSONBody(w, Group{ID: "g-1", DisplayName: "On call"})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	g, err := c.GetGroup(context.Background(), "g-1")
	if err != nil || g.DisplayName != "On call" {
		t.Fatalf("GetGroup = %+v, %v", g, err)
	}
	if _, err := c.GetGroup(context.Background(), "gone"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetGroup(gone) = %v, want ErrNotFound", err)
	}
}

// membersPage answers a transitiveMembers page; next is the following
// page's path ("" for the last).
func membersPage(w http.ResponseWriter, baseURL, next string, members ...[2]string) {
	value := make([]map[string]string, len(members))
	for i, m := range members {
		value[i] = map[string]string{"@odata.type": m[0], "id": m[1]}
	}
	body := map[string]any{"value": value}
	if next != "" {
		body["@odata.nextLink"] = baseURL + next
	}
	writeJSONBody(w, body)
}

func TestGroupUserIDsPagesAndKeepsUsers(t *testing.T) {
	var base string
	c := graphServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/groups/g-1/transitiveMembers" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if r.Header.Get("ConsistencyLevel") != "" {
			t.Error("member reads must not use the eventually consistent index")
		}
		if r.URL.Query().Get("$skiptoken") == "" {
			if q := r.URL.Query(); q.Get("$select") != "id" || q.Get("$top") != "999" {
				t.Errorf("query = %v", q)
			}
			membersPage(w, base, "/groups/g-1/transitiveMembers?$skiptoken=2",
				[2]string{"#microsoft.graph.user", "u-1"},
				[2]string{"#microsoft.graph.group", "nested"},
				[2]string{"#microsoft.graph.device", "d-1"})
			return
		}
		membersPage(w, base, "", [2]string{"#microsoft.graph.user", "u-2"}, [2]string{"#microsoft.graph.user", ""})
	})
	base = c.baseURL
	ids, over, err := c.GroupUserIDs(context.Background(), "g-1", 10)
	if err != nil || over || !slices.Equal(ids, []string{"u-1", "u-2"}) {
		t.Fatalf("GroupUserIDs = %v, %v, %v", ids, over, err)
	}
}

func TestGroupUserIDsStopsPastTheLimit(t *testing.T) {
	var pages atomic.Int64
	var base string
	c := graphServer(t, func(w http.ResponseWriter, _ *http.Request) {
		pages.Add(1)
		membersPage(w, base, "/groups/g-1/transitiveMembers?$skiptoken=2",
			[2]string{"#microsoft.graph.user", "u-1"}, [2]string{"#microsoft.graph.user", "u-2"})
	})
	base = c.baseURL
	ids, over, err := c.GroupUserIDs(context.Background(), "g-1", 1)
	if err != nil || !over || ids != nil {
		t.Fatalf("GroupUserIDs = %v, %v, %v; want over the limit", ids, over, err)
	}
	if pages.Load() != 1 {
		t.Fatalf("read %d pages, want to stop after the first", pages.Load())
	}
}

func TestGroupUserIDsErrors(t *testing.T) {
	gone := graphServer(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) })
	if _, _, err := gone.GroupUserIDs(context.Background(), "g", 10); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing group = %v, want ErrNotFound", err)
	}
	foreign := graphServer(t, func(w http.ResponseWriter, _ *http.Request) {
		writeJSONBody(w, map[string]any{"value": []any{}, "@odata.nextLink": "https://evil.example/next"})
	})
	if _, _, err := foreign.GroupUserIDs(context.Background(), "g", 10); err == nil || !strings.Contains(err.Error(), "outside") {
		t.Fatalf("foreign next link = %v, want refused", err)
	}
}

func TestThrottledCallsRetryAsAsked(t *testing.T) {
	var calls atomic.Int64
	c := graphServer(t, func(w http.ResponseWriter, _ *http.Request) {
		switch calls.Add(1) {
		case 1:
			w.Header().Set("Retry-After", "7")
			w.WriteHeader(http.StatusTooManyRequests)
		case 2:
			w.WriteHeader(http.StatusServiceUnavailable)
		default:
			writeJSONBody(w, Group{ID: "g-1"})
		}
	})
	var waits []time.Duration
	c.wait = func(_ context.Context, d time.Duration) error { waits = append(waits, d); return nil }
	if _, err := c.GetGroup(context.Background(), "g-1"); err != nil {
		t.Fatalf("GetGroup after throttling = %v", err)
	}
	if !slices.Equal(waits, []time.Duration{7 * time.Second, defaultRetryAfter}) {
		t.Fatalf("waits = %v", waits)
	}
}

func TestThrottledCallsGiveUp(t *testing.T) {
	var calls atomic.Int64
	c := graphServer(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusTooManyRequests)
	})
	if _, err := c.GetGroup(context.Background(), "g-1"); err == nil || !strings.Contains(err.Error(), "throttled") {
		t.Fatalf("GetGroup = %v, want the throttling error", err)
	}
	if calls.Load() != throttleAttempts {
		t.Fatalf("calls = %d, want %d", calls.Load(), throttleAttempts)
	}

	c.wait = func(context.Context, time.Duration) error { return context.Canceled }
	if _, err := c.GetGroup(context.Background(), "g-1"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled wait = %v", err)
	}
}

func TestRetryDelay(t *testing.T) {
	for header, want := range map[string]time.Duration{
		"":      defaultRetryAfter,
		"nope":  defaultRetryAfter,
		"0":     defaultRetryAfter,
		"3":     3 * time.Second,
		"99999": maxRetryAfter,
	} {
		res := &http.Response{Header: http.Header{"Retry-After": []string{header}}}
		if got := retryDelay(res); got != want {
			t.Errorf("retryDelay(%q) = %v, want %v", header, got, want)
		}
	}
}

func TestWaitCtx(t *testing.T) {
	if err := waitCtx(context.Background(), time.Millisecond); err != nil {
		t.Fatalf("waitCtx = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := waitCtx(ctx, time.Hour); !errors.Is(err, context.Canceled) {
		t.Fatalf("waitCtx(cancelled) = %v", err)
	}
}

